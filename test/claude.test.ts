import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory, type Entry } from '../src/memory.ts';
import { createProfile, profilePath, rememberProfile } from '../src/profiles.ts';
import { readTranscript, toolName, typed } from '../src/transcript.ts';
import { bindSession, deliver, ingest, pending, readMemory, resolveProfile } from '../src/runtime.ts';
import { previousExchange } from '../src/context.ts';
import { createCompressor } from '../src/compactor.ts';
import { handle } from '../src/hooks.ts';
import { respond } from '../src/mcp.ts';
import { run } from '../src/cli.ts';

const line = (value: Record<string, unknown>) => JSON.stringify({ isSidechain: false, timestamp: '2026-10-09T10:00:00.000Z', ...value });
const transcript = [
  line({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'Remember: the cat is Biscuit.' } }),
  line({ type: 'user', uuid: 'meta', isMeta: true, message: { role: 'user', content: 'injected context' } }),
  line({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }] } }),
  line({ type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'mcp__plugin_optchat_memory__zoom', input: { id: 0 } }] } }),
  line({ type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '0+0|user: hi' }] }] } }),
  line({ type: 'assistant', uuid: 'a3', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Agent', input: { prompt: 'look' } }] } }),
  line({ type: 'user', uuid: 'r2', toolUseResult: { agentId: 'abc123' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'found it' }] } }),
  line({ type: 'user', uuid: 'side', isSidechain: true, message: { role: 'user', content: 'subagent chatter' } }),
  line({ type: 'user', uuid: 'c1', message: { role: 'user', content: '<command-name>/optchat:status</command-name>\n<command-args></command-args>' } }),
  line({ type: 'user', uuid: 'c2', message: { role: 'user', content: '<local-command-stdout>output</local-command-stdout>' } }),
  line({ type: 'assistant', uuid: 'a4', message: { role: 'assistant', content: [{ type: 'text', text: 'Biscuit it is.' }] } }),
].join('\n') + '\n';

