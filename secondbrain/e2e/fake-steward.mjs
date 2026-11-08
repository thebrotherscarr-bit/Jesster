/**
 * The Playwright suite's stand-in for Steward's MCP host (mcp_app.py on 43121) and for Ollama's /api/chat, on one
 * local port: no network, no model, no Python. It answers what SecondBrain's flows call (agent/workflows.cjs
 * stewardRecipes): run_recipe, recipe_status, recipe_runs and recipe_graph, as JSON-RPC tools/call with one text
 * content, the same form the real host answers in. Every call is kept in `calls`, so a test can see what reached it.
 *
 * A run is "running" for RUN_MS after run_recipe, then ends: a recipe that starts an eval fails with EVAL_FAILURE (its
 * reason, as the shelf must show it); any other recipe is done and ok. recipe_graph answers an error, so the shelf
 * draws the flow locally (its "offline" path), which keeps the canvas's block ids known (step-0, step-1, deliver-note).
 */
import http from 'node:http';

export const RUN_MS = 2500;
export const EVAL_FAILURE = 'bar not met: 3 of 10 cases passed';
export const CHAT_ANSWER = 'Hello from the e2e model.';
const CHAT_DELAY_MS = 1500;

export function fakeSteward() {
  const calls = [];
  const runs = new Map();
  let n = 0;
  const text = (id, value, isError = false) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) } });
  const status = (run) => {
    const recipe = run.recipe || {};
    const isEval = (recipe.steps || []).some((s) => (typeof s === 'string' ? s : s.step) === 'eval_start');
    const ended = Date.now() - run.started >= RUN_MS;
    const steps = (recipe.steps || []).map((s, i) => {
      const step = typeof s === 'string' ? s : s.step;
      const state = !ended ? (i === 0 ? 'running' : 'waiting') : isEval ? (i === 0 ? 'failed' : 'skipped') : 'done';
      return { id: `${i + 1}_${step}`, step, state, ms: ended ? 400 + i : null, ok: state === 'done', ...(state === 'failed' ? { error: EVAL_FAILURE } : {}) };
    });
    const base = { run_id: run.run_id, name: recipe.name, flow: run.flow, trigger: run.trigger, started: new Date(run.started).toISOString(), steps };
    if (!ended) return { ...base, state: 'running', ok: null };
    const at = new Date(run.started + RUN_MS).toISOString();
    if (isEval) return { ...base, state: 'failed', ok: false, error: EVAL_FAILURE, ended: at };
    return { ...base, state: 'done', ok: true, text: `${recipe.name}: all steps ran.`, short: 'all steps ran', ended: at };
  };
  const tool = (id, name, args) => {
    if (name === 'run_recipe') {
      const run = { run_id: `e2e-${++n}`, recipe: args.recipe, flow: args.flow || null, trigger: args.trigger || null, started: Date.now() };
      runs.set(run.run_id, run);
      return text(id, { run_id: run.run_id });
    }
    if (name === 'recipe_status') {
      const run = runs.get(args.run_id);
      return run ? text(id, status(run)) : text(id, `no run ${args.run_id}`, true);
    }
    if (name === 'recipe_runs') return text(id, [...runs.values()].filter((r) => r.flow === args.flow).reverse().map(status));
    if (name === 'recipe_graph') return text(id, 'the e2e host draws no graph', true);
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `no tool ${name}` } };
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let msg = {};
      try {
        msg = JSON.parse(body || '{}');
      } catch {
        /* answered below */
      }
      const reply = (code, value) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.method === 'POST' && req.url === '/mcp') {
        const p = msg.params || {};
        calls.push({ kind: 'mcp', method: msg.method, name: p.name, arguments: p.arguments });
        if (msg.method !== 'tools/call') return reply(200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'tools/call only' } });
        return reply(200, tool(msg.id, p.name, p.arguments || {}));
      }
      if (req.method === 'POST' && req.url === '/api/chat') {
        calls.push({ kind: 'chat', model: msg.model });
        return setTimeout(() => reply(200, { model: msg.model, message: { role: 'assistant', content: CHAT_ANSWER }, done: true }), CHAT_DELAY_MS);
      }
      // the renderer's own model reads (tags, ps): nothing is loaded here
      if (req.url === '/api/tags' || req.url === '/api/ps') return reply(200, { models: [] });
      return reply(404, { error: 'not here' });
    });
  });
  return {
    calls,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
