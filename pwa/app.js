// Jesster Notes — the PWA. Talks to the notes kernel over /rpc (JSON-RPC 2.0).
// Offline: notes are mirrored in IndexedDB, and saves made without the kernel
// wait in an outbox, sent in order when it answers again. A queued edit
// carries the hash it was made from, so it is refused rather than allowed to
// overwrite a change that happened somewhere else meanwhile.
"use strict";

const $ = (id) => document.getElementById(id);
const state = { notes: [], tag: null, current: null, online: false, token: null };

// ---------------------------------------------------------------- storage --
function safeLocal(fn, fallback) { try { return fn(); } catch { return fallback; } }
state.token = safeLocal(() => localStorage.getItem("jn.token"), null);

const db = {
  _p: null,
  open() {
    if (this._p) return this._p;
    this._p = new Promise((res) => {
      let req;
      try { req = indexedDB.open("jesster-notes", 1); } catch { return res(null); }
      req.onupgradeneeded = () => {
        req.result.createObjectStore("notes", { keyPath: "id" });
        req.result.createObjectStore("outbox", { autoIncrement: true });
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => res(null);              // private window: run without it
    });
    return this._p;
  },
  async tx(store, mode, fn) {
    const d = await this.open();
    if (!d) return undefined;
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => res(out && "result" in out ? out.result : undefined);
      t.onerror = () => rej(t.error);
    });
  },
  all: (s) => db.tx(s, "readonly", (o) => o.getAll()).then((r) => r || []),
  get: (s, k) => db.tx(s, "readonly", (o) => o.get(k)),
  put: (s, v) => db.tx(s, "readwrite", (o) => o.put(v)),
  del: (s, k) => db.tx(s, "readwrite", (o) => o.delete(k)),
  keys: (s) => db.tx(s, "readonly", (o) => o.getAllKeys()).then((r) => r || []),
};

// -------------------------------------------------------------------- rpc --
let seq = 0;
async function rpc(method, params = {}) {
  const headers = { "Content-Type": "application/json" };
  if (state.token) headers.Authorization = "Bearer " + state.token;
  const r = await fetch("rpc", { method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }) });
  if (r.status === 401) {
    const t = prompt("This vault needs its access token:");
    if (t) { state.token = t; safeLocal(() => localStorage.setItem("jn.token", t)); return rpc(method, params); }
    throw new Error("token required");
  }
  const msg = await r.json();
  if (msg.error) { const e = new Error(msg.error.message); e.reason = msg.error.data?.reason; throw e; }
  return msg.result;
}

function setStatus(online, text) {
  state.online = online;
  const s = $("status");
  s.textContent = text || (online ? "kernel" : "offline");
  s.className = "pill " + (online ? "ok" : "warn");
}

// -------------------------------------------------------------- markdown --
function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "note"; }
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g, (_, t) => `<a data-note="${esc(slug(t))}">${t}</a>`)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}
function markdown(src) {
  const out = []; let list = null; let code = null; let para = [];
  const flush = () => { if (para.length) { out.push("<p>" + inline(para.join(" ")) + "</p>"); para = []; } };
  const endList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of src.split("\n")) {
    if (code !== null) {
      if (line.startsWith("```")) { out.push("<pre><code>" + esc(code.join("\n")) + "</code></pre>"); code = null; }
      else code.push(line);
      continue;
    }
    if (line.startsWith("```")) { flush(); endList(); code = []; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)/);
    const li = line.match(/^\s*([-*]|\d+\.)\s+(.*)/);
    if (h) { flush(); endList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); }
    else if (li) {
      flush();
      const kind = /\d/.test(li[1]) ? "ol" : "ul";
      if (list !== kind) { endList(); out.push(`<${kind}>`); list = kind; }
      out.push("<li>" + inline(li[2]) + "</li>");
    } else if (!line.trim()) { flush(); endList(); }
    else if (line.startsWith("> ")) { flush(); endList(); out.push("<blockquote>" + inline(line.slice(2)) + "</blockquote>"); }
    else para.push(line);
  }
  if (code !== null) out.push("<pre><code>" + esc(code.join("\n")) + "</code></pre>");
  flush(); endList();
  return out.join("\n");
}

// ------------------------------------------------------------------ list --
function excerpt(n) { return n.excerpt ?? (n.body || "").trim().slice(0, 160); }

