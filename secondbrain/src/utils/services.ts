import type { ServiceKind, ServiceStatus } from '../types/desktop.ts';

/** How many lines of a server's log the Servers shelf shows. */
export const LOG_LINES = 200;

/** A server's status in words, as the Servers shelf says it. */
export const statusWord = (s: ServiceStatus): string =>
  s === 'up' ? 'running' : s === 'starting' ? 'starting' : s === 'held' ? 'held' : 'not answering';

/** The colour of a server's status dot and word: the same emerald and amber the Steward window uses. */
export const statusTone = (s: ServiceStatus): { dot: string; text: string } =>
  s === 'up'
    ? { dot: 'bg-emerald-400', text: 'text-emerald-400' }
    : s === 'starting'
      ? { dot: 'bg-sky-400', text: 'text-sky-400' }
      : s === 'held'
        ? { dot: 'bg-neutral-500', text: 'text-neutral-400' }
        : { dot: 'bg-amber-400', text: 'text-amber-400' };

/** Who runs a server, in words. */
export const kindWord = (k: ServiceKind): string => (k === 'owned' ? 'SecondBrain runs it' : 'runs outside SecondBrain');

/** The last `n` lines of a log (a trailing newline does not count as a line). */
export const lastLines = (text: string, n: number = LOG_LINES): string => {
  if (!text || n <= 0) return '';
  const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  return lines.slice(-n).join('\n');
};
