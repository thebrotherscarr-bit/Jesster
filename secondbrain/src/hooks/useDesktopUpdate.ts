import { useEffect, useState } from 'react';
import '../types/desktop.ts';

export interface DesktopUpdate {
  available: boolean;
  current?: number;
  commit?: string;
  latest?: number;
  title?: string;
  updating: boolean;
  error?: string;
  apply: () => Promise<void>;
}

const CHECK_MS = 30 * 60 * 1000;
const SEEN_KEY = 'secondbrain_seen_build';

/**
 * In the packaged .exe: is a newer build published on GitHub? `onUpdated`
 * fires once on the first launch after an update.
 */
export function useDesktopUpdate(onUpdated: (text: string) => void): DesktopUpdate | null {
  const bridge = typeof window !== 'undefined' ? window.secondbrainDesktop : undefined;
  const [state, setState] = useState<Omit<DesktopUpdate, 'apply'>>({ available: false, updating: false });

  useEffect(() => {
    if (!bridge) return;
    let stop = false;
    const check = async () => {
      try {
        const r = await bridge.checkUpdate();
        if (stop) return;
        setState((s) => ({
          ...s,
          available: r.available && r.canApply,
          current: r.current.build,
          commit: r.current.commit,
          latest: r.latest?.build,
          title: r.latest?.title,
          error: undefined,
        }));
        try {
          const seen = Number(localStorage.getItem(SEEN_KEY) || 0);
          if (seen && r.current.build > seen) onUpdated(`Updated to build ${r.current.build} (${r.current.commit}).`);
          localStorage.setItem(SEEN_KEY, String(r.current.build));
        } catch {
          /* no banner without storage */
        }
      } catch {
        /* offline or GitHub unreachable: try again later */
      }
    };
    check();
    const t = window.setInterval(check, CHECK_MS);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge]);

  if (!bridge) return null;
  return {
    ...state,
    apply: async () => {
      setState((s) => ({ ...s, updating: true, error: undefined }));
      try {
        onUpdated('Downloading the update… the app closes and reopens by itself when it is ready.');
        const r = await bridge.applyUpdate();
        if (!r.updated) {
          setState((s) => ({ ...s, updating: false, error: r.detail }));
          onUpdated(`Update not applied: ${r.detail}`);
        }
        // on success the app closes and reopens on the new build
      } catch (e) {
        const msg = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': /, '') : String(e);
        setState((s) => ({ ...s, updating: false, error: msg }));
        onUpdated(`Update failed: ${msg}. Details: %TEMP%\\secondbrain-update.log`);
      }
    },
  };
}