test('a Claude Code transcript is logged as Pi logged a run: user, talk, tool, echo and work, without reasoning or sidechains', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-transcript-'));
  try {
    const file = join(dir, 's.jsonl');
    writeFileSync(file, transcript + '{"type":"user","uuid":"torn"');
    const first = readTranscript(file);
    assert.deepEqual(first.entries.map(e => [e.kind, e.text]), [
      ['user', 'Remember: the cat is Biscuit.'],
      ['tool', 'zoom {"id":0}'],
      ['echo', 'zoom: 0+0|user: hi'],
      ['tool', 'Agent {"prompt":"look"}'],
      ['work', '[abc123] found it\n\nFull chat: zoom("abc123")'],
      ['user', '/optchat:status'],
      ['talk', 'Biscuit it is.'],
    ]);
    assert.equal(first.cursor.offset, Buffer.byteLength(transcript), 'a torn last line waits for the next read');
    assert.equal(readTranscript(file, first.cursor).entries.length, 0, 'the cursor reads each line once');
    assert.equal(new Set(first.entries.map(e => e.receipt)).size, first.entries.length, 'every entry has its own receipt');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('typed text keeps commands as typed and drops their output', () => {
  assert.deepEqual(typed('<bash-input>ls</bash-input>'), { kind: 'user', text: '!ls' });
  assert.equal(typed('<bash-stdout>x</bash-stdout>'), undefined);
  assert.equal(typed('[Request interrupted by user]')?.kind, 'echo');
  assert.equal(toolName('mcp__plugin_optchat_memory__search'), 'search');
  assert.equal(toolName('mcp__github__get_me'), 'mcp__github__get_me');
});

test('the previous exchange is the last answered request and its final reply, or nothing when too long', () => {
  const entry = (kind: Entry['kind'], text: string): Entry => ({ i: 0, kind, text, size: 0, date: '' });
  const root = [entry('user', 'old'), entry('talk', 'old answer'), entry('user', 'why?'), entry('tool', 'Bash {}'), entry('echo', 'Bash: ok'), entry('talk', 'because'), entry('talk', 'done')];
  assert.equal(previousExchange(root, 10_000), '<previous-exchange>\nuser: why?\n\ntalk: because\n\ndone\n</previous-exchange>');
  assert.equal(previousExchange(root, 10), undefined);
  assert.equal(previousExchange([...root, entry('tool', 'Bash {}')], 10_000), undefined, 'a run cut off mid-way has no final answer');
});

test('the inbox lands each batch once, in order, and readers see it before the worker takes it in', async () => {
  createProfile('inbox'); const dir = profilePath('inbox');
  deliver(dir, [{ kind: 'user', text: 'one', date: '2026-10-09T10:00:00.000Z', receipt: 'r1' }]);
  deliver(dir, [{ kind: 'talk', text: 'two', date: '2026-10-09T10:00:01.000Z', receipt: 'r2' }, { kind: 'user', text: 'one', date: '2026-10-09T10:00:00.000Z', receipt: 'r1' }]);
  const reader = readMemory(dir);
  assert.deepEqual(reader.root.map(e => e.text), ['one', 'two']);
  await reader.close();
  assert.equal(readdirSync(join(dir, 'main')).length, 0, 'readers never write the log');
  const memory = new Memory(dir, async () => 'summary', () => {});
  for (const batch of pending(dir)) ingest(memory, batch.entries);
  assert.deepEqual(memory.root.map(e => e.text), ['one', 'two']);
  await memory.close();
});

test('a session keeps the profile it started with; OPTCHAT_PROFILE and off win', () => {
  createProfile('first'); createProfile('second');
  rememberProfile('first');
  assert.equal(resolveProfile('s1'), 'first');
  rememberProfile('second');
  assert.equal(resolveProfile('s1'), 'first', 'bound on first use');
  assert.equal(resolveProfile('s2'), 'second');
  bindSession('s3', 'off');
  assert.equal(resolveProfile('s3'), undefined);
  process.env.OPTCHAT_PROFILE = 'first';
  try { assert.equal(resolveProfile('s2'), 'first'); } finally { delete process.env.OPTCHAT_PROFILE; }
});

test('a session start logs the transcript and brings in the instructions and the view; an OptChat subagent gets them too', async () => {
  createProfile('hooks');
  const work = mkdtempSync(join(tmpdir(), 'oc-hooks-')), file = join(work, 't.jsonl');
  writeFileSync(file, transcript);
  process.env.OPTCHAT_PROFILE = 'hooks';
  try {
    assert.equal(await handle({ hook_event_name: 'Stop', session_id: 'h1', transcript_path: file }, 0), undefined);
    const start = await handle({ hook_event_name: 'SessionStart', session_id: 'h2', source: 'clear', transcript_path: join(work, 'none.jsonl') }, 0);
    const context = String(start?.hookSpecificOutput?.additionalContext);
    assert.match(context, /^You are OptChat/);
    assert.match(context, /# Profile: hooks\n\n# hooks/);
    assert.match(context, /<chat>\n0\+1\|user: Remember: the cat is Biscuit\./);
    assert.match(context, /<previous-exchange>\nuser: Remember: the cat is Biscuit\.\n\nuser: \/optchat:status\n\ntalk: Biscuit it is\.\n<\/previous-exchange>$/);
    assert.match(String(start?.systemMessage), /^OptChat · hooks · 7 messages/);
    assert.equal(await handle({ hook_event_name: 'SessionStart', session_id: 'h2', source: 'resume' }, 0), undefined, 'a resumed session has its view already');
    const sub = await handle({ hook_event_name: 'SubagentStart', session_id: 'h2', agent_type: 'optchat:optchat-subagent' }, 0);
    assert.match(String(sub?.hookSpecificOutput?.additionalContext), /^You are a subagent of OptChat[\s\S]*<chat>/);
    assert.equal(await handle({ hook_event_name: 'SubagentStart', session_id: 'h2', agent_type: 'Explore' }, 0), undefined);
  } finally { delete process.env.OPTCHAT_PROFILE; rmSync(work, { recursive: true, force: true }); }
});

test('the MCP server lists zoom and date, adds search only when the setting is on, and answers from memory', async () => {
  createProfile('mcp'); const dir = profilePath('mcp');
  deliver(dir, [{ kind: 'user', text: 'the banner moved', date: '2026-10-09T10:00:00.000Z', receipt: 'm1' }]);
  process.env.OPTCHAT_PROFILE = 'mcp';
  try {
    const init = await respond({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal((init?.result as { protocolVersion: string }).protocolVersion, '2025-06-18');
    const names = async () => ((await respond({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))?.result as { tools: { name: string }[] }).tools.map(t => t.name);
    assert.deepEqual(await names(), ['zoom', 'date']);
    assert.match(await run(['settings', 'memorySearch', 'true']), /^Memory search: true/);
    assert.deepEqual(await names(), ['zoom', 'date', 'search']);
    const call = async (name: string, args: Record<string, unknown>) => (await respond({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }))?.result as { content: { text: string }[]; isError?: boolean };
    assert.equal((await call('zoom', { id: 0 })).content[0].text, '0+0|user: the banner moved');
    assert.match((await call('search', { text: 'BANNER' })).content[0].text, /^1 message contains "BANNER"/);
    assert.equal((await call('zoom', { id: 5 })).isError, true);
    assert.equal(await respond({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  } finally { delete process.env.OPTCHAT_PROFILE; }
});

test('the compactor retries a long line with the recipe\'s "Too long" text and keeps the shortest', async () => {
  const prompts: string[] = [], replies = ['x'.repeat(700), 'y'.repeat(900), 'short line'];
  const compress = createCompressor(() => ({ provider: 'anthropic', model: 'claude-sonnet-5-5', thinking: 'medium' }), () => 640, () => {},
    async (_choice, _system, prompt) => { prompts.push(prompt); return { text: replies[prompts.length - 1] }; });
  const line = await compress({ context: '<chat>\n</chat>', source: 'z'.repeat(2000), part: { l: 0, i: 0 } }, new AbortController().signal);
  assert.equal(line, 'short line');
  assert.equal(prompts.length, 3);
  assert.match(prompts[1], /Your line was:\nx{700}\n\nToo long: your line is 700 bytes/);
});

test('profile and settings commands create, switch and validate', async () => {
  process.env.CLAUDE_CODE_SESSION_ID = 'cli-session';
  try {
    assert.match(await run(['profile', 'cli']), /^Created profile cli/);
    assert.match(await run(['status']), /^OptChat · cli · 0 messages/);
    await assert.rejects(run(['settings', 'maxAgents', '0']), /whole number of 1 or more/);
    assert.match(await run(['model', 'claude-haiku-5-5', 'low']), /^Compactor: claude-haiku-5-5 \(low\)/);
    assert.match(await run(['profile', 'off']), /off for this session/);
    assert.match(await run(['status']), /^OptChat is off in this session/);
  } finally { delete process.env.CLAUDE_CODE_SESSION_ID; }
});
