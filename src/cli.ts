import { execFile, spawn } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytes } from './memory.ts';
import { createProfile, defaults, instructions, isWindows, listProfiles, loadConfig, lockProfile, ProfileBusyError, profilePath, rememberProfile, saveConfig, THINKING } from './profiles.ts';
import { invalid, isNumberKey, SETTING_KEYS, SETTINGS, type SettingKey } from './settings.ts';
import { exportBrowser } from './browser.ts';
import { deduplicate, discardImport, pendingImport, prepareImport, runImport, type ImportMode } from './import/job.ts';
import { readConversation, scanChatGPT, scanClaudeMemories, scanLocal, type Conversation, type ImportedEntry, type Source } from './import/sources.ts';
import { bindSession, boundSessions, OFF, readMemory, resolveProfile } from './runtime.ts';
import { createCompressor } from './compactor.ts';
import { ensureWorker, workerStatus } from './worker.ts';
import { atomicWrite } from './store.ts';

/** The /optchat:* commands: Pi's /optchat menu, one subcommand per Claude Code command (commands/*.md). Each prints plain text. */
const session = () => process.env.CLAUDE_CODE_SESSION_ID;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const active = () => {
  const name = resolveProfile(session(), false);
  if (!name) throw new Error('No OptChat profile in this session. Choose or create one: /optchat:profile <name>');
  return { name, dir: profilePath(name) };
};
const kb = (n: number) => `${(n / 1000).toFixed(1)} KB`;

function status() {
  const name = resolveProfile(session(), false);
  if (!name) return `OptChat is off in this session.\nProfiles: ${listProfiles().join(', ') || 'none'}. Choose one with /optchat:profile <name>.`;
  const dir = profilePath(name), config = loadConfig(dir), worker = workerStatus(dir), job = pendingImport(dir);
  const memory = readMemory(dir);
  try {
    return [`OptChat · ${name} · ${memory.root.length} messages · ${memory.pending} not summarized yet`,
      `Compactor: ${config.compactor.model} (${config.compactor.thinking})`,
      `Worker: ${worker ? `running (PID ${worker.pid})` : 'idle'}${worker?.lastError ?? memory.lastError ? ` · last error: ${worker?.lastError ?? memory.lastError}` : ''}`,
      ...job ? [`Import paused: ${job.mode}, ${job.added} new messages. /optchat:import resume, or /optchat:import discard.`] : [],
      `Profile folder: ${dir}`,
      'Commands: /optchat:profile, :settings, :model, :activity, :instructions, :browse, :import'].join('\n');
  } finally { void memory.close(); }
}

function activity() {
  const { name, dir } = active(), memory = readMemory(dir), worker = workerStatus(dir);
  try {
    const progress = worker && worker.total ? `Catching up · ${worker.done} of ${worker.total} summaries` : memory.ready ? 'Settled' : `${memory.pending} messages not summarized yet${worker ? '' : ' (the worker starts with your next message)'}`;
    return [`${name} · ${memory.root.length} messages · view ${kb(memory.size)} of ${kb(memory.budget)}`, progress,
      ...worker?.lastError ? [`Failing: ${worker.lastError}`] : []].join('\n');
  } finally { void memory.close(); }
}

function profile(args: string[]) {
  const [name] = args;
  if (!name) {
    const current = resolveProfile(session(), false), names = listProfiles();
    return names.length ? `Profiles (current: ${current ?? 'none'}):\n${names.map(n => `${n === current ? '* ' : '  '}${n}`).join('\n')}\nSwitch with /optchat:profile <name>, or /optchat:profile off.`
      : 'No profiles yet. Create one with /optchat:profile <name>, for example work.';
  }
  const id = session();
  if (name === OFF) {
    if (!id) throw new Error('No Claude Code session to turn OptChat off in.');
    bindSession(id, OFF); return 'OptChat is off for this session; nothing more is logged. /optchat:profile <name> turns it back on.';
  }
  const created = !listProfiles().includes(name);
  if (created) createProfile(name);
  rememberProfile(name);
  if (id) bindSession(id, name);
  return `${created ? 'Created' : 'Switched to'} profile ${name}. New sessions use it too. Run /clear to start from its memory view; from now on this session's messages go to ${name}.`;
}

