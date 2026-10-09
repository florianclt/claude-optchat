import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FileStore } from './store.ts';
import { listProfiles, loadConfig, profilePath } from './profiles.ts';
import { memoryDirectory, pendingImport } from './import/job.ts';
import { deliver, readMemory, resolveProfile } from './runtime.ts';
import { loadCursor, readTranscript, saveCursor, saveImage } from './transcript.ts';
import { sessionContext, subagentContext } from './context.ts';
import { ensureWorker } from './worker.ts';
import { CHILD } from './compactor.ts';
import { record } from './cache.ts';

/** Claude Code's hooks stand in for Pi's extension events: each one logs the session's transcript up to now, and the session's
 * start (and /clear, and a compaction) brings in the view. They never write memory themselves: see src/runtime.ts. */
export interface HookInput { hook_event_name: string; session_id?: string; transcript_path?: string; source?: string; agent_type?: string; prompt?: string }
export interface HookOutput { hookSpecificOutput?: Record<string, unknown>; systemMessage?: string; decision?: 'block'; reason?: string }

/** How long a session's start waits for summaries still being built before it goes on with placeholders, as Pi's turn did
 * once every pending summary had failed. Claude Code gives the hook a minute. */
const WAIT_MS = 30_000;

/** Reads the transcript from where the last hook left off, keeps its images, and hands the entries to the worker. */
export async function sync(dir: string, input: HookInput) {
  const { session_id: session, transcript_path: path } = input;
  if (!session || !path) return;
  const cursor = loadCursor(dir, session), read = readTranscript(path, cursor);
  if (read.images.length) {
    const store = new FileStore(memoryDirectory(dir), () => {});
    for (const image of read.images) await saveImage(store, image);
  }
  deliver(dir, read.entries);
  saveCursor(dir, session, read.cursor);
}

async function settledMemory(dir: string, wait: number) {
  const until = Date.now() + wait;
  for (;;) {
    const memory = readMemory(dir);
    if (memory.ready || Date.now() >= until) return memory;
    await memory.close();
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

export async function handle(input: HookInput, wait = WAIT_MS): Promise<HookOutput | undefined> {
  const event = input.hook_event_name;
  const name = resolveProfile(input.session_id, event === 'SessionStart');
  if (!name) {
    if (event === 'SessionStart' && input.source === 'startup' && !listProfiles().length && !process.env.OPTCHAT_PROFILE)
      return { systemMessage: 'OptChat: no profile yet. Create one with /optchat:profile <name> (for example work), then /clear.' };
    return undefined;
  }
  const dir = profilePath(name);
  if (pendingImport(dir)) {
    if (event === 'UserPromptSubmit') return { decision: 'block', reason: `OptChat: ${name} has an import in progress. Finish it with /optchat:import resume or discard it, or switch profiles.` };
    return undefined;
  }
  if (event !== 'SubagentStart') await sync(dir, input);
  ensureWorker(dir);
  const config = loadConfig(dir);
  if (event === 'SessionStart' && input.source !== 'resume') {
    const memory = await settledMemory(dir, wait);
    try {
      const missing = memory.view.filter(part => !memory.node(part)).length;
      return {
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: sessionContext(name, dir, config, memory, input.source === 'clear' || input.source === 'compact') },
        systemMessage: `OptChat · ${name} · ${memory.root.length} messages${missing ? ` · ${missing} not summarized yet` : ''}`,
      };
    } finally { await memory.close(); }
  }
  if (event === 'SubagentStart' && /(^|:)optchat-subagent$/.test(input.agent_type ?? '')) {
    const memory = readMemory(dir);
    try { return { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: subagentContext(name, dir, config, memory) } }; }
    finally { await memory.close(); }
  }
  return undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.env[CHILD]) process.exit(0);
  let input: unknown;
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
  if (!record(input) || typeof input.hook_event_name !== 'string') process.exit(0);
  handle(input as unknown as HookInput).then(output => {
    if (output) process.stdout.write(JSON.stringify(output));
    process.exit(0);
  }, error => {
    // A hook that fails must not stop the session: say why, and carry on as plain Claude Code.
    process.stdout.write(JSON.stringify({ systemMessage: `OptChat: ${error instanceof Error ? error.message : String(error)}` }));
    process.exit(0);
  });
}