async function loadList() {
  try {
    const rows = await rpc("notes.list", { limit: 1000 });
    setStatus(true);
    state.notes = rows;
  } catch {
    setStatus(false);
    state.notes = (await db.all("notes")).sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
  }
  renderList();
}

function renderList() {
  const q = $("q").value.trim().toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  const tags = {};
  state.notes.forEach((n) => (n.tags || []).forEach((t) => (tags[t] = (tags[t] || 0) + 1)));
  $("tags").replaceChildren(...Object.keys(tags).sort().map((t) => {
    const b = document.createElement("button");
    b.textContent = "#" + t; b.className = state.tag === t ? "on" : "";
    b.onclick = () => { state.tag = state.tag === t ? null : t; renderList(); };
    return b;
  }));
  const rows = state.notes.filter((n) => {
    if (state.tag && !(n.tags || []).includes(state.tag)) return false;
    const hay = (n.title + " " + (n.tags || []).join(" ") + " " + excerpt(n)).toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  $("list").replaceChildren(...rows.map((n) => {
    const li = document.createElement("li");
    li.className = state.current?.id === n.id ? "on" : "";
    li.innerHTML = `<div class="t">${esc(n.title)}</div><div class="x">${esc(excerpt(n))}</div>`;
    li.onclick = () => openNote(n.id);
    return li;
  }));
}

// server-side search once the query is real, so bodies beyond the excerpt count
let searchTimer;
$("q").addEventListener("input", () => {
  renderList();
  clearTimeout(searchTimer);
  const q = $("q").value.trim();
  if (!q || !state.online) return;
  searchTimer = setTimeout(async () => {
    try {
      const hits = await rpc("notes.search", { q, tag: state.tag || undefined });
      $("list").replaceChildren(...hits.map((n) => {
        const li = document.createElement("li");
        li.innerHTML = `<div class="t">${esc(n.title)}</div><div class="x">${esc(n.excerpt)}</div>`;
        li.onclick = () => openNote(n.id);
        return li;
      }));
    } catch { /* keep the local filter */ }
  }, 250);
});

// ---------------------------------------------------------------- editor --
async function openNote(id) {
  let n;
  try { n = await rpc("notes.get", { id }); await db.put("notes", n); }
  catch (e) {
    if (e.reason === "not_found") { alert("No note " + id); return; }
    n = await db.get("notes", id);
    if (!n) { alert("That note is not available offline."); return; }
  }
  show(n);
  $("side").classList.remove("open");
}

function show(n) {
  state.current = n;
  $("empty").hidden = true;
  $("editor").hidden = false;
  $("title").value = n.title || "";
  $("tagsin").value = (n.tags || []).join(", ");
  $("body").value = n.body || "";
  $("saved").textContent = n.pending ? "waiting to sync" : (n.updated ? "saved " + n.updated.slice(0, 16).replace("T", " ") : "new");
  $("del").hidden = !n.hash;
  $("history").hidden = !n.hash;
  setMode(n.hash ? "preview" : "edit");
  const back = (n.backlinks || []).map((b) => `<a data-note="${esc(b)}">${esc(b)}</a>`).join(", ");
  $("meta").innerHTML = (back ? "Linked from: " + back : "") +
    (n.hash ? `<div>sha256 <code>${esc(n.hash.slice(0, 16))}…</code> <a id="check">check against the chain</a></div>` : "");
  const c = $("check");
  if (c) c.onclick = checkChain;
  renderList();
}

function setMode(m) {
  const preview = m === "preview";
  $("body").hidden = preview;
  $("preview").hidden = !preview;
  $("mode").textContent = preview ? "Edit" : "Preview";
  if (preview) $("preview").innerHTML = markdown($("body").value);
  else $("body").focus();
}
$("mode").onclick = () => setMode($("body").hidden ? "edit" : "preview");

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-note]");
  if (a) { e.preventDefault(); $("ask").close(); openNote(a.dataset.note); }
});

$("new").onclick = () => show({ title: "", tags: [], body: "" });
$("menu").onclick = () => $("side").classList.toggle("open");

