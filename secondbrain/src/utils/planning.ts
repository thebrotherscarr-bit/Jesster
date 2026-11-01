/**
 * Steward's plan in a plan-mode reply: MAF's PlanningResponse, as the guide's console reads it.
 *
 * In plan mode Steward answers with a PlanningResponse (a clarification, or an approval holding the
 * plan). With tools offered, his model can write a short preamble before the JSON in the same reply
 * ("We added the todo. Now present the plan.{"type":"approval",...}"), so the plan is the JSON object
 * that ends the reply: the same rule as Steward's own hosted.planning_response_in.
 */
export interface Planning {
  type: 'clarification' | 'approval';
  questions: { message: string; choices?: string[] | null }[];
}

export const planningOf = (text: string): Planning | null => {
  for (let i = text.indexOf('{'); i !== -1; i = text.indexOf('{', i + 1)) {
    try {
      const p = JSON.parse(text.slice(i));
      if ((p?.type === 'clarification' || p?.type === 'approval') && Array.isArray(p.questions) && p.questions.length) return p;
    } catch {
      /* not JSON from here: try the next brace */
    }
  }
  return null;
};
