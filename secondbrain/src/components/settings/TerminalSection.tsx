import React, { useEffect, useState } from 'react';
import { TerminalSquare } from 'lucide-react';

/** Terminal access for the agent: off unless switched on; every command is approved. */
export const TerminalSection: React.FC = () => {
  const settings = window.secondbrainDesktop?.settings;
  const [enabled, setEnabled] = useState(false);
  const [shell, setShell] = useState('');

  useEffect(() => {
    settings?.get().then((s) => {
      const t = s.terminal as { enabled: boolean; shell: string | null };
      setEnabled(Boolean(t.enabled));
      setShell(t.shell || '');
    });
  }, [settings]);

  if (!settings) return null;

  return (
    <section className="px-5 py-4 border-b border-neutral-900 space-y-3" aria-label="Terminal">
      <div className="flex items-center gap-2 text-white text-sm font-medium">
        <TerminalSquare className="w-4 h-4 text-amber-400" /> Terminal access
      </div>
      <p className="text-xs text-neutral-400">
        Lets the agent run commands on this PC. Every command is shown to you exactly and runs only after you click
        Allow (or tap it in Telegram). Commands that delete, format or change system settings are flagged. Scheduled
        automations can never use it. Each command is stopped after its time limit.
      </p>
      <label className="flex items-center gap-2 text-xs text-neutral-200">
        <input
          type="checkbox"
          checked={enabled}
          aria-label="Allow terminal access"
          onChange={(e) => {
            setEnabled(e.target.checked);
            settings.set('terminal', { enabled: e.target.checked });
          }}
        />
        Allow the agent to ask to run commands
      </label>
      <label className="flex items-center gap-2 text-xs text-neutral-400">
        Shell
        <input
          value={shell}
          onChange={(e) => setShell(e.target.value)}
          onBlur={() => settings.set('terminal', { shell: shell.trim() || null })}
          placeholder="default: PowerShell"
          className="flex-1 rounded-lg bg-neutral-900 border border-neutral-800 px-2.5 py-1 text-xs text-white"
        />
      </label>
    </section>
  );
};
