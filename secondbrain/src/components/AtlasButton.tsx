import React, { useState } from 'react';
import { Globe, RefreshCw } from 'lucide-react';
import '../types/desktop.ts';

/**
 * Open Atlas, from the Agent tab: launches the Atlas web app in its own window, starting
 * Atlas first when it is not running (electron/atlasglass.cjs). Kyle's word, 2026-10-22:
 * "I click the agent tab ... It opens the Atlas web app. And then I do everything in there."
 */
export const AtlasButton: React.FC<{ className?: string }> = ({ className = '' }) => {
  const open = window.secondbrainDesktop?.atlas?.open;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) return null;
  return (
    <div className={className}>
      <button
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const r = await open();
            if (r.error) setError(r.error);
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
        disabled={busy}
        title="Open Atlas: your development environment (the Atlas web app)"
        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-sky-800 bg-sky-950/60 hover:bg-sky-900 text-xs font-semibold text-sky-200 hover:text-white transition-colors disabled:opacity-60"
      >
        {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Globe className="w-3.5 h-3.5" />}
        {busy ? 'Starting Atlas…' : 'Open Atlas'}
      </button>
      {error && <p className="mt-1.5 text-[11px] text-amber-300 whitespace-pre-wrap">{error}</p>}
    </div>
  );
};
