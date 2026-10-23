// A tiny MCP server over stdio for tests: tools "echo" and "fail".
const rl = require('readline').createInterface({ input: process.stdin });
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
console.log('a log line on stdout that is not JSON'); // servers do this; clients must cope
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id == null) return;
  if (m.method === 'initialize') return out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1' } } });
  if (m.method === 'tools/list') return out({ jsonrpc: '2.0', id: m.id, result: { tools: [
    { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    { name: 'fail', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
  ] } });
  if (m.method === 'tools/call') {
    if (m.params.name === 'fail') return out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'it broke' }], isError: true } });
    return out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `echo: ${m.params.arguments.text}` }] } });
  }
  out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown method' } });
});
