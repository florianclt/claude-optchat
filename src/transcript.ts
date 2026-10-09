import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cap, CAP, type Kind } from './memory.ts';
import { record } from './cache.ts';
import { atomicWrite, isMime, type Store } from './store.ts';
import type { Arrival } from './runtime.ts';

/** How a tool reads in memory: OptChat's own MCP tools by their bare names, so search skips logged zoom and search calls as in Pi. */
export function toolName(name: string) {
  const own = /^mcp__plugin_optchat_[^_]+(?:_[^_]+)*__(\w+)$/.exec(name);
  return own ? own[1] : name;
}
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const string = (v: unknown) => typeof v === 'string' ? v : undefined;

interface Image { data: string; mimeType: string }
const hash = (data: string) => createHash('sha256').update(data).digest('hex').slice(0, 16);
/** As in Pi: an image is named by a hash of its base64 data, and the message text names it as `[image <hash>]`. */
export const imageRef = (image: Image) => `[image ${hash(image.data)}]`;
function image(block: Record<string, unknown>): Image | undefined {
  const source = block.source;
  if (block.type !== 'image' || !record(source) || source.type !== 'base64' || typeof source.data !== 'string' || typeof source.media_type !== 'string') return undefined;
  return { data: source.data, mimeType: source.media_type };
}
/** Pi shrank images with its own resizer before keeping them; this port keeps them as Claude Code received them, which
 * Claude Code has already sized for the model. */
export async function saveImage(store: Store, { data, mimeType }: Image) {
  const name = hash(data);
  if (!isMime(mimeType) || await store.image(name)) return;
  await store.putImage(name, mimeType, Buffer.from(data, 'base64'));
}
const REF = /\[image ([0-9a-f]{16})\]/g;
/** The kept images a text names, in order, each once, as MCP image content. */
export async function loadImages(store: Store, text: string) {
  const names = [...new Set(Array.from(text.matchAll(REF), match => match[1]))];
  return (await Promise.all(names.map(name => store.image(name))))
    .flatMap(kept => kept ? [{ type: 'image' as const, data: Buffer.from(kept.data).toString('base64'), mimeType: kept.mimeType }] : []);
}

function textOf(content: unknown, images: Image[] = []): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part: unknown) => {
    if (!record(part)) return '';
    if (part.type === 'text' && typeof part.text === 'string') return part.text;
    const kept = image(part);
    if (kept) { images.push(kept); return imageRef(kept); }
    return '';
  }).filter(Boolean).join('\n');
}
/** What the user typed, as Claude Code records it: slash commands as `/name args`, `!` commands as typed, and none of the
 * output Claude Code logs for them. Undefined for text the user never typed. */
