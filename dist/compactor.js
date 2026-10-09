import { spawn } from 'node:child_process';
import { COMPACT, compaction, IMPORT_GUIDANCE, tooLong } from "./prompts.js";
import { bytes, NODE } from "./memory.js";
import { record } from "./cache.js";
/** Claude Code's effort levels. Pi's `off` and `minimal` have no counterpart, so they ask for the least. */
export const effortFor = (thinking) => thinking === 'off' || thinking === 'minimal' ? 'low' : thinking;
/** Set in every Claude Code process OptChat starts, so its own hooks stay out of them. */
export const CHILD = 'OPTCHAT_CHILD';
const TIMEOUT_MS = 5 * 60_000;
/** One single-turn request through the `claude` command, so summaries use the login Claude Code already has: no tools, no
 * MCP servers, no settings, no CLAUDE.md or auto-memory, and nothing saved as a session. */
export async function ask(choice, system, prompt, signal) {
    signal.throwIfAborted();
    const args = ['-p', '--model', choice.model, '--effort', effortFor(choice.thinking), '--system-prompt', system, '--tools', '',
        '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence', '--output-format', 'json'];
    const env = { ...process.env, [CHILD]: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
    const child = spawn(process.env.OPTCHAT_CLAUDE ?? 'claude', args, { env, stdio: ['pipe', 'pipe', 'pipe'], signal, timeout: TIMEOUT_MS, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', data => { out += data; });
    child.stderr.on('data', data => { err += data; });
    child.stdin.on('error', () => { });
    child.stdin.end(prompt);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    let result;
    try {
        result = JSON.parse(out);
    }
    catch {
        throw new Error(`claude exited ${code}: ${(err || out).trim().slice(0, 500) || 'no output'}`);
    }
    if (!record(result) || result.is_error === true || typeof result.result !== 'string')
        throw new Error(`claude: ${record(result) && typeof result.result === 'string' ? result.result : (err || out).trim().slice(0, 500)}`);
    return { text: result.result, usage: result.usage, costUSD: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : undefined };
}
/** The model is asked for 512 bytes; `accepted` is the longest line kept without a retry (the profile's summary size tolerance).
 * Pi sent the "Too long" retry as a further turn of the same conversation; one `claude -p` call is one turn, so the retry
 * repeats the request with the rejected line quoted before the recipe's retry text. */
export function createCompressor(choice, accepted, onReply = () => { }, call = ask) {
    return async (input, signal) => {
        const step = `${input.historical ? IMPORT_GUIDANCE + '\n\n' : ''}${compaction(input)}`;
        const request = `${input.context}\n\n${step}`, tries = [];
        let prompt = request;
        for (let attempt = 0; attempt < 5; attempt++) {
            const reply = await call(choice(), COMPACT, prompt, signal);
            onReply(reply);
            // The compactions' view shows each line under its id+n| head, which a line can copy.
            const line = reply.text.trim().replace(/^\d+\+\d+\|\s*/, '');
            if (!line)
                throw new Error('Compactor returned no text.');
            tries.push(line);
            // A merge of two short lines can come back nearly as big as both, so a line must also shrink what it replaces.
            if (bytes(line) <= accepted() && bytes(line) < bytes(input.source))
                break;
            const cut = Buffer.from(line).subarray(0, NODE).toString('utf8').replace(/�$/, '');
            prompt = `${request}\n\nYour line was:\n${line}\n\n${tooLong(bytes(line), cut)}`;
        }
        return tries.reduce((a, b) => bytes(a) <= bytes(b) ? a : b);
    };
}
