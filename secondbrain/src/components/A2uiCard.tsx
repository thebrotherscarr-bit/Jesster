import React, { useMemo } from 'react';
import { A2uiSurface, createComponentImplementation } from '@a2ui/react/v0_9';
import type { ReactComponentImplementation } from '@a2ui/react/v0_9';
import { ButtonApi, ColumnApi, RowApi, TextApi } from '@a2ui/web_core/v0_9/basic_catalog';
import { cardCatalog, planCardAnswer, processCard } from '../utils/a2uiCard.ts';

/**
 * A card drawn from the A2UI surface Steward sent with it (his ADR-0013, the A2UI pilot: the plan's card). The
 * surface is processed by @a2ui/web_core's MessageProcessor and drawn by @a2ui/react's A2uiSurface, with the app's own
 * implementations of the four basic-catalog components the plan card uses, in the app's classes (the old card's
 * look). Its Approve and Deny answer the card through `onAnswer`, as the old card's buttons do (the answer goes back
 * as the AG-UI resume). No surface, one the processor refuses, or one that fails to draw: `fallback`, today's card.
 */

const childRef = (c: unknown): { id: string; basePath?: string } =>
  typeof c === 'string' ? { id: c } : (c as { id: string; basePath?: string });

const Column = createComponentImplementation(ColumnApi, ({ props, buildChild }) => (
  <div className="flex flex-col gap-1.5 min-w-0">{(props.children || []).map((c) => { const r = childRef(c); return <React.Fragment key={r.id}>{buildChild(r.id, r.basePath)}</React.Fragment>; })}</div>
));
const Row = createComponentImplementation(RowApi, ({ props, buildChild }) => (
  <div className="flex flex-wrap gap-2 pt-1">{(props.children || []).map((c) => { const r = childRef(c); return <React.Fragment key={r.id}>{buildChild(r.id, r.basePath)}</React.Fragment>; })}</div>
));
const Text = createComponentImplementation(TextApi, ({ props }) =>
  props.variant && /^h\d$/.test(props.variant) ? (
    <div className="text-sm text-amber-200 font-semibold [overflow-wrap:anywhere]">{props.text}</div>
  ) : (
    <div className="text-xs text-neutral-200 whitespace-pre-wrap [overflow-wrap:anywhere]">{props.text}</div>
  )
);
const Button = createComponentImplementation(ButtonApi, ({ props, buildChild }) => (
  <button
    onClick={() => void props.action?.()}
    className={
      props.variant === 'primary'
        ? 'flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 text-xs text-white hover:bg-emerald-500'
        : 'flex items-center gap-1 px-3 py-1.5 rounded-lg border border-neutral-700 text-xs text-neutral-300 hover:bg-neutral-800'
    }
  >
    {props.child ? buildChild(props.child) : null}
  </button>
));

/** The app's catalog for A2UI cards: the basic catalog's id, its Column, Row, Text and Button, drawn the app's way. */
export const CARD_CATALOG = cardCatalog<ReactComponentImplementation>([Column, Row, Text, Button]);

/** A surface that throws while drawing falls back to today's card. */
class Fallback extends React.Component<{ fallback: React.ReactNode; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export const A2uiCard: React.FC<{
  messages: unknown;
  onAnswer: (allow: boolean) => void;
  /** today's card, drawn instead when the surface cannot be */
  fallback: React.ReactNode;
  /** drawn under the surface, inside the card (the Agent tab's reply box) */
  footer?: React.ReactNode;
}> = ({ messages, onAnswer, fallback, footer }) => {
  const answer = React.useRef(onAnswer);
  answer.current = onAnswer;
  const card = useMemo(() => {
    let surfaceId = '';
    const made = processCard(messages, CARD_CATALOG, (action) => {
      const allow = planCardAnswer(action, surfaceId);
      if (allow !== null) answer.current(allow);
    });
    if (made) surfaceId = made.surfaceId;
    return made;
  }, [messages]);
  const surface = card ? card.processor.model.surfacesMap.get(card.surfaceId) : undefined;
  if (!surface) return <>{fallback}</>;
  return (
    <Fallback fallback={fallback}>
      <div role="alertdialog" data-a2ui-card className="rounded-xl border border-amber-800 bg-amber-950/40 p-3 space-y-2">
        <A2uiSurface surface={surface} />
        {footer}
      </div>
    </Fallback>
  );
};
