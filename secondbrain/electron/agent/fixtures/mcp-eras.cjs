// A tiny MCP server over stdio for the client's era tests (mcp.cjs negotiate). ERA_MODE:
//   modern  (default) 2026-07-28 only: server/discover, every request must carry the _meta envelope,
//           initialize is refused; tools/call "echo" answers with the version its _meta carried
//   silent  2025-06-18 only, and silent to a method it does not know (some servers are)
//   future  speaks only a version the client does not: -32022 to everything
const rl = require('readline').createInterface({ input: process.stdin });
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const mode = process.env.ERA_MODE || 'modern';
const V = 'io.modelcontextprotocol/protocolVersion';
const err = (id, code, message, data) => out({ jsonrpc: '2.0', id, error: data ? { code, message, data } : { code, message } });
const tools = [{ name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }];
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id == null) return;
  const meta = (m.params && m.params._meta) || {};
  if (mode === 'future') return err(m.id, -32022, 'Unsupported protocol version', { supported: ['2099-01-01'], requested: meta[V] || null });
  if (mode === 'silent') {
    if (m.method === 'initialize') return out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'silent', version: '1' } } });
    if (m.method === 'tools/list') return out({ jsonrpc: '2.0', id: m.id, result: { tools } });
    if (m.method === 'tools/call') return out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `legacy: ${m.params.arguments.text} meta=${V in meta}` }] } });
    return; // silence
  }
  if (m.method === 'initialize') return err(m.id, -32601, 'initialize is not a method here; this server speaks 2026-07-28');
  if (meta[V] !== '2026-07-28' || !meta['io.modelcontextprotocol/clientCapabilities']) return err(m.id, -32602, `no 2026-07-28 envelope on ${m.method}`);
  const done = (result) => out({ jsonrpc: '2.0', id: m.id, result: { resultType: 'complete', ...result } });
  if (m.method === 'server/discover') return done({ supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'modern', version: '1' } } });
  if (m.method === 'tools/list') return done({ tools, ttlMs: 0, cacheScope: 'private' });
  if (m.method === 'tools/call') return done({ content: [{ type: 'text', text: `modern: ${m.params.arguments.text} at ${meta[V]} from ${(meta['io.modelcontextprotocol/clientInfo'] || {}).name}` }] });
  err(m.id, -32601, `unknown method ${m.method}`);
});
