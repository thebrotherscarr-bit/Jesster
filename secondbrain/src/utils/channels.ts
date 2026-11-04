import list from '../../electron/channels.json';
import { PhoneChannel } from '../types/desktop.ts';

/** The phone channels switched on: electron/channels.json, the same list the main process reads. */
export const CHANNELS_ON: readonly string[] = list.on;
export const channelOn = (c: PhoneChannel): boolean => CHANNELS_ON.includes(c);

/** The phone's conversations on a channel that is on. */
export const visibleChats = <T extends { channel: PhoneChannel }>(chats: T[]): T[] => chats.filter((c) => channelOn(c.channel));

/**
 * What "Save and start" sends for a bot token: the token only when one was typed. The page never holds the saved
 * token (it sees a mask), so an empty box, or anything with the mask's dots in it, leaves the saved one as it is.
 */
export function tokenPatch(input: string): { token?: string; enabled: true } {
  const t = input.trim();
  return t && !t.includes('•') ? { token: t, enabled: true } : { enabled: true };
}
