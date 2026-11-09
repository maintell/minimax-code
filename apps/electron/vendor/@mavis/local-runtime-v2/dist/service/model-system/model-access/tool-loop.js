import { createHash } from 'node:crypto';
import { readPtcToolCallRecords } from '@mavis/agent-core/tools';
import { resolveLocalRuntimeLocale } from '../../../infra/config/locale.js';
/**
 * A model looping across turns: it asks for the same tool call, the agent runs it and sends the
 * same result back, and the model asks for it again (Codex Desktop on WorkBuddy's deepseek read
 * the same code 308 times in half an hour). The loop is in the request itself: its newest turns
 * are the same calls with the same arguments answered with the same results. Ported in part from
 * an MIT-licensed project; see THIRD_PARTY_NOTICES.md.
 *
 * Only the turn's end is read. A turn that got a different result (a poll whose answer moved, a
 * file that changed) is progress and starts the count again, as does anything the user says.
 * @internal Exported for focused tests.
 */
export const TOOL_LOOP_REPEATS = 8;
/**
 * Tools whose same answer, asked again, is waiting rather than a loop: a background task or
 * sub-agent queried or read while it still runs says the same until it moves on. A run_code
 * program (PTC) that called only these tools polls too.
 */
const POLLING_TOOLS = new Set(['task_query', 'task_output']);
/** How many of the newest messages are read for a loop. */
const TAIL = 8 * TOOL_LOOP_REPEATS;
/** What an agent's result says of the run, which differs every time the same command runs. */
const RUN_NOISE = [
    ['Wall time', /^(Wall time:? )[0-9.]+( seconds?)/gmu, '$1#$2'],
    ['Chunk ID: ', /^(Chunk ID: )\S+/gmu, '$1#'],
    ['"duration_seconds"', /("duration_seconds"\s*:\s*)[0-9.eE+-]+/gu, '$1#'],
];
function steadyResult(s) {
    let out = s;
    for (const [mark, re, rep] of RUN_NOISE)
        if (out.includes(mark))
            out = out.replace(re, rep);
    return out;
}
/** Arguments with object keys in sorted order, so key order never hides a repeat. */
function sortedKeys(v) {
    if (Array.isArray(v))
        return v.map(sortedKeys);
    if (!v || typeof v !== 'object')
        return v;
    const record = v;
    return Object.fromEntries(Object.keys(record)
        .sort()
        .map((k) => [k, sortedKeys(record[k])]));
}
function steadyArgs(args) {
    const sort = sortedKeys;
    try {
        return JSON.stringify(sort(typeof args === 'string' ? JSON.parse(args) : args));
    }
    catch {
        return String(args);
    }
}
function partText(p) {
    if (!p || typeof p !== 'object')
        return '';
    const part = p;
    if (part.type === 'text')
        return String(part.text ?? '');
    if (part.type === 'image')
        return `image\0${String(part.data ?? '').length}`;
    return '';
}
function textOf(content) {
    if (typeof content === 'string')
        return content;
    return Array.isArray(content) ? content.map(partText).join('\n') : '';
}
function callsOf(asked) {
    if (asked.role !== 'assistant')
        return [];
    const calls = [];
    for (const p of asked.content)
        if (p.type === 'toolCall')
            calls.push({ id: p.id, name: p.name, args: steadyArgs(p.arguments) });
    return calls;
}
/** What the agent sent back: tool results by call id, and anything the user said. */
function repliesOf(said) {
    const results = new Map();
    const rest = [];
    for (const m of said) {
        if (m.role === 'toolResult') {
            const got = results.get(m.toolCallId) ?? [];
            got.push(`${m.isError ? 'error\0' : ''}${steadyResult(textOf(m.content))}`);
            results.set(m.toolCallId, got);
        }
        else if (m.role === 'user')
            rest.push(`text\0${textOf(m.content)}`);
    }
    return { results, rest };
}
/**
 * A call that only waits: a polling tool, or a run_code program whose every tool call — read from
 * the host's PTC envelope on its result, never from the program text — was one.
 */
function polls(call, said) {
    const name = call.name.toLowerCase();
    if (POLLING_TOOLS.has(name))
        return true;
    if (name !== 'run_code')
        return false;
    const result = said.find((m) => m.role === 'toolResult' && m.toolCallId === call.id);
    const children = result ? readPtcToolCallRecords(result) : [];
    return (children.length > 0 &&
        children.every((child) => POLLING_TOOLS.has(child.tool_name.toLowerCase())));
}
/** One turn: the assistant's calls, then the results (and anything else) the agent sent back. */
function exchangeOf(asked, said) {
    const calls = callsOf(asked);
    // A turn of polls only is waiting: it neither counts nor lets older turns count across it.
    if (!calls.length || calls.every((c) => polls(c, said)))
        return undefined;
    const { results, rest } = repliesOf(said);
    if (!results.size)
        return undefined;
    const keys = calls.map((c) => {
        const got = results.get(c.id) ?? [];
        results.delete(c.id);
        return `${c.name}\0${c.args}\0${got.join('\x01')}`;
    });
    for (const got of results.values())
        keys.push(`\0\0${got.join('\x01')}`);
    keys.sort();
    const h = createHash('sha256');
    for (const k of keys)
        h.update(k).update('\xff');
    for (const k of rest)
        h.update(k).update('\xfe');
    return { sum: h.digest('hex'), calls };
}
/** The turns of tool use the conversation ends in, oldest first. */
function exchanges(messages) {
    const tail = messages.slice(-TAIL);
    const out = [];
    let i = tail.length - 1;
    while (i >= 0) {
        const said = [];
        while (i >= 0 && tail[i].role !== 'assistant')
            said.unshift(tail[i--]);
        if (i < 0 || !said.length)
            break;
        const e = exchangeOf(tail[i], said);
        if (!e)
            break;
        out.push(e);
        i--;
    }
    return out.reverse();
}
/** The loop the conversation ends in, when its last TOOL_LOOP_REPEATS turns are one exchange. */
export function toolLoopOf(context) {
    const turns = exchanges(context.messages);
    if (turns.length < TOOL_LOOP_REPEATS)
        return undefined;
    const last = turns[turns.length - 1];
    let n = 0;
    for (let i = turns.length - 1; i >= 0 && turns[i].sum === last.sum; i--)
        n++;
    return n >= TOOL_LOOP_REPEATS ? { turns: n, calls: last.calls } : undefined;
}
/** What the user is shown as the turn's answer, in the app's language. */
export function toolLoopNotice(loop, locale = resolveLocalRuntimeLocale()) {
    const called = loop.calls
        .map((c) => `${c.name} ${c.args.length > 120 ? `${c.args.slice(0, 120)}…` : c.args}`)
        .join('; ');
    if (locale.toLowerCase().startsWith('zh'))
        return `本轮已在发给模型之前停止：智能体连续 ${loop.turns} 次调用同一个工具，结果每次都一样（${called}）。模型一直在重复这个调用，继续下去只会消耗订阅额度而没有进展。告诉智能体接下来怎么做，对话就会继续。`;
    return `This turn was stopped before it reached the model: the agent ran the same tool call ${loop.turns} times in a row and got the same result every time (${called}). The model is stuck repeating it, and each further turn would spend the subscription's allowance with no progress. Tell the agent how to go on and the conversation continues.`;
}
//# sourceMappingURL=tool-loop.js.map