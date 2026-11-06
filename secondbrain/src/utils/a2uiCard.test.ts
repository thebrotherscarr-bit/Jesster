import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { A2UI_CATALOG_ID, A2UI_COMPONENT_APIS, cardCatalog, planCardAnswer, processCard, surfaceIdOf } from './a2uiCard.ts';

// The A2UI pilot (Steward's ADR-0013, ExecPlan 0004 milestone 3). PLAN_CARD is what Steward's
// steward_workflow.plan_card_surface({"plan": "Document convert_length.", "steps": [...]}, "approve_plan-x") returns:
// A2UI v0.9 on the basic catalog, a Column of Texts and a Row of Approve and Deny Buttons carrying the card's id.
const ctx = { requestId: 'approve_plan-x' };
const PLAN_CARD = [
  { version: 'v0.9', createSurface: { surfaceId: 'plan-approve_plan-x', catalogId: 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json' } },
  {
    version: 'v0.9',
    updateComponents: {
      surfaceId: 'plan-approve_plan-x',
      components: [
        { id: 'root', component: 'Column', children: ['heading', 'plan', 'step-0', 'step-1', 'answers'] },
        { id: 'heading', component: 'Text', text: "Steward's plan", variant: 'h4' },
        { id: 'plan', component: 'Text', text: 'Document convert_length.' },
        { id: 'step-0', component: 'Text', text: '1. Add a docstring to convert_length' },
        { id: 'step-1', component: 'Text', text: '2. Run the tests' },
        { id: 'answers', component: 'Row', children: ['approve', 'deny'] },
        { id: 'approve-label', component: 'Text', text: 'Approve' },
        { id: 'deny-label', component: 'Text', text: 'Deny' },
        { id: 'approve', component: 'Button', child: 'approve-label', variant: 'primary', action: { event: { name: 'approve', context: ctx } } },
        { id: 'deny', component: 'Button', child: 'deny-label', action: { event: { name: 'deny', context: ctx } } },
      ],
    },
  },
];
const apis = cardCatalog([...A2UI_COMPONENT_APIS]);
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

test("Steward's plan card surface is drawable; a broken or foreign one is not, and today's card is drawn", () => {
  assert.equal(A2UI_CATALOG_ID, 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json', "the basic catalog Steward names");
  assert.equal(surfaceIdOf(PLAN_CARD), 'plan-approve_plan-x');
  const made = processCard(PLAN_CARD, apis, () => {});
  assert.ok(made && made.surfaceId === 'plan-approve_plan-x');
  const [, update] = PLAN_CARD as [unknown, { updateComponents: { components: { id: string }[] } }];
  const without = (id: string) => [PLAN_CARD[0], { version: 'v0.9', updateComponents: { surfaceId: 'plan-approve_plan-x', components: update.updateComponents.components.filter((c) => c.id !== id) } }];
  assert.equal(processCard(without('root'), apis, () => {}), null, 'no root');
  assert.equal(processCard([PLAN_CARD[0], { version: 'v0.9', updateComponents: { surfaceId: 'plan-approve_plan-x', components: [{ id: 'root', component: 'Slider', value: 1 }] } }], apis, () => {}), null, 'a component the app does not draw');
  assert.equal(processCard([{ version: 'v9', createSurface: { surfaceId: 's', catalogId: A2UI_CATALOG_ID } }], apis, () => {}), null, 'not v0.9');
  assert.equal(processCard(undefined, apis, () => {}), null, 'no surface');
  assert.equal(processCard([], apis, () => {}), null);
});

test("the card's Approve and Deny answer it, and only its own actions do", async () => {
  assert.equal(planCardAnswer({ name: 'approve', surfaceId: 's' }, 's'), true);
  assert.equal(planCardAnswer({ name: 'deny', surfaceId: 's' }, 's'), false);
  assert.equal(planCardAnswer({ name: 'approve', surfaceId: 'other' }, 's'), null, "another surface's action");
  assert.equal(planCardAnswer({ name: 'openUrl', surfaceId: 's' }, 's'), null);
  // through the processor, as a pressed Button dispatches it
  const actions: { name: string; surfaceId: string; context: Record<string, unknown> }[] = [];
  const made = processCard(PLAN_CARD, apis, (a) => void actions.push(a))!;
  const surface = made.processor.model.surfacesMap.get(made.surfaceId)!;
  await surface.dispatchAction({ event: { name: 'deny', context: ctx } }, 'deny');
  assert.equal(actions.length, 1);
  assert.equal(planCardAnswer(actions[0], made.surfaceId), false);
  assert.deepEqual(actions[0].context, ctx, "the card's id rides with it");
});

test("A2uiCard takes Steward's surface with the app's own components; anything else is today's card", async () => {
  // @a2ui/react defines its React host element at import (a custom element); the window has the DOM, a test has not:
  // the two names it needs at import, and nothing more, so the drawing below is React's own server render
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLElement ??= class {};
  g.customElements ??= { define() {}, get() {} };
  const { A2uiCard } = await import('../components/A2uiCard.tsx');
  // the app's catalog: the basic catalog's id and the four components the plan card uses, each the app's own
  const { CARD_CATALOG } = await import('../components/A2uiCard.tsx');
  assert.equal(CARD_CATALOG.id, A2UI_CATALOG_ID);
  assert.deepEqual([...CARD_CATALOG.components.keys()].sort(), ['Button', 'Column', 'Row', 'Text']);
  assert.ok(processCard(PLAN_CARD, CARD_CATALOG, () => {}), 'the app’s catalog takes Steward’s surface');
  // a surface it cannot take is today's card (A2uiSurface itself needs a window: it does not server-render, so the
  // drawn card is seen live, ExecPlan 0004's acceptance)
  const old = React.createElement('p', null, 'TODAYS CARD');
  for (const messages of [undefined, [PLAN_CARD[0]], [{ version: 'v0.9', createSurface: { surfaceId: 's', catalogId: 'https://example.invalid/other' } }]])
    assert.equal(renderToStaticMarkup(React.createElement(A2uiCard, { messages, onAnswer: () => {}, fallback: old })), '<p>TODAYS CARD</p>');

  // the Agent tab and the Phone view draw A2uiCard for a card that carries a surface, today's card otherwise
  const view = read('../components/AgentView.tsx');
  assert.match(view, /r\.a2ui \? \(\s*<A2uiCard key=\{r\.id\} messages=\{r\.a2ui\} onAnswer=\{\(allow\) => answer\(r, allow\)\} fallback=\{card\} footer=\{reply\} \/>/);
  const phone = read('../components/PhoneView.tsx');
  assert.match(phone, /e\.a2ui && e\.cardId && open\.includes\(e\.cardId\) \? \(\s*<A2uiCard key=\{i\} messages=\{e\.a2ui\} onAnswer=\{\(allow\) => answer\(e\.cardId!, allow\)\} fallback=\{card\} \/>/);
});
