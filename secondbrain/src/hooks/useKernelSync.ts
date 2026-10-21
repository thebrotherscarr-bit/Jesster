import { Dispatch, SetStateAction, useEffect, useRef, useState } from 'react';
import { Note } from '../types/index.ts';
import {
  ChainStatus,
  KernelError,
  StorageMode,
  SyncedState,
  applyOp,
  chainStatus,
  detectKernel,
  fromKernel,
  loadVault,
  planSync,
  signature,
} from '../utils/kernel.ts';

// The editor saves on every keystroke. Each kernel save is a link on the
// chain, so writes wait for a pause in typing.
const SAVE_DELAY_MS = 1500;
const RETRY_MS = 5000;

export interface KernelSync {
  mode: StorageMode;
  error?: string;
  chain?: ChainStatus;
}

export function useKernelSync(
  notes: Note[],
  setNotes: Dispatch<SetStateAction<Note[]>>,
  onRename: (from: string, to: string) => void
): KernelSync {
  const [state, setState] = useState<KernelSync>({ mode: 'detecting' });
  const synced = useRef(new Map<string, SyncedState>());
  const latest = useRef(notes);
  const timer = useRef<number | undefined>(undefined);
  const busy = useRef(false);
  const ready = useRef(false);
  latest.current = notes;

  const adopt = (vault: Note[], hashes: Map<string, string>) => {
    synced.current = new Map(
      vault.map((n) => [n.id, { sig: signature(n), hash: hashes.get(n.id) || '' }])
    );
    setNotes(vault);
  };

  const reload = async () => {
    const raw = await loadVault();
    adopt(raw.map(fromKernel), new Map(raw.map((n) => [n.id, n.hash])));
  };

  const refreshChain = async () => {
    try {
      const chain = await chainStatus();
      setState((s) => ({ ...s, chain }));
    } catch {
      /* the badge just keeps its last reading */
    }
  };

  const flush = async () => {
    if (busy.current) {
      schedule(SAVE_DELAY_MS);
      return;
    }
    busy.current = true;
    try {
      for (const op of planSync(synced.current, latest.current)) {
        const r = await applyOp(op);
        if (op.kind === 'remove') {
          synced.current.delete(op.id);
          continue;
        }
        if (r && r.id !== op.note.id) onRename(op.note.id, r.id);
        synced.current.set(r ? r.id : op.note.id, { sig: signature(op.note), hash: r?.hash || '' });
      }
      setState((s) => ({ ...s, mode: 'kernel', error: undefined }));
      refreshChain();
    } catch (e) {
      const err = e instanceof KernelError ? e : new KernelError(String(e));
      if (err.reason === 'conflict') {
        // Changed elsewhere (CLI, another tab, an agent): the vault wins,
        // and the user is told rather than having either side overwritten.
        await reload().catch(() => undefined);
        setState((s) => ({ ...s, mode: 'kernel', error: 'A note changed outside this window; reloaded from the vault.' }));
      } else {
        setState((s) => ({ ...s, mode: 'error', error: err.message }));
        schedule(RETRY_MS);
      }
    } finally {
      busy.current = false;
    }
  };

  const schedule = (ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, ms);
  };

  useEffect(() => {
    let live = true;
    (async () => {
      if (!(await detectKernel())) {
        if (live) setState({ mode: 'local' });
        return;
      }
      try {
        await reload();
        if (!live) return;
        ready.current = true;
        setState({ mode: 'kernel' });
        refreshChain();
      } catch (e) {
        if (live) setState({ mode: 'error', error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      live = false;
      window.clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (ready.current) schedule(SAVE_DELAY_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes]);

  // last chance to write before the tab closes
  useEffect(() => {
    const onHide = () => {
      if (ready.current && document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}
