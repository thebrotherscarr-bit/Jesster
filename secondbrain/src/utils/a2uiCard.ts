import { Catalog, MessageProcessor } from '@a2ui/web_core/v0_9';
import type { ActionPayload, ComponentApi } from '@a2ui/web_core/v0_9';
import { ButtonApi, ColumnApi, RowApi, TextApi, basicCatalog } from '@a2ui/web_core/v0_9/basic_catalog';

/**
 * The A2UI pilot (Steward's ADR-0013, ExecPlan 0004): Steward's plan card comes with an A2UI v0.9 surface on the basic
 * catalog, built by his workflow from the plan (steward_workflow.plan_card_surface): a Column of Texts (the plan, one
 * per step) and a Row of two Buttons whose actions are `approve` and `deny`. The window draws it with @a2ui/react and
 * the app's own components for the four it uses (components/A2uiCard.tsx); these are the parts with no React.
 */

/** The basic catalog's id, and the components of it the app draws. A surface naming any other is not drawn. */
export const A2UI_CATALOG_ID = basicCatalog.id;
export const A2UI_COMPONENT_APIS = [ColumnApi, RowApi, TextApi, ButtonApi] as const;

/** A catalog of the basic catalog's id with these component APIs (`implementations`: the app's, for drawing). */
export function cardCatalog<T extends ComponentApi>(implementations: readonly T[]): Catalog<T> {
  return new Catalog<T>(A2UI_CATALOG_ID, '0.9', [...implementations]);
}

/** The id of the surface the messages create (one plan card is one surface), or null. */
export function surfaceIdOf(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (const m of messages) {
    const id = m && typeof m === 'object' ? (m as { createSurface?: { surfaceId?: unknown } }).createSurface?.surfaceId : undefined;
    if (typeof id === 'string' && id) return id;
  }
  return null;
}

/**
 * A processor holding the card's surface, or null when the messages are not a surface the app can draw: no surface,
 * a message the protocol refuses, a component the catalog does not have, or no root. Null means today's card.
 */
export function processCard<T extends ComponentApi>(
  messages: unknown,
  catalog: Catalog<T>,
  onAction: (action: ActionPayload) => void,
): { processor: MessageProcessor<T>; surfaceId: string } | null {
  const surfaceId = surfaceIdOf(messages);
  if (!surfaceId) return null;
  try {
    const processor = new MessageProcessor<T>([catalog], onAction);
    processor.processMessages(messages as Parameters<MessageProcessor<T>['processMessages']>[0]);
    const surface = processor.model.surfacesMap.get(surfaceId);
    if (!surface) return null;
    const components = surface.componentsModel.componentsMap;
    if (!components.has('root')) return null;
    for (const c of components.values()) if (!catalog.components.has(c.type)) return null;
    return { processor, surfaceId };
  } catch {
    return null;
  }
}

/**
 * The card's answer from an action of its surface: `approve` is Allow, `deny` is Deny; an action from another surface,
 * or any other action, answers nothing (null).
 */
export function planCardAnswer(action: Pick<ActionPayload, 'name' | 'surfaceId'>, surfaceId: string): boolean | null {
  if (!action || action.surfaceId !== surfaceId) return null;
  return action.name === 'approve' ? true : action.name === 'deny' ? false : null;
}
