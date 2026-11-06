/**
 * The Agent tab over AG-UI, the default transport since 2026-11-05 (Steward's ADR-0003): Settings' agent.transport is
 * 'ag-ui' unless the operator chooses Responses (steward.cjs, 43120), which stays as the fallback.
 *
 * Steward serves his workflow over AG-UI on 127.0.0.1:43122 (worlds\steward, step 4's ag_ui_app.py, MAF's
 * agent_framework_ag_ui as it ships: Learn, "Workflows with AG-UI"). This is its client, in the main process, on the
 * AG-UI JS client's HttpAgent (@ag-ui/client 0.0.59, pinned: the last line before the 1.0 protocol, which is the one
 * MAF's ag-ui-protocol 0.1.x speaks, interrupts and resume included). Its events become today's Agent-tab events:
 *
 *   TEXT_MESSAGE_* (the workflow's output) and REASONING_* (ANSWER's and EXECUTE's streamed words) -> his words
 *   ('delta', and the turn's 'answer');
 *   TOOL_CALL_* -> tool lines ('tool' when a call's arguments are complete, 'result' with what it returned);
 *   RUN_FINISHED with an interrupt outcome -> the same cards as today (the `approve` the Agent tab, the Approvals
 *   shelf and Telegram share), each answered by a new run on the same thread with resume [{interruptId, status:
 *   'resolved', payload: {approved}}] and forwardedProps.checkpointId (the interrupt's checkpoint);
 *   RUN_ERROR -> said plainly; a card whose checkpoint is gone (his host was restarted: checkpoints are in memory)
 *   says so;
 *   STEP_STARTED / STEP_FINISHED (one pair per workflow executor, `stepName` its id: route, explore, plan, read_plan,
 *   ask_approval, execute, check, repair, commit, report, answer) -> 'workflow_step' events, { name, state: 'started'
 *   | 'finished' }, for the step line (AG-UI step 3, Steward's ExecPlan 0003). MAF also wraps each superstep of the
 *   graph in its own pair ('superstep:<n>'); those are the engine's rounds, not his steps, and are not passed on. A
 *   card's step finishes before RUN_FINISHED (the AG-UI client refuses a run that ends with a step open) and runs
 *   again on the resume, taking the answer: after a No it is reported { state: 'failed' } when it finishes. A step
 *   still open when the run errors is reported failed too. ('step' is the local loop's step counter, so these have
 *   their own type.)
 *
 * The thread is the conversation's id; the history is the session's own messages, sent with each new request (AG-UI's
 * client owns the history), so it is recorded the same way as the Responses path's.
 */
const { HttpAgent } = require('@ag-ui/client');

const PORT = 43122;
const SCRIPT = ['harness', 'steward', 'step04_production_ready', 'ag_ui_app.py'];
const MAX_ROUNDS = 20; // card round-trips in one turn, as steward.cjs
// MAF's codes for a resume whose checkpoint or interrupt is not there (agent_framework_ag_ui _workflow.py)
const GONE = ['WORKFLOW_CHECKPOINT_LOAD_FAILED', 'WORKFLOW_RESUME_NOT_FOUND'];
const RESTARTED = "Steward's AG-UI host no longer holds this card (it keeps cards in memory, so it was restarted while the card waited). Nothing of it ran; send the request again.";

function parseArgs(a) {
  if (a && typeof a === 'object') return a;
  try {
    return JSON.parse(a || '{}');
  } catch {
    return { arguments: String(a) };
  }
}

