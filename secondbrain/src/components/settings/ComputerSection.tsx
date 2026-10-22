import React, { useEffect, useState } from 'react';
import { MousePointerClick } from 'lucide-react';

type ComputerCfg = {
  enabled?: boolean;
  askEachAction?: boolean;
  model?: string;
};

/** Computer use: a vision model sees the screen and works the mouse and keyboard. */
export const ComputerSection: React.FC = () => {
  const desk = window.secondbrainDesktop;
  const settings = desk?.settings;
  const [cfg, setCfg] = useState<ComputerCfg>({});
  const [models, setModels] = useState<string[] | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);

  useEffect(() => {
    settings?.get().then((s) => setCfg((s.computer || {}) as ComputerCfg));
    desk?.computer
      ?.models()
      .then(setModels)
      .catch(() => setModelError('Ollama did not answer, so the models it has are not listed.'));
  }, [settings, desk]);

  if (!settings || !desk?.computer) return null;

  const save = (patch: ComputerCfg) => {
    setCfg((c) => ({ ...c, ...patch }));
    settings.set('computer', { ...patch });
  };
  const model = cfg.model || 'qwen3-vl:8b';
  const choices = models && !models.includes(model) ? [model, ...models] : models || [model];

  return (
    <section className="px-5 py-4 border-b border-neutral-900 space-y-3" aria-label="Computer use">
      <div className="flex items-center gap-2 text-white text-sm font-medium">
        <MousePointerClick className="w-4 h-4 text-rose-400" /> Computer use
      </div>
      <p className="text-xs text-neutral-400">
        Lets the agent hand a task to a vision model that sees your main screen and uses the mouse and keyboard. Starting
        a task always asks you. While it runs, SecondBrain steps aside and a small panel shows each action, with a red ring
        where a click will land: Allow, Deny or Stop. <b className="text-neutral-200">Ctrl+Alt+Q</b> stops it at once.
        Scheduled automations can never use it.
      </p>
      <label className="flex items-center gap-2 text-xs text-neutral-200">
        <input type="checkbox" checked={Boolean(cfg.enabled)} aria-label="Allow computer use" onChange={(e) => save({ enabled: e.target.checked })} />
        Let the agent ask to use this computer
      </label>
      <label className="flex items-center gap-2 text-xs text-neutral-300">
        <input
          type="checkbox"
          checked={cfg.askEachAction !== false}
          disabled={!cfg.enabled}
          aria-label="Ask before each computer action"
          onChange={(e) => save({ askEachAction: e.target.checked })}
        />
        Ask me before each click, typing or key press
      </label>
      <label className="flex items-center gap-2 text-xs text-neutral-400">
        Vision model
        <select
          value={model}
          aria-label="Vision model"
          onChange={(e) => save({ model: e.target.value })}
          className="flex-1 rounded-lg bg-neutral-900 border border-neutral-800 px-2 py-1 text-xs text-white"
        >
          {choices.map((m) => (
            <option key={m} value={m}>
              {m}
              {models && !models.includes(m) ? ' (not in Ollama)' : ''}
            </option>
          ))}
        </select>
      </label>
      {modelError && <p className="text-xs text-amber-300">{modelError}</p>}
      {models && models.length === 0 && <p className="text-xs text-amber-300">Ollama has no model that can see. Try: ollama pull qwen3-vl:8b</p>}
    </section>
  );
};