/** When a change takes effect in Claude Code, where it differs from Pi; Pi's own subagent settings have nothing to drive here. */
const UNUSED = 'Kept in config.json for Pi, unused here: Claude Code runs subagents itself.';
const APPLIES: Partial<Record<SettingKey, string>> = {
  previousExchange: 'Applies from the next session start, /clear or compaction.', previousExchangeKB: 'Applies from the next session start, /clear or compaction.',
  memorySearch: 'Applies from the next session: its tool list and prompt are set when it starts.',
  subagentLevels: UNUSED, maxAgents: UNUSED, groupReports: UNUSED,
};
const applies = (k: SettingKey) => APPLIES[k] ?? SETTINGS[k].applies;
function settings(args: string[]) {
  const { name, dir } = active(), config = loadConfig(dir);
  const [key, raw] = args;
  if (!key) return [`${name} settings (/optchat:settings <key> <value>):`,
    ...SETTING_KEYS.map(k => `${k} = ${config[k]}${config[k] === SETTINGS[k].default ? '' : ` (default ${SETTINGS[k].default})`} · ${SETTINGS[k].label}: ${SETTINGS[k].description} ${applies(k)}`),
    `compactor = ${config.compactor.model} ${config.compactor.thinking} (change with /optchat:model <model> [effort])`].join('\n');
  if (!SETTING_KEYS.includes(key as SettingKey)) throw new Error(`Unknown setting ${key}. Settings: ${SETTING_KEYS.join(', ')}.`);
  const k = key as SettingKey, value = isNumberKey(k) ? Number(raw) : raw === 'true' || raw === 'on' ? true : raw === 'false' || raw === 'off' ? false : raw;
  const problem = invalid(k, value);
  if (problem) throw new Error(problem);
  saveConfig(dir, { ...config, [k]: value });
  return `${SETTINGS[k].label}: ${String(value)}. ${applies(k)}`;
}

function model(args: string[]) {
  const { name, dir } = active(), config = loadConfig(dir);
  const [id, level] = args;
  if (!id) return `${name} compactor: ${config.compactor.model} (${config.compactor.thinking}). Default: ${defaults.compactor.model} (${defaults.compactor.thinking}).\nChange with /optchat:model <model id or alias> [${THINKING.join('|')}].`;
  const thinking = THINKING.find(t => t === (level ?? config.compactor.thinking));
  if (!thinking) throw new Error(`Effort must be one of ${THINKING.join(', ')}.`);
  saveConfig(dir, { ...config, compactor: { provider: config.compactor.provider, model: id, thinking } });
  return `Compactor: ${id} (${thinking}); applies to the next summary.`;
}