export function typed(text: string): { kind: Kind; text: string } | undefined {
  const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim();
  if (/^\s*<(local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr)>/.test(text)) return undefined;
  const command = tag('command-name');
  if (command !== undefined) return { kind: 'user', text: `${command.startsWith('/') ? command : `/${command}`} ${tag('command-args') ?? ''}`.trimEnd() };
  const bash = tag('bash-input');
  if (bash !== undefined) return { kind: 'user', text: `!${bash}` };
  if (/^\s*<task-notification>/.test(text)) return { kind: 'work', text: text.trim() };
  if (/^\[Request interrupted by user/.test(text)) return { kind: 'echo', text: 'Agent aborted: interrupted by the user' };
  return text.trim() ? { kind: 'user', text } : undefined;
}

/** Where a session's transcript was read up to, and the names of recent tool calls, whose results arrive in later lines. */
export interface Cursor { offset: number; tools: Record<string, string> }
const KEPT_TOOLS = 200;

/** The entries in a Claude Code transcript from `cursor` on, for memory, as Pi's message_end logged them: the user's words
 * (`user`), replies (`talk`), tool calls (`tool`), results capped at 30,000 characters (`echo`), and subagent reports
 * (`work`). Reasoning, sidechains, injected context and compaction summaries are left out. Only whole lines are read. */
export function readTranscript(path: string, cursor: Cursor = { offset: 0, tools: {} }) {
  const entries: Arrival[] = [], images: Image[] = [];
  if (!existsSync(path)) return { entries, images, cursor };
  const fd = openSync(path, 'r');
  let text: string;
  try {
    const size = fstatSync(fd).size;
    if (size < cursor.offset) cursor = { offset: 0, tools: {} };
    const buffer = Buffer.alloc(size - cursor.offset);
    readSync(fd, buffer, 0, buffer.length, cursor.offset);
    text = buffer.toString('utf8');
  } finally { closeSync(fd); }
  const end = text.lastIndexOf('\n') + 1, tools = { ...cursor.tools };
  for (const line of text.slice(0, end).split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (!record(value) || value.isSidechain === true || value.isMeta === true || value.isCompactSummary === true || value.isVisibleInTranscriptOnly === true) continue;
    const message = value.message, uuid = string(value.uuid), date = string(value.timestamp) ?? new Date().toISOString();
    if (!record(message) || !uuid) continue;
    const push = (k: number, kind: Kind, body: string) => { if (body.trim()) entries.push({ kind, text: body, date, receipt: `cc:${uuid}:${k}` }); };
    if (value.type === 'assistant' && Array.isArray(message.content)) {
      if (value.isApiErrorMessage === true) { push(0, 'echo', `Agent error: ${textOf(message.content) || 'No further details'}`); continue; }
      message.content.forEach((block: unknown, k) => {
        if (!record(block)) return;
        if (block.type === 'text' && typeof block.text === 'string') push(k, 'talk', block.text);
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          if (typeof block.id === 'string') tools[block.id] = block.name;
          push(k, 'tool', `${toolName(block.name)} ${JSON.stringify(block.input ?? {})}`);
        }
      });
    } else if (value.type === 'user') {
      const content = message.content;
      if (typeof content === 'string') { const t = typed(content); if (t) push(0, t.kind, t.text); continue; }
      if (!Array.isArray(content)) continue;
      const words: unknown[] = [];
      content.forEach((block: unknown, k) => {
        if (!record(block)) return;
        if (block.type !== 'tool_result') { words.push(block); return; }
        const id = string(block.tool_use_id) ?? '', name = tools[id] ?? 'tool', result = textOf(block.content, name === 'zoom' || name.endsWith('__zoom') ? [] : images);
        const agent = record(value.toolUseResult) ? string(value.toolUseResult.agentId) : undefined;
        if (AGENT_TOOLS.has(name) && agent && block.is_error !== true) push(k, 'work', `[${agent}] ${result}\n\nFull chat: zoom("${agent}")`);
        else push(k, 'echo', cap(`${toolName(name)}: ${block.is_error === true ? '(error) ' : ''}${result}`, CAP));
      });
      if (words.length) { const t = typed(textOf(words, images)); if (t) push(content.length, t.kind, t.text); }
    }
  }
  const names = Object.entries(tools);
  return { entries, images, cursor: { offset: cursor.offset + Buffer.byteLength(text.slice(0, end)), tools: Object.fromEntries(names.slice(-KEPT_TOOLS)) } };
}

/** Each session's cursor, in the profile, so a transcript is read once however many hooks run. */
const cursorFile = (dir: string, session: string) => join(dir, 'sessions', `${session.replace(/[^\w-]/g, '_')}.json`);
export function loadCursor(dir: string, session: string): Cursor {
  try {
    const value: unknown = JSON.parse(readFileSync(cursorFile(dir, session), 'utf8'));
    if (record(value) && Number.isSafeInteger(value.offset) && record(value.tools)) return { offset: Number(value.offset), tools: value.tools as Record<string, string> };
  } catch {}
  return { offset: 0, tools: {} };
}
export const saveCursor = (dir: string, session: string, cursor: Cursor) => atomicWrite(cursorFile(dir, session), JSON.stringify(cursor));

/** A subagent's chat for zoom("<agent id>"), as `kind|text` lines like Pi's run transcripts. Claude Code keeps it next to the
 * session's transcript, in `<session>/subagents/agent-<id>.jsonl`. */
const STEP = 1_000;
export function findAgentTranscript(id: string, root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')) {
  if (!/^[\w-]{1,64}$/.test(id)) return undefined;
  const name = `agent-${id}.jsonl`;
  try {
    for (const project of readdirSync(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      for (const session of readdirSync(join(root, project.name), { withFileTypes: true })) {
        if (!session.isDirectory()) continue;
        const file = join(root, project.name, session.name, 'subagents', name);
        if (existsSync(file)) return file;
      }
    }
  } catch {}
  return undefined;
}
export function agentTranscript(file: string) {
  const lines: string[] = [], tools: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (!record(value) || !record(value.message) || value.isMeta === true) continue;
    const content = value.message.content;
    if (value.type === 'user') {
      if (typeof content === 'string') { lines.push(`user|${content}`); continue; }
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!record(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string') lines.push(`user|${block.text}`);
        if (block.type === 'tool_result') lines.push(`echo|${cap(`${toolName(tools[string(block.tool_use_id) ?? ''] ?? 'tool')}: ${textOf(block.content)}`, STEP)}`);
      }
    } else if (value.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (!record(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) lines.push(`talk|${block.text}`);
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          if (typeof block.id === 'string') tools[block.id] = block.name;
          lines.push(`tool|${cap(`${toolName(block.name)} ${JSON.stringify(block.input ?? {})}`, STEP)}`);
        }
      }
    }
  }
  return lines.join('\n');
}
