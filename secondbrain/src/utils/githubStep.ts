/**
 * The GitHub shelf's one big button per repository (plan-github-shelf, G2): from the door's `git`
 * state (asked with fetch, so ahead and behind are today's) and the repository's open pull
 * requests, the usual next step and why. Every act it names is a door tool; nothing here runs one.
 */

/** The door's `git` answer (door/git.cjs toolGit), as JSON. */
export interface RepoState {
  world: string;
  is_repo: boolean;
  branch?: string;
  head?: string;
  subject?: string;
  when?: string;
  changed?: number;
  untracked?: number;
  dirty?: boolean;
  files?: string[];
  upstream?: string;
  ahead?: number;
  behind?: number;
  remotes?: string[];
  why_not_send?: string;
  remote_allowed?: boolean;
  remote_note?: string;
  fetched?: boolean;
  fetch_note?: string;
}

/** One open pull request (door/gitctl.cjs prList). */
export interface PullRequest {
  number: number;
  title: string;
  line: string;
  into: string;
  url: string;
  checks: 'none' | 'pending' | 'passed' | 'failed';
}

export type Act = 'save' | 'send' | 'pull' | 'pr' | 'merge' | 'main' | 'line' | 'none';

export interface Step {
  act: Act;
  label: string;
  why: string;
  pr?: PullRequest;
}

export const isMain = (branch?: string) => branch === 'main' || branch === 'master';

const n = (x?: number) => x || 0;
const saves = (k: number) => `${k} save${k === 1 ? '' : 's'}`;

export function nextStep(st: RepoState | null, prs: PullRequest[] = []): Step {
  if (!st) return { act: 'none', label: 'Not read yet', why: '' };
  if (!st.is_repo) return { act: 'none', label: 'Not a repository', why: 'There is nothing here to save or send.' };
  const dirtyCount = n(st.changed) + n(st.untracked);
  if (dirtyCount > 0) return { act: 'save', label: `Save ${dirtyCount} change${dirtyCount === 1 ? '' : 's'}`, why: 'There is unsaved work here. Say what it is, then save it.' };
  if (!st.remote_allowed) return { act: 'none', label: 'Sending is off', why: st.remote_note || 'The wall (MANJUEL_GIT_REMOTE) is shut.' };
  const ahead = n(st.ahead);
  const behind = n(st.behind);
  if (isMain(st.branch)) {
    if (behind > 0 && ahead === 0) return { act: 'pull', label: `Bring level (${saves(behind)} on GitHub)`, why: `GitHub's ${st.branch} has ${saves(behind)} this machine does not. Fast-forward only.` };
    if (ahead > 0) {
      return {
        act: 'line',
        label: 'Start a line of work',
        why: `${saves(ahead)} here are not on GitHub, and ${st.branch} on GitHub takes a change only through a pull request. Put them on a line of work and send that.`,
      };
    }
    return { act: 'none', label: 'Level with GitHub', why: `${st.branch} here is ${st.branch} on GitHub.` };
  }
  if (!st.upstream) return { act: 'send', label: 'Send this line', why: `${st.branch} has never been sent; sending links it to GitHub.` };
  if (ahead > 0) return { act: 'send', label: `Send ${saves(ahead)}`, why: `GitHub does not have ${saves(ahead)} on ${st.branch} yet.` };
  if (behind > 0) return { act: 'pull', label: `Bring level (${saves(behind)} on GitHub)`, why: `GitHub has ${saves(behind)} on ${st.branch} this machine does not.` };
  const pr = prs.find((p) => p.line === st.branch);
  if (!pr) return { act: 'pr', label: 'Open a pull request', why: `${st.branch} is sent and has no open pull request. Open one, or go back to main if it has landed.` };
  if (pr.checks === 'passed') return { act: 'merge', label: `Merge #${pr.number}`, why: `Every check on #${pr.number} has passed. It merges on GitHub, then this checkout goes back to main.`, pr };
  if (pr.checks === 'failed') return { act: 'none', label: `#${pr.number}'s checks failed`, why: 'Mend the line, save, send, and merge when they pass.', pr };
  if (pr.checks === 'pending') return { act: 'none', label: `#${pr.number}'s checks are running`, why: 'It can merge once every check has passed.', pr };
  return { act: 'none', label: `No checks on #${pr.number} yet`, why: 'Nothing has proved it yet.', pr };
}
