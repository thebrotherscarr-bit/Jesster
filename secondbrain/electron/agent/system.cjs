/**
 * Steward's system, as SecondBrain sees it (Kyle, 2026-11-02: "i want the steward button to have all of his
 * info ... what steward uses can be a tab under his button"). Every piece he runs on, each checked by its port,
 * and what he is given to work with: the tools SecondBrain's MCP serves him, his skills and his workspace.
 *
 * Nothing here reads Steward's .env (RULE 7): the model he runs is what Ollama reports as loaded.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

/** The pieces, by the ports their owners declare (steward.cjs, atlasglass.cjs, main.cjs). */
function pieces({ stewardPort, stewardMcpPort, appPort, doorPort, glassPort, ollamaPort = 11434 }) {
  return [
    { id: 'steward', label: "Steward's service", port: stewardPort, what: "hosted.py: his MAF workflow on MAF's Responses host; the Agent tab talks to it" },
    { id: 'steward-mcp', label: "Steward's MCP", port: stewardMcpPort, what: 'mcp_app.py: Steward as one MCP tool, for Manjuel and other clients' },
    { id: 'secondbrain-mcp', label: "SecondBrain's MCP", port: appPort, what: "notes, web, skills and the door's tools at /mcp; Steward's connection to SecondBrain" },
    { id: 'door', label: 'The door', port: doorPort, what: "Atlas's door, served by SecondBrain; a client's writes wait as cards" },
    { id: 'glass', label: 'The Atlas glass', port: glassPort, what: 'the PWA' },
    { id: 'ollama', label: 'Ollama', port: ollamaPort, what: 'the local models Steward runs on' },
  ];
}

/** The models Ollama has loaded now (GET /api/ps); [] when it does not answer. */
function loadedModels(port = 11434, timeout = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ps', timeout }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve((JSON.parse(body).models || []).map((m) => m.name || m.model).filter(Boolean));
        } catch {
          resolve([]);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve([]));
  });
}

/**
 * Each piece, up or down; `ready` when the two Steward needs to work in the Agent tab answer: his service and the
 * door. `answering(port)` is atlasglass.answering.
 */
async function status({ answering, ports, models = () => loadedModels(ports.ollamaPort) }) {
  const list = await Promise.all(pieces(ports).map(async (p) => ({ ...p, up: Boolean(await answering(p.port)) })));
  const up = (id) => list.find((p) => p.id === id)?.up;
  return { ready: Boolean(up('steward') && up('door')), pieces: list, models: await models() };
}

/** The folders under his skills directory (harness/steward/skills), each a file skill he can load. */
function fileSkills(stewardDir) {
  if (!stewardDir) return [];
  const dir = path.join(stewardDir, 'harness', 'steward', 'skills');
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
}

/**
 * What he works with: the tools SecondBrain's MCP lists for him (as tools/list answers his connection), the skill
 * notes it serves, his file skills and his workspace. `mcp(method)` answers one /mcp request in-process.
 */
async function uses({ mcp, stewardDir, shareOn }) {
  const tools = ((await mcp('tools/list'))?.result?.tools || []).map((t) => t.name);
  const notes = ((await mcp('resources/list'))?.result?.resources || []).map((r) => r.name).filter((n) => n !== 'skills index');
  return { shareOn: Boolean(shareOn), tools, skillNotes: notes, fileSkills: fileSkills(stewardDir), workspace: stewardDir || '' };
}

module.exports = { pieces, status, uses, loadedModels, fileSkills };