/** The session's messages as AG-UI messages: what was said, not tool calls or Claude's checks. */
function history(messages) {
  return (messages || [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content && !m.content.startsWith("**Claude's check**"))
    .map((m, i) => ({ id: `m${i}`, role: m.role, content: m.content }));
}

/**
 * One run: the events go to the handlers below as they stream. Resolves { interrupts, error } from RUN_FINISHED /
 * RUN_ERROR; rejects when the host does not answer.
 */
async function run(agent, params, on, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal) {
    if (signal.aborted) abort();
    signal.addEventListener('abort', abort, { once: true });
  }
  let outcome = null;
  let error = null;
  try {
    await agent.runAgent({ ...params, abortController: controller }, {
      onEvent: ({ event }) => on(event),
      onRunFinishedEvent: ({ event }) => {
        outcome = event.outcome || null;
      },
      onRunErrorEvent: ({ event }) => {
        error = event;
      },
    });
  } catch (e) {
    if (signal?.aborted) {
      const err = new Error('stopped');
      err.name = 'AbortError';
      throw err;
    }
    // a RUN_ERROR also ends the client's run with an error: the event says more than the throw
    if (!error) {
      const down = /fetch failed|ECONNREFUSED/.test(`${e.message} ${e.cause?.code || ''}`);
      throw new Error(down ? `Steward's AG-UI host did not answer (${e.cause?.code || e.message}).` : `Steward's AG-UI run failed: ${e.message || e}`);
    }
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  return { interrupts: outcome && outcome.type === 'interrupt' ? outcome.interrupts || [] : [], error };
}

/**
 * One user turn over AG-UI. `url` is the host's endpoint; `threadId` the conversation; `messages` the history before
 * this turn and `text` the new message; `approve(name, args, summary)` resolves true/false per card; `metadata` rides
 * as forwardedProps. Resolves { answer, calls } as steward.cjs turn() does (calls: { name, arguments, call_id, result }).
 * `Agent` is the client class (HttpAgent; a test may hand another).
 */
async function turn({ url, threadId, messages = [], text, approve, metadata, onEvent = () => {}, signal, Agent = HttpAgent }) {
  const calls = [];
  const pieces = []; // his words, one per streamed message
  const open = new Map(); // toolCallId -> { name, args }
  let piece = null;
  const steps = []; // the workflow steps open now, in the order they started
  let lastStep = null; // the step started last: the one whose card is answered
  const denied = new Set(); // steps whose card was answered No: they fail when they finish on the resume
  const step = (name, state) => onEvent({ type: 'workflow_step', name, state });
  const ours = (name) => typeof name === 'string' && name && !name.startsWith('superstep:');
  const say = (delta) => {
    if (!delta) return;
    if (piece === null) {
      if (pieces.length) onEvent({ type: 'delta', text: '\n\n' });
      piece = pieces.push('') - 1;
    }
    pieces[piece] += delta;
    onEvent({ type: 'delta', text: delta });
  };
  const on = (e) => {
    switch (e.type) {
      case 'STEP_STARTED':
        if (!ours(e.stepName)) break;
        steps.push(e.stepName);
        lastStep = e.stepName;
        step(e.stepName, 'started');
        break;
      case 'STEP_FINISHED': {
        if (!ours(e.stepName)) break;
        const at = steps.lastIndexOf(e.stepName);
        if (at >= 0) steps.splice(at, 1);
        step(e.stepName, denied.delete(e.stepName) ? 'failed' : 'finished');
        break;
      }
      case 'TEXT_MESSAGE_START':
      case 'REASONING_MESSAGE_START':
      case 'TEXT_MESSAGE_END':
      case 'REASONING_MESSAGE_END':
        piece = null;
        break;
      case 'TEXT_MESSAGE_CONTENT':
      case 'REASONING_MESSAGE_CONTENT':
      case 'TEXT_MESSAGE_CHUNK':
      case 'REASONING_MESSAGE_CHUNK':
        say(e.delta);
        break;
      case 'TOOL_CALL_START':
        open.set(e.toolCallId, { name: e.toolCallName, args: '' });
        break;
      case 'TOOL_CALL_ARGS': {
        const c = open.get(e.toolCallId);
        if (c) c.args += e.delta || '';
        break;
      }
      case 'TOOL_CALL_END': {
        const c = open.get(e.toolCallId);
        if (!c || c.name === 'request_info') break; // the card's own call: it comes as the interrupt
        const args = parseArgs(c.args);
        calls.push({ name: c.name, arguments: args, call_id: e.toolCallId });
        onEvent({ type: 'tool', name: c.name, args });
        piece = null;
        break;
      }
      case 'TOOL_CALL_RESULT': {
        const call = calls.find((c) => c.call_id === e.toolCallId);
        if (!call) break;
        call.result = String(e.content ?? '');
        onEvent({ type: 'result', name: call.name, text: call.result.slice(0, 2000) });
        break;
      }
      default:
    }
  };
  const props = metadata ? { ...metadata } : {};
  const agentFor = (initialMessages) => new Agent({ url, threadId, initialMessages });
  let r = await run(agentFor([...history(messages), { id: `m${messages.length}`, role: 'user', content: text }]), { forwardedProps: props }, on, signal);
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    if (r.error) {
      for (const name of steps.splice(0).reverse()) step(name, 'failed'); // the run ended inside them
      throw new Error(round > 1 && GONE.includes(r.error.code) ? RESTARTED : `Steward: ${r.error.message || 'the run failed'}`);
    }
    if (!r.interrupts.length) {
      const answer = pieces.join('\n\n');
      onEvent({ type: 'answer', text: answer });
      return { answer, calls };
    }
    const resume = [];
    let checkpointId = null;
    for (const i of r.interrupts) {
      const af = (i.metadata && i.metadata.agent_framework) || {};
      const fc = af.function_call || {};
      const name = fc.name || 'request_info';
      const args = parseArgs(fc.arguments);
      const allow = await approve(name, args, `${name} ${JSON.stringify(args, null, 2)}`);
      resume.push({ interruptId: i.id, status: 'resolved', payload: { approved: Boolean(allow) } });
      if (!allow && lastStep) denied.add(lastStep);
      checkpointId = af.checkpoint_id || checkpointId;
    }
    if (signal?.aborted) {
      const err = new Error('stopped');
      err.name = 'AbortError';
      throw err;
    }
    // the answer is a new run on the same thread, from the card's checkpoint (as ag_ui_app.py's test sends it)
    r = await run(agentFor([]), { resume, forwardedProps: { ...props, ...(checkpointId ? { checkpointId } : {}) } }, on, signal);
  }
  throw new Error(`Steward was still asking for approvals after ${MAX_ROUNDS} rounds; the turn was stopped.`);
}

module.exports = { turn, history, PORT, SCRIPT, RESTARTED };
