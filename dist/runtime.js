import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Memory, isEntry } from "./memory.js";
import { atomicWrite, FileStore } from "./store.js";
import { dataHome, lastProfile, listProfiles, profilePath } from "./profiles.js";
import { memoryDirectory } from "./import/job.js";
import { record } from "./cache.js";
/** Hooks, the MCP server and commands never write the log: they leave entries here, and the profile's worker
 * (src/worker.ts), the only writer, appends them to memory in file-name order. */
export const inboxDirectory = (dir) => join(dir, 'inbox');
let sequence = 0;
/** One file per batch, named so a sort gives arrival order: time, then process, then a counter within the process. */
export function deliver(dir, entries) {
    if (!entries.length)
        return;
    const name = `${String(Date.now()).padStart(15, '0')}-${String(process.pid).padStart(8, '0')}-${String(sequence++).padStart(6, '0')}.json`;
    atomicWrite(join(inboxDirectory(dir), name), JSON.stringify(entries));
}
const isArrival = (value) => record(value) && typeof value.receipt === 'string'
    && isEntry({ ...value, i: 0 });
/** Batches waiting in the inbox, oldest first. A damaged file is reported once and moved aside, never dropped. */
export function pending(dir, warn = () => { }) {
    const inbox = inboxDirectory(dir);
    if (!existsSync(inbox))
        return [];
    return readdirSync(inbox).filter(name => name.endsWith('.json')).sort().flatMap(name => {
        const file = join(inbox, name);
        try {
            const value = JSON.parse(readFileSync(file, 'utf8'));
            if (!Array.isArray(value) || !value.every(isArrival))
                throw new Error('not a list of entries');
            return [{ file, entries: value }];
        }
        catch (error) {
            warn(`Set aside a damaged inbox file ${file}: ${error instanceof Error ? error.message : String(error)}`);
            mkdirSync(join(dir, 'inbox-damaged'), { recursive: true, mode: 0o700 });
            try {
                atomicWrite(join(dir, 'inbox-damaged', name), readFileSync(file));
                rmSync(file);
            }
            catch { }
            return [];
        }
    });
}
/** Appends what memory doesn't hold yet; a receipt already logged is skipped, so a batch delivered twice lands once. */
export function ingest(memory, entries, receipts = new Set(memory.root.map(e => e.receipt))) {
    let added = 0;
    for (const e of entries) {
        if (receipts.has(e.receipt))
            continue;
        memory.append(e.kind, e.text, e.date, e.receipt);
        receipts.add(e.receipt);
        added++;
    }
    return added;
}
/** A store that reads the profile's files and writes nothing, for everyone but the worker. */
class ReadOnlyStore {
    files;
    constructor(files) {
        this.files = files;
    }
    load() { return this.files.load(); }
    append() { return undefined; }
    appendNode() { return undefined; }
    saveView() { return undefined; }
    putImage() { return undefined; }
    image(name) { return this.files.image(name); }
}
/** Readers never summarize: the worker does. Their builds wait until the memory closes. */
const waiting = (_input, signal) => new Promise((_resolve, reject) => {
    if (signal.aborted)
        reject(new Error('closed'));
    signal.addEventListener('abort', () => reject(new Error('closed')), { once: true });
});
/** The profile's memory as the worker will have it: what it saved, plus the inbox it hasn't taken in yet. Close it after use. */
export function readMemory(dir) {
    const directory = memoryDirectory(dir), files = new FileStore(directory, () => { }), store = new ReadOnlyStore(files);
    const memory = new Memory({ directory, store, saved: store.load() }, waiting, () => { });
    const receipts = new Set(memory.root.map(e => e.receipt));
    for (const batch of pending(dir))
        ingest(memory, batch.entries, receipts);
    return memory;
}
/** Which profile a Claude Code session uses: OPTCHAT_PROFILE, else the one the session is bound to, else the last one used.
 * 'off' (from either) means plain Claude Code. A session takes its profile on first use, so a later switch elsewhere leaves it. */
const sessionsDirectory = () => join(dataHome(), 'sessions');
const sessionFile = (session) => join(sessionsDirectory(), `${session.replace(/[^\w-]/g, '_')}.json`);
export const OFF = 'off';
export function boundProfile(session) {
    if (!session)
        return undefined;
    try {
        const value = JSON.parse(readFileSync(sessionFile(session), 'utf8'));
        return record(value) && typeof value.profile === 'string' ? value.profile : undefined;
    }
    catch {
        return undefined;
    }
}
export function bindSession(session, profile) {
    atomicWrite(sessionFile(session), JSON.stringify({ profile, bound: new Date().toISOString() }));
}
/** Session ids bound to any profile: their transcripts are already in memory, so import skips them. */
export function boundSessions() {
    const ids = new Set();
    // Bound sessions, and every session a profile has read a transcript of (OPTCHAT_PROFILE runs are never bound).
    for (const dir of [sessionsDirectory(), ...listProfiles().map(name => join(profilePath(name), 'sessions'))])
        try {
            for (const n of readdirSync(dir))
                if (n.endsWith('.json'))
                    ids.add(n.slice(0, -5));
        }
        catch { }
    return ids;
}
export function resolveProfile(session, bind = true) {
    const forced = process.env.OPTCHAT_PROFILE?.trim();
    if (forced)
        return forced === OFF ? undefined : forced;
    const bound = boundProfile(session);
    if (bound)
        return bound === OFF || !listProfiles().includes(bound) ? undefined : bound;
    const last = lastProfile();
    if (last && session && bind)
        bindSession(session, last);
    return last;
}
export const profileDirectory = (name) => profilePath(name);
