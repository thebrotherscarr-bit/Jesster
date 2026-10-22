import React, { useState } from 'react';
import { Globe, RefreshCw } from 'lucide-react';
import '../types/desktop.ts';

/**
 * Open Atlas, up top beside Agent and Graph: launches the Atlas web app in its own window,
 * starting Atlas first when it is not running (electron/atlasglass.cjs). Kyle's word,
 * 2026-10-22: "It should be up on top. Right there next to agent. Or graph. Open atlas."
 */
export const AtlasButton: React.FC = () => {
  const open = window.secondbrainDesktop?.atlas?.open;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) return null;
  return (
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
      title={error ? `Atlas did not open: ${error}` : 'Open Atlas: your development environment (the Atlas web app)'}
      className={`flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded-md transition-colors whitespace-nowrap shrink-0 hover:bg-neutral-900 disabled:opacity-60 ${
        error ? 'text-amber-300' : 'hover:text-neutral-200'
      }`}
    >
      {busy ? <RefreshCw className="w-3.5 h-3.5 text-sky-400 animate-spin" /> : <Globe className="w-3.5 h-3.5 text-sky-400" />}
      <span className="hidden md:inline">{busy ? 'Starting Atlas…' : 'Open Atlas'}</span>
    </button>
  );
};
