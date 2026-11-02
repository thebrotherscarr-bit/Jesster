import type { ActiveTab } from '../components/Header.tsx';

/**
 * The shelf SecondBrain opens on (Kyle, 2026-11-02: "it should default to the agent tab, instead of the notes tab"):
 * the Agent where the desktop app runs one, else Notes (the web build has no Agent).
 */
export const defaultTab = (hasAgent: boolean): ActiveTab => (hasAgent ? 'agent' : 'notes');
