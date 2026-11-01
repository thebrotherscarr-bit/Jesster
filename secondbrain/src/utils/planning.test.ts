import test from 'node:test';
import assert from 'node:assert/strict';
import { planningOf } from './planning.ts';

test("Steward's plan is the PlanningResponse that ends his reply, preamble or not", () => {
  const plan = '{"type":"approval","questions":[{"message":"1. Write the file."}]}';
  assert.equal(planningOf(plan)?.questions[0].message, '1. Write the file.');
  assert.equal(planningOf(`We added the todo. Now present the plan.${plan}`)?.type, 'approval');
  assert.equal(planningOf('Here is my plan in plain words.'), null);
  assert.equal(planningOf('{"type":"approval","questions":[]}'), null, 'an approval with nothing in it is not a plan');
});
