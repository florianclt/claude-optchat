import { allowSearch, CONTINUITY, IMPORT_GUIDANCE, MASTER_CLAUDE, SEARCH_DOC, SUBAGENT_CLAUDE, VIEW_DOC } from './prompts.ts';
import { instructions, type ProfileConfig } from './profiles.ts';
import type { Entry, Memory } from './memory.ts';

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/** The latest finished exchange in the log: the user's requests and the reply that ended it, as Pi replayed it after the view.
 * None if the log ends mid-run, or if it is over `limit` bytes. */
export function previousExchange(root: readonly Entry[], limit: number) {
  let end = root.length - 1;
  while (end >= 0 && root[end].kind === 'user') end--; // Requests not answered yet belong to no exchange.
  if (end < 0 || root[end].kind !== 'talk') return undefined;
  let start = end;
  while (start > 0 && root[start - 1].kind === 'talk') start--;
  const requests: Entry[] = [];
  for (let i = start - 1; i >= 0; i--) {
    const e = root[i];
    // Claude Code logs no run boundaries, so the exchange reaches back to the previous reply: a run that ended without one
    // (cut off, or only tool calls) joins it, as steering did in Pi.
    if (e.kind === 'talk') break;
    if (e.kind === 'user') requests.unshift(e);
  }
  if (!requests.length) return undefined;
  const text = [...requests.map(e => `user: ${e.text}`), `talk: ${root.slice(start, end + 1).map(e => e.text).join('\n\n')}`].join('\n\n');
  return bytes(text) <= limit ? `<previous-exchange>\n${text}\n</previous-exchange>` : undefined;
}

const profileSection = (name: string, dir: string) => `# Profile: ${name}\n\n${instructions(dir)}\n\n${IMPORT_GUIDANCE}`;

/** What the main agent gets at the start of a session, after /clear and after a compaction: Pi's system prompt for OptChat
 * (the recipe's turn rules and view doc), the profile's AGENTS.md, then the view, and the previous exchange when that is on. */
export function sessionContext(name: string, dir: string, config: ProfileConfig, memory: Memory, previous: boolean) {
  const doc = allowSearch(`${VIEW_DOC}${config.previousExchange ? CONTINUITY : ''}${config.memorySearch ? SEARCH_DOC : ''}`, config.memorySearch);
  const exchange = previous && config.previousExchange ? previousExchange(memory.root, config.previousExchangeKB * 1000) : undefined;
  return [MASTER_CLAUDE, doc, profileSection(name, dir), memory.render(), ...exchange ? [exchange] : []].join('\n\n');
}
/** What an OptChat subagent gets: the subagent instructions, the view doc, the profile, and the view as of its launch. */
export function subagentContext(name: string, dir: string, config: ProfileConfig, memory: Memory) {
  const doc = allowSearch(`${VIEW_DOC}${config.memorySearch ? SEARCH_DOC : ''}`, config.memorySearch);
  return [SUBAGENT_CLAUDE, doc, profileSection(name, dir), memory.render()].join('\n\n');
}
