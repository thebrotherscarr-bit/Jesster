/**
 * Subagents: the agent hands a self-contained job to a fresh agent — its own
 * conversation, a step budget, optionally a narrower set of tools — and gets
 * the result back. Several jobs run side by side. A subagent cannot
 * delegate again, and inherits how risky tools are approved.
 */
const MAX_PARALLEL = 3;

function tools(getService) {
  return [
    {
      name: 'delegate',
      description:
        'Hand one or more self-contained jobs to subagents (fresh conversations with your tools) and get their results. Use for research or multi-part work that can be done independently. Give each task everything it needs; subagents do not see this conversation.',
      parameters: {
        type: 'object',
        properties: {
          tasks: { type: 'array', items: { type: 'string' }, description: `1 to ${MAX_PARALLEL} independent jobs` },
          tools: { type: 'array', items: { type: 'string' }, description: 'optional: limit subagents to these tool names' },
        },
        required: ['tasks'],
      },
      run: async ({ tasks, tools: only }, ctx) => {
        if (ctx.source === 'subagent') throw new Error('a subagent cannot delegate');
        const list = (Array.isArray(tasks) ? tasks : [tasks]).filter(Boolean).slice(0, MAX_PARALLEL);
        if (!list.length) throw new Error('no tasks');
        const service = getService();
        const allowed = (only && only.length ? only : service.registry.schemas().map((t) => t.function.name)).filter((n) => n !== 'delegate');
        const results = await Promise.all(
          list.map(async (task, i) => {
            const r = await service.ask({
              text: task,
              source: 'subagent',
              approve: ctx.approve,
              only: allowed,
              save: true,
              maxSteps: 8,
            });
            return `### Subagent ${i + 1}: ${task.slice(0, 80)}\n${r.answer}`;
          })
        );
        return results.join('\n\n');
      },
    },
  ];
}

module.exports = { tools, MAX_PARALLEL };
