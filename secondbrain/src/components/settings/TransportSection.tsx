import React, { useEffect, useState } from 'react';
import { Radio } from 'lucide-react';

/** How the Agent tab talks to Steward: his service (Responses), or his workflow over AG-UI (agent.transport). */
export const TransportSection: React.FC = () => {
  const settings = window.secondbrainDesktop?.settings;
  const [agui, setAgui] = useState(false);

  useEffect(() => {
    // AG-UI unless Responses was chosen here (electron/settings.cjs stewardTransport)
    settings?.get().then((s) => setAgui(!((s.agent || {}).transport === 'responses' && (s.agent || {}).transportChosen)));
  }, [settings]);

  if (!settings) return null;

  return (
    <section className="px-5 py-4 border-b border-neutral-900 space-y-3" aria-label="AG-UI">
      <div className="flex items-center gap-2 text-white text-sm font-medium">
        <Radio className="w-4 h-4 text-violet-400" /> AG-UI
      </div>
      <p className="text-xs text-neutral-400">
        The Agent tab talks to Steward's workflow over AG-UI (his host on port 43122, started and kept up while this is
        on) instead of his service. His words, tool lines and cards are the same. Off: his service, as before.
      </p>
      <label className="flex items-center gap-2 text-xs text-neutral-200">
        <input
          type="checkbox"
          checked={agui}
          aria-label="Talk to Steward over AG-UI"
          onChange={(e) => {
            setAgui(e.target.checked);
            settings.set('agent', { transport: e.target.checked ? 'ag-ui' : 'responses', transportChosen: true });
          }}
        />
        Talk to Steward over AG-UI
      </label>
    </section>
  );
};
