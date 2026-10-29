import React, { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';

/** Claude's check: Claude reviews each Steward turn in the Agent tab, on the Integrations key. */
export const CheckSection: React.FC = () => {
  const settings = window.secondbrainDesktop?.settings;
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    settings?.get().then((s) => setEnabled(Boolean((s.agent || {}).check)));
  }, [settings]);

  if (!settings) return null;

  return (
    <section className="px-5 py-4 border-b border-neutral-900 space-y-3" aria-label="Claude's check">
      <div className="flex items-center gap-2 text-white text-sm font-medium">
        <ShieldCheck className="w-4 h-4 text-violet-400" /> Claude's check
      </div>
      <p className="text-xs text-neutral-400">
        After each Steward turn in the Agent tab, Claude reads what he did — every tool call and what it returned — against
        his Charter, and says under his answer whether it holds up, what he claimed that nothing showed, and the next step.
        It uses the Claude key and model in Integrations; each check is one call on that key.
      </p>
      <label className="flex items-center gap-2 text-xs text-neutral-200">
        <input
          type="checkbox"
          checked={enabled}
          aria-label="Claude checks each Steward turn"
          onChange={(e) => {
            setEnabled(e.target.checked);
            settings.set('agent', { check: e.target.checked });
          }}
        />
        Claude checks each Steward turn
      </label>
    </section>
  );
};
