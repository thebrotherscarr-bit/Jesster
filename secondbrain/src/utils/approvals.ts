import type { ApprovalItem, ToolApproval } from '../types/desktop.ts';

/**
 * What Always allow covers, as electron/agent/service.cjs keeps it: the key is the tool's name and the exact text
 * its card showed (for Steward's cards that text is the tool and its exact arguments), held in memory only.
 */
export const ALWAYS_SCOPE =
  'Always allow: this exact call (the same tool with exactly what this card shows) runs without asking again, until SecondBrain restarts. Any other arguments still ask.';

/** Always is offered only on an Agent-tab tool card: never on a review, never on a door hold (his per-act word). */
export const canAlways = (card: { plane: 'agent' | 'door'; kind?: string }): boolean => card.plane === 'agent' && card.kind !== 'review';

/** A policy row's approval, in words. */
export const approvalWord = (a: ToolApproval): string => (a === 'always' ? 'always asks' : a === 'never' ? 'never asks' : 'asks by a rule');

/** Where a card came from: the conversation (its title when known) or the door's project and who asked. */
export const whereWord = (item: ApprovalItem, titles: Record<string, string> = {}): string =>
  item.plane === 'agent'
    ? `Agent tab · ${(titles[item.sessionId] || item.sessionId).replace(/^Agent: /, '')}`
    : `the door · ${item.project} · asked by ${item.caller}`;
