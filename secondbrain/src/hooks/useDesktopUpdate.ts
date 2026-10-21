import { useEffect, useState } from 'react';
import '../types/desktop.ts';

export interface DesktopUpdate {
  available: boolean;
  current?: number;
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
        const r = await bridge.applyUpdate();
        if (!r.updated) setState((s) => ({ ...s, updating: false, error: r.detail }));
        // on success the app closes and reopens on the new build
      } catch (e) {
        setState((s) => ({ ...s, updating: false, error: e instanceof Error ? e.message : String(e) }));
      }
    },
  };
}
