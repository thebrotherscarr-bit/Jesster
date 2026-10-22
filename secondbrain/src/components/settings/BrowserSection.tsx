import React, { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';

/** Browser control: the agent's own visible browser window, off until switched on. */
export const BrowserSection: React.FC = () => {
  const settings = window.secondbrainDesktop?.settings;
  const [enabled, setEnabled] = useState(false);
  const [ask, setAsk] = useState(true);

  useEffect(() => {
    settings?.get().then((s) => {
      const b = (s.browser || {}) as { enabled?: boolean; askEachAction?: boolean };
      setEnabled(Boolean(b.enabled));
      setAsk(b.askEachAction !== false);
    });
  }, [settings]);

  if (!settings) return null;

  return (
    <section className="px-5 py-4 border-b border-neutral-900 space-y-3" aria-label="Browser">
      <div className="flex items-center gap-2 text-white text-sm font-medium">
        <Globe className="w-4 h-4 text-sky-400" /> Browser control
      </div>
      <p className="text-xs text-neutral-400">
        Gives the agent its own browser window, which you can watch and take over (log in by hand, then let it carry on).
        It has its own cookies and logins, separate from Chrome. Reading pages needs no OK; clicking, typing and key presses
        ask you first unless you switch that off. Downloads, pop-ups and camera/location requests are refused there.
      </p>
      <label className="flex items-center gap-2 text-xs text-neutral-200">
        <input
          type="checkbox"
          checked={enabled}
          aria-label="Allow browser control"
          onChange={(e) => {
            setEnabled(e.target.checked);
            settings.set('browser', { enabled: e.target.checked });
          }}
        />
        Let the agent use its browser window
      </label>
      <label className="flex items-center gap-2 text-xs text-neutral-300">
        <input
          type="checkbox"
          checked={ask}
          disabled={!enabled}
          aria-label="Ask before browser actions"
          onChange={(e) => {
            setAsk(e.target.checked);
            settings.set('browser', { askEachAction: e.target.checked });
          }}
        />
        Ask me before each click, typing or key press
      </label>
    </section>
  );
};
