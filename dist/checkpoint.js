import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from "./store.js";
const exec = promisify(execFile);
/** What the Claude Code port keeps per machine: the inbox, session cursors and the worker's files. They go in the repository's
 * own exclude file, so a profile's .gitignore stays the user's. */
const LOCAL = ['/inbox/', '/inbox-damaged/', '/sessions/', '/worker.*'];
export async function checkpoint(directory) {
    const git = (args) => exec('git', ['-C', directory, ...args], { maxBuffer: 1_000_000 });
    if (!existsSync(join(directory, '.git')))
        await git(['init', '-q', '-b', 'main']);
    if (!existsSync(join(directory, '.gitignore')))
        atomicWrite(join(directory, '.gitignore'), '/runs/\n/memory.html\n/usage.jsonl\n*.tmp\n');
    const exclude = join(directory, '.git', 'info', 'exclude'), current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    const missing = LOCAL.filter(line => !current.split('\n').includes(line));
    if (missing.length)
        atomicWrite(exclude, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
    await git(['add', '-A', '--', '.']);
    const status = await git(['diff', '--cached', '--name-only']);
    if (!status.stdout.trim())
        return;
    await git(['-c', 'user.name=OptChat', '-c', 'user.email=optchat@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Save OptChat memory']);
}
