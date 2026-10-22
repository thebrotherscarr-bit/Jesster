import React, { useEffect, useState } from 'react';
import { Plug, RefreshCw, Save } from 'lucide-react';
import { McpState } from '../../types/desktop.ts';

const EXAMPLE = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/Users/you/Documents"],
      "trusted": false
    }
  }
}`;

/** MCP servers whose tools the agent can use. */
export const McpSection: React.FC = () => {
  const bridge = window.secondbrainDesktop?.mcp;
  const [state, setState] = useState<McpState | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    bridge?.get().then((s) => {
      setState(s);
      setText(s.config);
    });
  }, [bridge]);

  if (!bridge) return null;

  const act = async (fn: () => Promise<McpState>) => {
    setBusy(true);
    setError(null);
    try {
      const s = await fn();
      setState(s);
      setText(s.config);
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '') : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="px-5 py-4 border-b border-neutral-900 space-y-3" aria-label="MCP servers">
      <div className="flex items-center gap-2 text-white text-sm font-medium">
        <Plug className="w-4 h-4 text-violet-400" /> MCP servers
      </div>
      <p className="text-xs text-neutral-400">
        Tool servers the agent can use, in the same format as Claude Code and Cursor (paste an <code>mcpServers</code>
        block). Each call to a server needs your OK unless you set <code>"trusted": true</code>. Saved in{' '}
        <code className="break-all">{state?.file}</code>.
      </p>
      {state?.status.length ? (
        <ul className="space-y-1 text-xs">
          {state.status.map((s) => (
            <li key={s.name} className="flex flex-wrap gap-x-2">
              <span className={s.status === 'connected' ? 'text-emerald-400' : 'text-amber-400'}>●</span>
              <span className="text-neutral-100">{s.name}</span>
              <span className="text-neutral-500">
                {s.status === 'connected' ? `${s.tools.length} tools${s.trusted ? ' · trusted' : ''}` : s.error || s.status}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        spellCheck={false}
        aria-label="MCP configuration"
        placeholder={EXAMPLE}
        className="w-full font-mono rounded-lg bg-neutral-900 border border-neutral-800 px-2.5 py-2 text-[11px] text-neutral-100"
      />
      <div className="flex gap-2">
        <button disabled={busy} onClick={() => act(() => bridge.save(text))} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-xs text-white disabled:opacity-50">
          <Save className="w-3.5 h-3.5" /> Save and connect
        </button>
        <button disabled={busy} onClick={() => act(() => bridge.reconnect())} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-neutral-700 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-50">
          <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} /> Reconnect
        </button>
        {!text.includes('mcpServers') && (
          <button onClick={() => setText(EXAMPLE)} className="px-3 py-1.5 rounded-lg text-xs text-neutral-400 hover:text-white">
            Insert example
          </button>
        )}
      </div>
      {error && <p role="alert" className="text-xs text-amber-400">{error}</p>}
    </section>
  );
};
