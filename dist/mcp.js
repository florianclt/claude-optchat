import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadConfig, profilePath } from "./profiles.js";
import { readMemory, resolveProfile } from "./runtime.js";
import { callTool, TOOLS } from "./tools.js";
import { record } from "./cache.js";
/** The memory tools (zoom, date, search) as a stdio MCP server, the way Claude Code takes tools from a plugin. It reads the
 * profile afresh on each call and never writes it. Written against the protocol directly so the plugin needs no packages. */
const VERSION = '2025-06-18';
const profile = () => {
    const name = resolveProfile(process.env.CLAUDE_CODE_SESSION_ID, false);
    if (!name)
        throw new Error('No OptChat profile is active in this session. Choose one with /optchat:profile <name>.');
    return { name, dir: profilePath(name) };
};
function tools() {
    let search = false;
    try {
        search = loadConfig(profile().dir).memorySearch;
    }
    catch { }
    return TOOLS.filter(tool => tool.name !== 'search' || search);
}
export async function respond(message) {
    const { id, method } = message, params = record(message.params) ? message.params : {};
    if (id === undefined)
        return undefined; // A notification.
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    switch (method) {
        case 'initialize':
            return reply({ protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : VERSION,
                capabilities: { tools: {} }, serverInfo: { name: 'optchat', version: '0.1.0' } });
        case 'ping': return reply({});
        case 'tools/list': return reply({ tools: tools() });
        case 'tools/call': {
            const name = String(params.name), args = record(params.arguments) ? params.arguments : {};
            try {
                const { dir } = profile(), memory = readMemory(dir);
                try {
                    return reply({ content: await callTool(memory, name, args, { search: loadConfig(dir).memorySearch }) });
                }
                finally {
                    await memory.close();
                }
            }
            catch (error) {
                return reply({ content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true });
            }
        }
        default: return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${String(method)}` } };
    }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const lines = createInterface({ input: process.stdin });
    let queue = Promise.resolve();
    lines.on('line', line => {
        if (!line.trim())
            return;
        queue = queue.then(async () => {
            let message;
            try {
                message = JSON.parse(line);
            }
            catch {
                process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
                return;
            }
            const out = record(message) ? await respond(message) : undefined;
            if (out)
                process.stdout.write(JSON.stringify(out) + '\n');
        });
    });
    lines.on('close', () => { void queue.then(() => process.exit(0)); });
}