$("editor").addEventListener("submit", async (e) => {
  e.preventDefault();
  const cur = state.current;
  const title = $("title").value.trim();
  if (!title) return;
  const tags = $("tagsin").value.split(",").map((t) => t.trim()).filter(Boolean);
  const body = $("body").value;
  const op = cur.hash || cur.pending
    ? { method: "notes.update", params: { id: cur.id, title, tags, body, base: cur.hash } }
    : { method: "notes.create", params: { id: slug(title) + "-" + Math.random().toString(16).slice(2, 6), title, tags, body } };
  if (!op.params.base) delete op.params.base;
  try {
    const r = await rpc(op.method, op.params);
    setStatus(true);
    await openNote(r.id);
  } catch (err) {
    if (err.reason === "conflict") { alert("This note changed elsewhere since you opened it. Copy your text, then reopen it."); return; }
    if (err.reason) { alert(err.message); return; }
    // offline: keep it locally and queue it
    setStatus(false);
    await db.put("outbox", op);
    const local = { ...cur, ...op.params, updated: new Date().toISOString(), pending: true };
    await db.put("notes", local);
    if (!state.notes.find((n) => n.id === local.id)) state.notes.unshift(local);
    show(local);
  }
  await loadList();
  refreshChain();
});

$("del").onclick = async () => {
  const cur = state.current;
  if (!cur?.hash || !confirm(`Move "${cur.title}" to the vault's trash?`)) return;
  try {
    await rpc("notes.remove", { id: cur.id });
    await db.del("notes", cur.id);
    state.current = null;
    $("editor").hidden = true; $("empty").hidden = false;
    await loadList();
    refreshChain();
  } catch (e) { alert(e.message); }
};

async function flushOutbox() {
  const keys = await db.keys("outbox");
  for (const k of keys) {
    const op = await db.get("outbox", k);
    try { await rpc(op.method, op.params); }
    catch (e) {
      if (!e.reason) return;                      // still offline: try later
      alert(`A queued save of "${op.params.title}" was refused: ${e.message}`);
    }
    await db.del("outbox", k);
  }
}

// ------------------------------------------------------------ provenance --
async function refreshChain() {
  const c = $("chain");
  try {
    const v = await rpc("provenance.verify");
    c.textContent = (v.intact ? "chain intact · " : "CHAIN BROKEN · ") + v.links + " links";
    c.className = "pill " + (v.intact ? "ok" : "bad");
    c.title = v.detail + "\nhead " + v.head;
  } catch { c.textContent = ""; }
}

async function checkChain() {
  try {
    const r = await rpc("provenance.check", { id: state.current.id });
    alert(r.detail);
  } catch (e) { alert(e.message); }
}

$("history").onclick = async () => {
  try {
    const rows = await rpc("provenance.history", { id: state.current.id });
    $("histbody").innerHTML = rows.length ? rows.map((r) =>
      `<div class="hrow"><strong>link ${r.n}</strong> · ${esc(r.ts)} · ${esc(r.actor)} · ${esc(r.mode)}<br>${esc(r.says)}<br><code>${esc(r.hash)}</code></div>`
    ).join("") : '<p class="muted">No deposits for this note.</p>';
    $("hist").showModal();
  } catch (e) { alert(e.message); }
};

// ------------------------------------------------------------------- ask --
$("ask-open").onclick = () => { $("ask").showModal(); $("askq").focus(); };
$("askgo").onclick = async () => {
  const q = $("askq").value.trim();
  if (!q) return;
  $("askstate").textContent = "thinking… (local model)";
  $("answer").textContent = "";
  try {
    const r = await rpc("llm.ask", { q });
    $("answer").innerHTML = esc(r.answer).replace(/\[([a-z0-9][a-z0-9-]*)\]/g, '[<a data-note="$1">$1</a>]') +
      (r.sources.length ? "\n\nSources: " + r.sources.map((s) => `<a data-note="${esc(s)}">${esc(s)}</a>`).join(", ") : "");
    $("askstate").textContent = "";
  } catch (e) { $("askstate").textContent = e.message; }
};

// ------------------------------------------------------------------ boot --
async function sync() {
  try {
    await fetch("health", { cache: "no-store" });
    setStatus(true);
    await flushOutbox();
    // mirror full notes for offline reading
    await loadList();
    for (const n of state.notes) {
      const have = await db.get("notes", n.id);
      if (!have || have.updated !== n.updated || have.pending) {
        try { await db.put("notes", await rpc("notes.get", { id: n.id })); } catch { /* next time */ }
      }
    }
    await refreshChain();
  } catch {
    setStatus(false);
    await loadList();
  }
}

window.addEventListener("online", sync);
window.addEventListener("offline", () => setStatus(false));
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
sync();
