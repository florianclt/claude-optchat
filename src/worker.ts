import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Memory } from './memory.ts';
import { createCompressor } from './compactor.ts';
import { loadConfig, lockProfile, ProfileBusyError } from './profiles.ts';
import { memoryDirectory, pendingImport } from './import/job.ts';
import { checkpoint } from './checkpoint.ts';
import { ingest, pending } from './runtime.ts';
import { atomicWrite } from './store.ts';

/** The one process that writes a profile's memory, as Pi's own process was: it takes the inbox into the log, builds the
 * summary tree with the compactor, and commits the profile folder. It holds the profile's lock, starts when a hook needs it,
 * and exits once there is nothing left to do, so no daemon stays behind. */
const POLL_MS = 500;
/** Nothing new and nothing to build: leave after this. With only failing summaries left, wait longer for a retry to work. */
const IDLE_MS = 60_000, FAILING_MS = 10 * 60_000;
const CHECKPOINT_MS = 5_000;

export const workerScript = fileURLToPath(new URL('./worker.js', import.meta.url));
const pidFile = (dir: string) => join(dir, 'worker.pid');
const statusFile = (dir: string) => join(dir, 'worker.json');
export interface WorkerStatus { pid: number; messages: number; pending: number; building: number; done: number; total: number; lastError?: string; at: string }

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
/** Starts the worker unless one is running. A second one started at the same moment finds the lock taken and leaves. */
export function ensureWorker(dir: string) {
  if (process.env.OPTCHAT_NO_WORKER) return; // Tests.
  try { const pid = Number(readFileSync(pidFile(dir), 'utf8')); if (pid && alive(pid)) return; } catch {}
  if (!existsSync(workerScript)) return;
  const child = spawn(process.execPath, [workerScript, dir], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
  child.unref();
}
export function workerStatus(dir: string): WorkerStatus | undefined {
  try {
    const status = JSON.parse(readFileSync(statusFile(dir), 'utf8')) as WorkerStatus;
    return alive(status.pid) ? status : undefined;
  } catch { return undefined; }
}

export async function runWorker(dir: string) {
  const log = (text: string) => {
    const file = join(dir, 'worker.log');
    try { if (existsSync(file) && statSync(file).size > 1_000_000) rmSync(file); appendFileSync(file, `${new Date().toISOString()} ${text}\n`); } catch {}
  };
  let unlock: () => Promise<void>;
  try { unlock = await lockProfile(dir, `OptChat worker · PID ${process.pid} · ${hostname()}`); }
  catch (error) { if (error instanceof ProfileBusyError) return; throw error; }
  writeFileSync(pidFile(dir), String(process.pid));
  let memory: Memory | undefined, stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  try {
    // An import holds the lock while it runs; a paused one waits for /optchat:import, and the inbox waits with it.
    if (pendingImport(dir)) { log('An import is paused; not summarizing until it is resumed or discarded.'); return; }
    const config = () => loadConfig(dir);
    memory = await Memory.open(memoryDirectory(dir), createCompressor(() => config().compactor, () => config().summaryAcceptBytes), log);
    const m = memory, receipts = new Set(m.root.map(e => e.receipt));
    log(`Started on ${m.root.length} messages.`);
    let lastWork = Date.now(), built = m.tree.size, changed = false, lastCheckpoint = 0, checkpointing: Promise<void> | undefined;
    m.onChange(() => { changed = true; });
    for (;;) {
      for (const batch of pending(dir, log)) {
        if (ingest(m, batch.entries, receipts)) changed = true;
        rmSync(batch.file, { force: true });
        lastWork = Date.now();
      }
      const { done, total } = m.progress();
      const status: WorkerStatus = { pid: process.pid, messages: m.root.length, pending: m.pending, building: m.active, done, total, lastError: m.lastError, at: new Date().toISOString() };
      try { atomicWrite(statusFile(dir), JSON.stringify(status)); } catch {}
      if (m.tree.size !== built) { built = m.tree.size; lastWork = Date.now(); }
      if (changed && !checkpointing && Date.now() - lastCheckpoint > CHECKPOINT_MS) {
        changed = false; lastCheckpoint = Date.now();
        checkpointing = checkpoint(dir).catch(error => log(`Checkpoint failed: ${error instanceof Error ? error.message : String(error)}`)).finally(() => { checkpointing = undefined; });
      }
      const idle = Date.now() - lastWork, settled = total === 0 && !m.active;
      if (stopping || settled && idle > IDLE_MS || idle > FAILING_MS) break;
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
    await checkpointing;
  } finally {
    await memory?.close();
    // The inbox may have grown while closing; the next worker takes it.
    try { await checkpoint(dir); } catch {}
    try { rmSync(statusFile(dir), { force: true }); if (readFileSync(pidFile(dir), 'utf8') === String(process.pid)) rmSync(pidFile(dir)); } catch {}
    await unlock();
    log('Stopped.');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2];
  if (!dir) { process.stderr.write('usage: worker.js <profile directory>\n'); process.exit(2); }
  runWorker(dir).then(() => process.exit(0), error => {
    try { appendFileSync(join(dir, 'worker.log'), `${new Date().toISOString()} ${error instanceof Error ? error.stack : String(error)}\n`); } catch {}
    process.exit(1);
  });
}
