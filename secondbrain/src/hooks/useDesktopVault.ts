import { Dispatch, SetStateAction, useEffect, useRef, useState } from 'react';
import { Note } from '../types/index.ts';
import { HIDDEN_TAGS, SyncedState, isKernelId, planSync, signature } from '../utils/kernel.ts';
import '../types/desktop.ts';

export interface DesktopVault {
  dir: string;
  error?: string;
  reveal: () => void;
  choose: () => Promise<void>;
  importFiles: (files?: File[]) => Promise<void>;
}

// the editor saves on every keystroke; files are written after a pause
const SAVE_DELAY_MS = 800;
const MIGRATED_KEY = 'secondbrain_vault_migrated';

/**
 * In the desktop app, notes are Markdown files in a folder on disk. The
 * first time a folder is used, notes the app kept in its browser storage
 * are written into it (once per folder, never again).
 */
export function useDesktopVault(
  notes: Note[],
  setNotes: Dispatch<SetStateAction<Note[]>>,
  onRename: (from: string, to: string) => void,
  onMessage: (text: string) => void
): DesktopVault | null {
  const bridge = typeof window !== 'undefined' ? window.secondbrainDesktop?.vault : undefined;
  const [dir, setDir] = useState('');
  const [error, setError] = useState<string | undefined>();
  const synced = useRef(new Map<string, SyncedState>());
  const latest = useRef(notes);
  const ready = useRef(false);
  const busy = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  latest.current = notes;

  const adopt = (all: Note[]) => {
    // chats ingested by the notes kernel into a shared folder can number in
    // the thousands; like the browser version, the list leaves them out
    const loaded = all.filter((n) => !n.tags.some((t) => HIDDEN_TAGS.includes(t)));
    synced.current = new Map(loaded.map((n) => [n.id, { sig: signature(n), hash: '' }]));
    setNotes(loaded.sort((a, b) => b.updatedAt - a.updatedAt));
  };

  const open = async (migrate: boolean) => {
    if (!bridge) return;
    const info = await bridge.info();
    let loaded = await bridge.load();
    let done: string | null = null;
    try {
      done = localStorage.getItem(MIGRATED_KEY);
    } catch {
      /* no storage: nothing to migrate from either */
    }
    if (migrate && done !== info.dir && latest.current.length) {
      const have = new Set(loaded.map((n) => n.id));
      const moving = latest.current.filter((n) => !have.has(n.id));
      for (const n of moving) {
        const id = isKernelId(n.id) ? n.id : `${n.id.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '').slice(0, 50) || 'note'}-m`;
        await bridge.save({ ...n, id });
      }
      try {
        localStorage.setItem(MIGRATED_KEY, info.dir);
      } catch {
        /* migrate again next time; saving is idempotent */
      }
      if (moving.length) {
        onMessage(`Your ${moving.length} notes are now files in ${info.dir}.`);
        loaded = await bridge.load();
      }
    }
    setDir(info.dir);
    adopt(loaded);
    ready.current = true;
  };

  const flush = async () => {
    if (!bridge) return;
    if (busy.current) {
      schedule();
      return;
    }
    busy.current = true;
    try {
      for (const op of planSync(synced.current, latest.current)) {
        if (op.kind === 'remove') {
          await bridge.remove(op.id);
          synced.current.delete(op.id);
          continue;
        }
        let note = op.note;
        if (!isKernelId(note.id)) {
          const id = `${note.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'note'}-${Math.random().toString(16).slice(2, 8)}`;
          onRename(note.id, id);
          note = { ...note, id };
        }
        await bridge.save(note);
        synced.current.set(note.id, { sig: signature(op.note), hash: '' });
      }
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      schedule(5000);
    } finally {
      busy.current = false;
    }
  };

  const schedule = (ms = SAVE_DELAY_MS) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, ms);
  };

  useEffect(() => {
    if (!bridge) return;
    open(true).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    // files changed by another program (Explorer, an editor, the CLI, OpenCode)
    const off = bridge.onChanged(async () => {
      if (!ready.current || busy.current || planSync(synced.current, latest.current).length) return;
      const loaded = await bridge.load();
      const shown = loaded.filter((n) => !n.tags.some((t) => HIDDEN_TAGS.includes(t)));
      const same =
        shown.length === synced.current.size &&
        shown.every((n) => synced.current.get(n.id)?.sig === signature(n));
      if (!same) adopt(loaded);
    });
    return () => {
      off();
      window.clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge]);

  useEffect(() => {
    if (ready.current) schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes]);

  if (!bridge) return null;
  return {
    dir,
    error,
    reveal: () => {
      bridge.reveal();
    },
    choose: async () => {
      await flush();
      const r = await bridge.choose();
      if (r.changed) {
        ready.current = false;
        await open(false);
        onMessage(`Notes folder: ${r.dir}`);
      }
    },
    importFiles: async (files?: File[]) => {
      await flush();
      const paths = files?.map((f) => bridge.pathForFile(f)).filter(Boolean);
      const r = await bridge.importFiles(paths && paths.length ? paths : undefined);
      if (!r.imported.length && !r.skipped.length) return;
      adopt(await bridge.load());
      const parts = [];
      if (r.imported.length) parts.push(`Imported ${r.imported.length}: ${r.imported.map((i) => i.title).join(', ')}.`);
      if (r.skipped.length) parts.push(`Skipped ${r.skipped.length}: ${r.skipped.map((s) => `${s.file.split(/[\\/]/).pop()} (${s.why})`).join('; ')}.`);
      onMessage(parts.join(' '));
    },
  };
}
