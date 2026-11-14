import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { createConsolidationWorkdirTools, } from '../../memory-system/adapters/consolidation-workdir-tools.js';
import { redactMemorySecrets } from '../../memory-system/index.js';
import { normalizeDailyBasis } from './format.js';
/**
 * The memory model's file tools over its work directory. A write is saved as written (a daily
 * `AI推断` as `AI 推断`) and then checked: what `check` reports comes back as the write's result,
 * so the model can fix it within the run (spec 3.7).
 */
export function createBunnyMemoryWorkdirTools(workDir, writable, options = {}) {
    const { source, search, check } = options;
    const tools = [
        ...createConsolidationWorkdirTools(workDir).filter((tool) => tool.name === 'list_files' || tool.name === 'read_file'),
    ];
    for (const edit of [false, true])
        tools.push({
            name: edit ? 'edit_file' : 'write_file',
            description: edit
                ? 'Replace one exact unique snippet in a writable memory file.'
                : 'Overwrite MEMORY.md or an allowed daily/<date>.md. Other files are read-only.',
            parameters: Type.Object(edit
                ? { path: Type.String(), old_string: Type.String(), new_string: Type.String() }
                : { path: Type.String(), content: Type.String() }),
            async execute(args) {
                if (typeof args.path !== 'string' || !writable.has(args.path))
                    return { text: 'File is read-only.', isError: true };
                const content = edit ? await editedContent(join(workDir, args.path), args) : args.content;
                if (content === null)
                    return { text: 'old_string must occur exactly once.', isError: true };
                if (typeof content !== 'string' || Buffer.byteLength(content) > 2 * 1024 * 1024)
                    return { text: 'Invalid content or file too large.', isError: true };
                await writeFile(join(workDir, args.path), args.path.startsWith('daily/') ? normalizeDailyBasis(content) : content);
                return (await check?.(args.path)) ?? { text: `Saved ${args.path}` };
            },
        });
    if (source)
        tools.push({
            name: 'read_message',
            description: 'Read a Bunny source message and one adjacent message on each side.',
            parameters: Type.Object({ session_id: Type.String(), msg_id: Type.String() }, { additionalProperties: false }),
            async execute(args) {
                try {
                    return { text: source.readMessage(String(args.session_id), String(args.msg_id)) };
                }
                catch (error) {
                    return { text: String(error), isError: true };
                }
            },
        });
    if (search)
        tools.push(...conversationTools(search));
    return tools;
}
/** A file with one exact unique snippet replaced, or null when it is not there exactly once. */
async function editedContent(path, args) {
    const current = await readFile(path, 'utf8');
    const { old_string: before, new_string: after } = args;
    if (typeof before !== 'string' || !before || typeof after !== 'string')
        return null;
    if (current.split(before).length !== 2)
        return null;
    return current.replace(before, after);
}
/**
 * The consolidator checks notes against the original conversation: search finds support
 * or counter-evidence, read shows a hit in context. Output is redacted like every other
 * conversation text a memory model reads.
 */
function conversationTools(search) {
    const run = (call) => {
        try {
            const sessionId = search.mainSessionId();
            if (!sessionId)
                return { text: 'No Bunny main conversation to search.', isError: true };
            const text = JSON.stringify({ session_id: sessionId, ...call(sessionId) });
            return { text: redactMemorySecrets(text).content };
        }
        catch (error) {
            return { text: String(error), isError: true };
        }
    };
    return [
        {
            name: 'conversation_search',
            description: 'Search the original text of the current Bunny main conversation. query: 2-3 distinctive words as they appear in the conversation; space-separated words must all match, OR matches any. since/until: YYYY-MM-DD. role: user, assistant or report. Returns the total, hits by month and up to 8 snippets with message IDs; next_cursor pages on. Search both for support and for counter-evidence.',
            parameters: Type.Object({
                query: Type.String({ minLength: 1, maxLength: 200 }),
                since: Type.Optional(Type.String()),
                until: Type.Optional(Type.String()),
                role: Type.Optional(Type.Union([Type.Literal('user'), Type.Literal('assistant'), Type.Literal('report')])),
                cursor: Type.Optional(Type.String()),
            }, { additionalProperties: false }),
            execute: async (args) => run((sessionId) => search.search(sessionId, {
                query: String(args.query),
                ...(typeof args.since === 'string' ? { since: args.since } : {}),
                ...(typeof args.until === 'string' ? { until: args.until } : {}),
                ...(args.role === 'user' || args.role === 'assistant' || args.role === 'report'
                    ? { role: args.role }
                    : {}),
                ...(typeof args.cursor === 'string' ? { cursor: args.cursor } : {}),
            })),
        },
        {
            name: 'conversation_read',
            description: 'Read a message of the current Bunny main conversation by message_id (from conversation_search), with up to 3 neighbours on each side. A long message returns next_offset; read on with offset. Cite it as <session_id>/<message_id>.',
            parameters: Type.Object({
                message_id: Type.String({ minLength: 1 }),
                around: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
                offset: Type.Optional(Type.Integer({ minimum: 0 })),
            }, { additionalProperties: false }),
            execute: async (args) => run((sessionId) => search.read(sessionId, {
                messageId: String(args.message_id),
                ...(typeof args.around === 'number' ? { around: args.around } : {}),
                ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
            })),
        },
    ];
}
//# sourceMappingURL=workdir-tools.js.map