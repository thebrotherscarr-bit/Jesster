import { Dispatch, SetStateAction, useEffect, useRef, useState } from 'react';
import { Note } from '../types/index.ts';
import {
  ChainStatus,
  KernelError,
  LiveCommand,
  LivePoll,
  VersionInfo,
  rpc,
  waitForKernel,
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
// how often the window checks for changes made elsewhere (CLI, agents, the bridge)
const POLL_MS = 3000;
const VERSION_MS = 10 * 60 * 1000;

export interface KernelSync {
  mode: StorageMode;
  error?: string;
  chain?: ChainStatus;
  version?: VersionInfo;
  updating?: boolean;
  update?: () => Promise<void>;
}

export function useKernelSync(
  notes: Note[],
  setNotes: Dispatch<SetStateAction<Note[]>>,
  onRename: (from: string, to: string) => void,
  onCommand: (cmd: LiveCommand) => void = () => undefined
): KernelSync {
  const [state, setState] = useState<KernelSync>({ mode: 'detecting' });
  const live = useRef({ seq: 0, boot: 0 });
  const ownWrites = useRef(new Set<string>());
  const commandHandler = useRef(onCommand);
  commandHandler.current = onCommand;
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
        ownWrites.current.add(op.kind === 'remove' ? op.id : r?.id || op.note.id);
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

  const checkVersion = async () => {
    try {
      const version = await rpc<VersionInfo>('system.version');
      setState((s) => ({ ...s, version }));
    } catch {
      /* not a git checkout, or offline: no update button */
    }
  };

  const update = async () => {
    setState((s) => ({ ...s, updating: true, error: undefined }));
    try {
      await flush();
      const r = await rpc<{ updated: boolean; restarting?: boolean; ui?: string }>('system.update');
      if (r.restarting && (await waitForKernel())) {
        window.location.reload();
        return;
      }
      await checkVersion();
      setState((s) => ({ ...s, updating: false }));
    } catch (e) {
      setState((s) => ({ ...s, updating: false, error: e instanceof Error ? e.message : String(e) }));
    }
  };

  // changes made elsewhere, and commands for this window
  useEffect(() => {
    if (state.mode !== 'kernel') return;
    let stop = false;
    let t: number | undefined;
    const tick = async () => {
      try {
        const p = await rpc<LivePoll>('live.poll', {
          since: live.current.seq,
          ...(live.current.boot ? { boot: live.current.boot } : {}),
        });
        const first = live.current.boot === 0;
        live.current = { seq: p.seq, boot: p.boot };
        // our own saves come back as changes too; only others' need a reload
        const foreign = p.changed.filter((id) => !ownWrites.current.has(id));
        ownWrites.current.clear();
        const pending = planSync(synced.current, latest.current).length > 0;
        if (!first && (p.reload || foreign.length) && !pending && !busy.current) {
          await reload();
        }
        if (!first) p.commands.forEach((c) => commandHandler.current(c));
        if (!first && foreign.length) refreshChain();
      } catch {
        /* the save path reports connection trouble */
      }
      if (!stop) t = window.setTimeout(tick, POLL_MS);
    };
    tick();
    checkVersion();
    const v = window.setInterval(checkVersion, VERSION_MS);
    return () => {
      stop = true;
      window.clearTimeout(t);
      window.clearInterval(v);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.mode]);

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

  return { ...state, update };
}
