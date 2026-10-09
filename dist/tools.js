import { flat, PAGE, start } from "./memory.js";
import { agentTranscript, findAgentTranscript, loadImages } from "./transcript.js";
export const SEARCH_PAGE = 20;
const SNIPPET = 200;
/** One page of hits, each with its id, the view line holding it, its date and a snippet around the first match; at most ~5 KB. */
export function searchPage(memory, text, before) {
    const hits = memory.search(text, before), older = before === undefined ? '' : 'older ';
    if (!hits.length)
        return `No ${older}messages contain "${text}".`;
    const page = hits.slice(0, SEARCH_PAGE), needle = text.toLowerCase();
    const lines = page.map(entry => {
        // Cut the original text, whose match may span lines, and flatten only the cut.
        const at = Math.max(0, entry.text.toLowerCase().indexOf(needle) - SNIPPET / 4);
        const snippet = flat(entry.text.slice(at, at + SNIPPET).replace(/^[\udc00-\udfff]|[\ud800-\udbff]$/g, ''));
        const line = memory.covering(entry.i); // Named only when the hit is inside a summary line.
        return `${entry.i}${line?.l ? ` (in ${start(line)}+${2 ** line.l})` : ''} · ${new Date(entry.date).toString().slice(0, 21)} · ${entry.kind}: ${at ? '…' : ''}${snippet}${at + SNIPPET < entry.text.length ? '…' : ''}`;
    });
    const more = hits.length > page.length ? `\nOlder matches: search again with before: ${page[page.length - 1].i}.` : '';
    return `${hits.length} ${older}${hits.length === 1 ? 'message contains' : 'messages contain'} "${text}", newest first:\n${lines.join('\n')}${more}`;
}
/** A page of a subagent's transcript, saying where the next one starts. */
export function runPage(text, offset = 0, limit = PAGE) {
    if (offset > text.length)
        throw new Error(`This transcript has ${text.length} characters; offset must be 0 to ${text.length}.`);
    // Never split a surrogate pair: a page starts on its first half and ends after its second.
    const from = /[\udc00-\udfff]/.test(text[offset] ?? '') ? offset - 1 : offset;
    let to = Math.min(text.length, from + limit);
    if (to < text.length && /[\ud800-\udbff]/.test(text[to - 1]))
        to += to - 1 === from ? 1 : -1;
    return `${text.slice(from, to)}\n[characters ${from}-${to} of ${text.length}${to < text.length ? `; go on with offset ${to}` : ''}]`;
}
const text = (t) => [{ type: 'text', text: t }];
/** The tools, as the MCP server lists them. Descriptions are Pi's. */
export const TOOLS = [
    { name: 'zoom', description: `Open the line id+n of the view into the two lines of n/2 under it; n = 1 (the default) gives the message whole. A message over ${PAGE.toLocaleString('en-US')} characters comes in pages; offset and limit (characters) read any part of it, and are not needed for a shorter one. A message's images come back with it. zoom("<agent id>") gives a subagent's whole chat, in the same pages.`,
        inputSchema: { type: 'object', properties: { id: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'string', minLength: 1 }] }, n: { type: 'integer', minimum: 1 },
                offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: PAGE } }, required: ['id'] } },
    { name: 'date', description: 'The date and time of message id.',
        inputSchema: { type: 'object', properties: { id: { type: 'integer', minimum: 0 } }, required: ['id'] } },
    { name: 'search', description: `Find the original messages that contain text (plain text, any case), newest first, ${SEARCH_PAGE} at a time; before: id continues with older ones. zoom(id, 1) gives a hit whole. Only when the profile's Memory search setting is on.`,
        inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1 }, before: { type: 'integer', minimum: 0 } }, required: ['text'] } },
];
const integer = (value, name, optional = false) => {
    if (value === undefined && optional)
        return undefined;
    if (typeof value === 'string' && /^\d+$/.test(value))
        value = Number(value);
    if (!Number.isSafeInteger(value))
        throw new Error(`${name} must be a whole number.`);
    return value;
};
/** Runs a tool against a memory, as Pi's tools did. */
export async function callTool(memory, name, args, options) {
    if (name === 'zoom') {
        const n = integer(args.n, 'n', true) ?? 1, offset = integer(args.offset, 'offset', true), limit = integer(args.limit, 'limit', true);
        const id = args.id;
        if (typeof id === 'string' && !/^\d+$/.test(id)) {
            const file = findAgentTranscript(id);
            if (!file)
                throw new Error(`No agent ${id}.`);
            return text(runPage(agentTranscript(file), offset, limit));
        }
        const page = memory.zoom(integer(id, 'id'), n, offset, limit);
        // A message's images come back with its text; summaries stay text.
        return n === 1 ? [...text(page), ...await loadImages(memory.store, page)] : text(page);
    }
    if (name === 'date')
        return text(memory.date(integer(args.id, 'id')));
    if (name === 'search') {
        if (!options.search)
            throw new Error('Memory search is off for this profile. Turn it on with /optchat:settings memorySearch true.');
        if (typeof args.text !== 'string' || !args.text)
            throw new Error('text must be a non-empty string.');
        return text(searchPage(memory, args.text, integer(args.before, 'before', true)));
    }
    throw new Error(`Unknown tool ${name}.`);
}
