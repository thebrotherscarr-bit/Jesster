/**
 * MCP protocol versions, both eras, for SecondBrain's servers (atlas.cjs /mcp, door/listen.cjs /rpc)
 * and its client (agent/mcp.cjs). Spec 2026-07-28, basic/versioning "Backward Compatibility with
 * Initialization-Based Versions": a dual-era server answers `initialize` with legacy semantics and
 * serves a request carrying `_meta["io.modelcontextprotocol/protocolVersion"]` statelessly.
 *
 *   modern  2026-07-28: no handshake, no session; version and client capabilities ride every
 *           request's _meta; server/discover is required; every result carries resultType; list
 *           and read results carry ttlMs and cacheScope; ping and logging/setLevel are removed.
 *   legacy  2025-11-25 and earlier: initialize, then requests without the envelope.
 */
const MODERN = ['2026-07-28'];
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SUPPORTED = [...MODERN, ...LEGACY];
const LATEST = MODERN[0];
// what an initialize that names no version we know is answered with (our legacy servers were built to it)
const LEGACY_DEFAULT = '2025-06-18';

const META = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
};

// error codes the 2026-07-28 spec reserves (basic/index "Error codes")
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const INVALID_PARAMS = -32602;

// methods whose results are CacheableResult (server/utilities/caching)
const CACHEABLE = new Set(['tools/list', 'prompts/list', 'resources/list', 'resources/read', 'resources/templates/list', 'server/discover']);
// methods 2026-07-28 removed: a modern request for one is "method not found"
const REMOVED = new Set(['ping', 'logging/setLevel', 'resources/subscribe', 'resources/unsubscribe']);
// Mcp-Name's source field, per method (transports/streamable-http "Standard Request Headers")
const NAME_FIELD = { 'tools/call': 'name', 'prompts/get': 'name', 'resources/read': 'uri' };

/** The answer to an initialize: the client's version when we speak it, else our legacy one. */
function negotiateLegacy(requested) {
  return LEGACY.includes(requested) ? requested : LEGACY_DEFAULT;
}

/** `=?base64?...?=` decoded (streamable-http "Value Encoding"); anything else as it is. */
function decodeHeader(v) {
  if (typeof v !== 'string') return v;
  const m = /^=\?base64\?(.*)\?=$/.exec(v);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : v;
}

/**
 * Which era a request is in, and whether it may be served.
 *   { era: 'legacy' }                         initialize, or no envelope: served as before
 *   { era: 'modern', version, clientInfo }     served statelessly at 2026-07-28
 *   { era: 'modern', error: { code, message, data? } }   refused before dispatch
 * `headers` (lowercase names, as Node gives them) turns on the Streamable HTTP header rung; leave it
 * out on transports without headers (stdio, the door's newline /rpc).
 */
function classify(msg, headers) {
  const method = msg && msg.method;
  const params = (msg && msg.params) || {};
  const meta = params && typeof params === 'object' ? params._meta : undefined;
  if (method === 'initialize' || !meta || typeof meta !== 'object' || !(META.protocolVersion in meta)) return { era: 'legacy' };
  const refuse = (code, message, data) => ({ era: 'modern', error: data === undefined ? { code, message } : { code, message, data } });
  if (!(META.clientCapabilities in meta)) return refuse(INVALID_PARAMS, `params._meta is missing the required envelope key ${META.clientCapabilities}`);
  const version = meta[META.protocolVersion];
  if (headers) {
    if (headers['mcp-protocol-version'] !== version) return refuse(HEADER_MISMATCH, "Header mismatch: MCP-Protocol-Version does not match the request's _meta protocol version");
    if (headers['mcp-method'] !== method) return refuse(HEADER_MISMATCH, "Header mismatch: Mcp-Method does not match the request body's method");
    const field = NAME_FIELD[method];
    if (field && params[field] != null && decodeHeader(headers['mcp-name']) !== params[field]) {
      return refuse(HEADER_MISMATCH, `Header mismatch: Mcp-Name does not match the request body's ${field}`);
    }
  }
  if (typeof version !== 'string') return refuse(INVALID_PARAMS, 'the protocol-version envelope value must be a string');
  if (!MODERN.includes(version)) return refuse(UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', { supported: SUPPORTED, requested: version });
  return { era: 'modern', version, clientInfo: meta[META.clientInfo] };
}

/** The server/discover result. */
function discoverResult({ name, version = '1', capabilities, instructions }) {
  return { supportedVersions: SUPPORTED, capabilities, instructions, _meta: { [META.serverInfo]: { name, version } } };
}

/**
 * A response finished for a modern request: resultType on every result, the server's identity in
 * its _meta, and the cache hints on the cacheable ones. `ttlMs` 0 ("refetch"): every list here
 * changes with Settings (writes, the screen tools, the ground) and with who is asking.
 */
function finishModern(response, method, { name, version = '1', ttlMs = 0 } = {}) {
  if (!response || !response.result) return response;
  const result = { resultType: 'complete', ...response.result };
  result._meta = { ...(result._meta || {}), [META.serverInfo]: { name, version } };
  if (CACHEABLE.has(method)) {
    if (result.ttlMs === undefined) result.ttlMs = ttlMs;
    if (result.cacheScope === undefined) result.cacheScope = 'private';
  }
  return { ...response, result };
}

/**
 * The HTTP status a Streamable HTTP server returns a modern response with: 400 for a version or
 * header refusal, 404 for an unknown method (streamable-http "Protocol Version Header"), else 200.
 */
function httpStatus(response) {
  const code = response && response.error && response.error.code;
  if (code === UNSUPPORTED_PROTOCOL_VERSION || code === HEADER_MISMATCH) return 400;
  if (code === -32601) return 404;
  return 200;
}

/** The _meta envelope a modern client puts on every request. */
function requestMeta(clientInfo, clientCapabilities = {}, version = LATEST) {
  return { [META.protocolVersion]: version, [META.clientInfo]: clientInfo, [META.clientCapabilities]: clientCapabilities };
}

module.exports = {
  MODERN,
  LEGACY,
  SUPPORTED,
  LATEST,
  LEGACY_DEFAULT,
  META,
  HEADER_MISMATCH,
  UNSUPPORTED_PROTOCOL_VERSION,
  INVALID_PARAMS,
  REMOVED,
  NAME_FIELD,
  negotiateLegacy,
  decodeHeader,
  classify,
  discoverResult,
  finishModern,
  httpStatus,
  requestMeta,
};