function browse() {
  const { name, dir } = active(), memory = readMemory(dir);
  try {
    const file = exportBrowser(memory, name, dir);
    execFile(isWindows ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open', [file], () => {}).unref();
    return `Memory snapshot: ${file}`;
  } finally { void memory.close(); }
}

// Import. Pi asked its questions in dialogs; here each step is a subcommand with flags, so Claude Code can walk the user through them.
interface Choice { source: Source; path?: string; projects: string[]; after?: string; before?: string; conversations: string[]; mode?: ImportMode }
const SOURCES: Record<string, Source> = { claude: 'claude', 'claude-memory': 'claude-memory', codex: 'codex', pi: 'pi', omp: 'pi', chatgpt: 'chatgpt' };
function parseChoice(args: string[]): Choice {
  const choice: Choice = { source: 'claude', projects: [], conversations: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (value === undefined) throw new Error(`${flag} needs a value.`);
    if (flag === '--source') { if (!SOURCES[value]) throw new Error(`--source must be one of ${Object.keys(SOURCES).join(', ')}.`); choice.source = SOURCES[value]; }
    else if (flag === '--path') choice.path = value;
    else if (flag === '--project') choice.projects.push(value);
    else if (flag === '--conversation') choice.conversations.push(value);
    else if (flag === '--after' || flag === '--before') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('Enter dates as YYYY-MM-DD.');
      choice[flag === '--after' ? 'after' : 'before'] = value;
    } else if (flag === '--mode') { if (value !== 'append' && value !== 'rebuild') throw new Error('--mode must be append or rebuild.'); choice.mode = value; }
    else throw new Error(`Unknown flag ${flag}.`);
  }
  return choice;
}
const shortPath = (p: string) => p.startsWith(homedir() + sep) ? '~' + p.slice(homedir().length) : p;
async function scan(choice: Choice) {
  if (choice.source === 'chatgpt' && !choice.path) throw new Error('A ChatGPT import needs --path <export ZIP, folder, or conversations.json>.');
  const result = choice.source === 'chatgpt' ? await scanChatGPT(choice.path!) : choice.source === 'claude-memory' ? await scanClaudeMemories() : await scanLocal(choice.source);
  // Claude Code sessions that ran with OptChat are in a profile's memory already, as Pi skipped its own OptChat sessions.
  const live = boundSessions(), before = result.conversations.length;
  if (choice.source === 'claude') result.conversations = result.conversations.filter(c => !live.has(c.id));
  const skipped = before - result.conversations.length;
  if (skipped) result.note = [result.note, `${skipped} Claude Code session${skipped === 1 ? '' : 's'} ran with OptChat and ${skipped === 1 ? 'is' : 'are'} already in a profile's memory; skipped.`].filter(Boolean).join(' ');
  return result;
}
function select(conversations: Conversation[], choice: Choice) {
  return conversations.filter(c => (!choice.projects.length || choice.projects.some(p => c.project === p || shortPath(c.project) === p))
    && (!choice.conversations.length || choice.conversations.includes(c.id))
    && (!choice.after || c.date.slice(0, 10) >= choice.after) && (!choice.before || c.date.slice(0, 10) <= choice.before));
}
async function importScan(args: string[]) {
  const choice = parseChoice(args), result = await scan(choice), unit = choice.source === 'claude-memory' ? 'memories' : 'conversations';
  if (!result.conversations.length) return `No ${unit} found.${[result.note, ...result.warnings.slice(0, 4)].filter(Boolean).map(w => `\n${w}`).join('')}`;
  const counts = new Map<string, number>();
  for (const c of result.conversations) counts.set(c.project, (counts.get(c.project) ?? 0) + 1);
  const projects = [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
  const listed = choice.projects.length || choice.conversations.length ? select(result.conversations, choice) : [];
  return [`${result.conversations.length} ${unit} in ${projects.length} projects${result.note ? ` (${result.note})` : ''}:`,
    ...projects.map(([p, n]) => `  --project ${JSON.stringify(shortPath(p))}  (${n})`),
    ...listed.length ? ['', `Selected ${unit}:`, ...listed.map(c => `  --conversation ${c.id}  ${c.date.slice(0, 10)} · ${c.title}`)] : [],
    ...result.warnings.length ? ['', `${result.warnings.length} source issues:`, ...result.warnings.slice(0, 4).map(w => `  ${w}`)] : []].join('\n');
}
async function readSelection(choice: Choice) {
  const result = await scan(choice), conversations = select(result.conversations, choice), entries: ImportedEntry[] = [], warnings = [...result.warnings];
  for (const c of conversations) { const parsed = await readConversation(c); entries.push(...parsed.entries); warnings.push(...parsed.warnings); }
  return { conversations, entries, warnings };
}
async function importPlan(args: string[], start: boolean) {
  const { name, dir } = active(), choice = parseChoice(args);
  if (pendingImport(dir)) throw new Error('An import is already pending: /optchat:import status, resume or discard.');
  const { conversations, entries, warnings } = await readSelection(choice);
  if (!conversations.length) throw new Error('Nothing matches this selection. Run /optchat:import scan first.');
  const memory = readMemory(dir);
  try {
    const { added, skipped } = deduplicate(memory.root, entries);
    if (!added.length) return `Nothing new to import (${skipped} messages already present).`;
    const mode: ImportMode = choice.mode ?? 'append', config = loadConfig(dir);
    const affected = mode === 'rebuild' ? [...memory.root, ...added] : added, inputBytes = affected.reduce((n, e) => n + bytes(e.text), 0);
    let nodes = 0;
    for (let n = memory.root.length + added.length; n > 0; n = Math.floor(n / 2)) nodes += n;
    if (mode === 'append') nodes -= memory.tree.size;
    const preview = [`${name} · ${mode}${memory.root.length && !choice.mode ? ' (or --mode rebuild: regenerate the whole tree by conversation start date)' : ''}`,
      choice.source === 'claude-memory' ? 'Each memory file as one dated historical note; MEMORY.md indexes excluded.' : 'Historical user messages and final replies; tool activity excluded.',
      `${conversations.length} ${choice.source === 'claude-memory' ? 'memories' : 'conversations'} selected · ${added.length} new · ${skipped} duplicates skipped`,
      `${(inputBytes / 1_000_000).toFixed(1)} MB text to index (~${Math.ceil(inputBytes / 4).toLocaleString()} source tokens; rough estimate)`,
      `Compactor: ${config.compactor.model} (${config.compactor.thinking}). Up to ${nodes} new summary nodes; small nodes need no model call. A big import costs about 3x the source tokens in compactor input.`,
      ...warnings.length ? [`${warnings.length} source issues are skipped: ${warnings.slice(0, 3).join(' | ')}`] : [],
      'Chatting in this profile pauses until the import completes or is discarded. The previous memory is kept.'];
    if (!start) return `${preview.join('\n')}\n\nStart it with the same flags: /optchat:import start …`;
    await memory.close();
    const unlock = await takeProfile(dir);
    try {
      // Read again under the lock, with everything the inbox held, so nothing logged meanwhile is left behind.
      const current = readMemory(dir);
      try { if (!prepareImport(dir, current, entries, mode)) return 'Nothing new to import.'; }
      finally { await current.close(); }
    } finally { await unlock(); }
    spawnImport(dir);
    return `${preview.join('\n')}\n\nImport started in the background. Follow it with /optchat:import status; pause with /optchat:import pause.`;
  } finally { await memory.close(); }
}

/** Stops the profile's worker and takes its lock, as Pi needed the profile idle before an import. */
async function takeProfile(dir: string) {
  const worker = workerStatus(dir);
  if (worker) try { process.kill(worker.pid, 'SIGTERM'); } catch {}
  for (const until = Date.now() + 60_000; ;) {
    try { return await lockProfile(dir, `OptChat import · PID ${process.pid} · ${hostname()}`); }
    catch (error) { if (!(error instanceof ProfileBusyError) || Date.now() > until) throw error; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
const importPid = (dir: string) => join(dir, 'imports', 'runner.pid');
const progressFile = (dir: string) => join(dir, 'imports', 'progress.json');
const script = fileURLToPath(import.meta.url);
function runnerAlive(dir: string) {
  try { const pid = Number(readFileSync(importPid(dir), 'utf8')); process.kill(pid, 0); return pid; } catch { return undefined; }
}
function spawnImport(dir: string) {
  if (runnerAlive(dir)) return;
  spawn(process.execPath, [script, 'import-run', dir], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env }).unref();
}
async function importRun(dir: string) {
  const unlock = await takeProfile(dir), controller = new AbortController();
  writeFileSync(importPid(dir), String(process.pid));
  const stop = () => controller.abort();
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  const config = () => loadConfig(dir);
  try {
    await runImport(dir, createCompressor(() => config().compactor, () => config().summaryAcceptBytes), controller.signal, config().importJobs,
      progress => atomicWrite(progressFile(dir), JSON.stringify({ ...progress, at: new Date().toISOString() })));
    atomicWrite(progressFile(dir), JSON.stringify({ done: true, at: new Date().toISOString() }));
  } catch (error) {
    atomicWrite(progressFile(dir), JSON.stringify({ paused: true, error: controller.signal.aborted ? undefined : errorText(error), at: new Date().toISOString() }));
  } finally {
    rmSync(importPid(dir), { force: true }); await unlock();
    if (!pendingImport(dir)) ensureWorker(dir);
  }
}
function importStatus(dir: string) {
  const job = pendingImport(dir), running = runnerAlive(dir);
  let progress: Record<string, unknown> = {};
  try { progress = JSON.parse(readFileSync(progressFile(dir), 'utf8')); } catch {}
  if (!job) return progress.done ? 'The last import finished.' : 'No import pending.';
  return [`${job.mode} import · ${job.added} new messages · ${running ? 'running' : 'paused'}`,
    ...typeof progress.messages === 'number' ? [`${progress.messages}/${progress.total} messages indexed · ${progress.summaries} summary nodes`] : [],
    ...progress.error ? [`Last error: ${String(progress.error)}`] : [],
    running ? 'Pause with /optchat:import pause.' : 'Resume with /optchat:import resume, or drop it with /optchat:import discard.'].join('\n');
}
async function importCommand(args: string[]) {
  const [step = 'status', ...rest] = args;
  if (step === 'scan') return importScan(rest);
  if (step === 'plan' || step === 'start') return importPlan(rest, step === 'start');
  const { dir } = active();
  if (step === 'status') return importStatus(dir);
  if (step === 'resume') { if (!pendingImport(dir)) return 'No import pending.'; spawnImport(dir); return 'Import resumed in the background. /optchat:import status follows it.'; }
  if (step === 'pause') { const pid = runnerAlive(dir); if (!pid) return 'No import is running.'; process.kill(pid, 'SIGTERM'); return 'Pausing; progress is kept. /optchat:import resume continues it.'; }
  if (step === 'discard') {
    if (runnerAlive(dir)) throw new Error('Pause the import first: /optchat:import pause.');
    const unlock = await takeProfile(dir);
    try { discardImport(dir); } finally { await unlock(); }
    ensureWorker(dir);
    return 'Discarded the staged import. The original memory is unchanged.';
  }
  throw new Error('Use /optchat:import [scan|plan|start|status|pause|resume|discard].');
}

export async function run(argv: string[]): Promise<string> {
  const [command = '', ...args] = argv;
  switch (command) {
    case '': case 'status': return status();
    case 'profile': return profile(args);
    case 'settings': return settings(args);
    case 'model': return model(args);
    case 'activity': return activity();
    case 'instructions': { const { name, dir } = active(); return `${name}'s instructions are in ${join(dir, 'AGENTS.md')} (applies from the next session or /clear):\n\n${instructions(dir)}`; }
    case 'browse': return browse();
    case 'import': return importCommand(args);
    case 'import-run': await importRun(args[0]); return '';
    default: throw new Error('Use /optchat:[status|profile|settings|model|activity|instructions|browse|import].');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // Claude Code passes the command's arguments as one string; split it like a shell would for quoted words.
  const argv = process.argv.length === 3 ? (process.argv[2].match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(a => a.replace(/^(["'])(.*)\1$/, '$2')) : process.argv.slice(2);
  run(argv).then(text => { if (text) process.stdout.write(text + '\n'); process.exit(0); },
    error => { process.stdout.write(`OptChat: ${errorText(error)}\n`); process.exit(1); });
}
