import { PTC_DEFAULT_WALL_CLOCK_MS, PTC_MAX_WALL_CLOCK_MS, } from '@mavis/agent-core/tools';
import { writeLog } from '../../runner/ptc/ptc-observability.js';
import { ptcScriptInvocation } from './contracts.js';
/**
 * The optional paragraphs of run_code's description. They live here so the
 * tool itself stays within its layout budget; each one is shown only when this
 * Turn's catalog makes it true.
 */
/** Example value in the hint; any number up to PTC_MAX_WALL_CLOCK_MS works. */
export const TIMEOUT_MS_EXAMPLE = 600_000;
/**
 * Shown in the run_code description and in every wall_clock_exceeded result.
 * Says whose argument timeout_ms is: in smoke runs the model set a tools.bash
 * timeout, or put timeout_ms into the tools.bash arguments, and the program
 * still stopped at the default. A tools.bash timeout now extends the program
 * (Agent Core batch clock), within the same maximum as timeout_ms.
 *
 * Holds on every PTC Turn: a tools.bash child never moves to the background
 * (Agent Core gives program children allowBashAutoPromotion: false), even
 * where a direct call would.
 */
export const WALL_CLOCK_HINT = `A program stops after ${PTC_DEFAULT_WALL_CLOCK_MS / 1000} seconds by default. For a longer program, pass timeout_ms to run_code itself, next to code and description, e.g. { code, description, timeout_ms: ${TIMEOUT_MS_EXAMPLE} } for ${TIMEOUT_MS_EXAMPLE / 60_000} minutes (at most ${PTC_MAX_WALL_CLOCK_MS.toLocaleString('en-US')}). timeout_ms is not a tools.bash argument. A tools.bash timeout (in seconds) longer than the time left extends the program to fit it, within the same ${PTC_MAX_WALL_CLOCK_MS.toLocaleString('en-US')} ms limit. Or use run_in_background: true.`;
/**
 * What `store` and `load` do, in place of "no persistent state". Shown only
 * when this run_code really has a store. The write timing is stated because it
 * is the part a program cannot observe: a call that is stopped or times out
 * keeps nothing, so slow data collection and `store` belong in different
 * run_code calls.
 */
export const STORE_HINT = 'No wait_code. Variables do not persist between run_code calls; store(key, value, desc) keeps a JSON-serializable value for later run_code calls in this session, with an optional one-line desc of what it is for, and load(key) returns a copy, or undefined if missing. Values stored in a call are saved when it finishes, including when it throws; if it is stopped or times out they are discarded. Stored values last until the app restarts.';
/**
 * Says which child calls really overlap; the old "scheduling still follows
 * each tool policy" did not. It mirrors the runtime: each child runs by its
 * own executionMode (undeclared, as for every MCP tool, means sequential),
 * read, grep, glob and web_fetch declare parallel and bash, edit and write
 * sequential (agent-tools desktop/builtin-defs.ts), and PtcSubcallScheduler
 * runs at most maxConcurrentToolCalls at once. In a local replay of real
 * conversation prefixes this sentence, BATCH_EXAMPLE and the PTC section
 * lines together raised calls per program (no single change did alone).
 *
 * "(many at once)" instead of the scheduler limit: the user asked not to
 * state the number. In the same replay (160 prefixes x 2 samples) dropping
 * the parenthesis halved the gain in Promise.* programs (+6.9 points against
 * +13.1 with the number), while "(many at once)" matched it (+14.1; +0.9
 * against the number, interval includes 0). The limit itself is unchanged.
 */
export const PROMISE_ALL_SCHEDULING = 'Put independent calls in one Promise.all: file reads, file searches and web page fetches run at the same time (many at once), while shell commands, edits, writes and MCP tools run one at a time in call order, even inside Promise.all.';
/** Exploration-phase batching example; it calls read and grep, so it needs both. */
const BATCH_EXAMPLE = 'Batch example: const [a, b, hits] = await Promise.all([tools.read({ path: "src/a.ts" }), tools.read({ path: "src/b.ts" }), tools.grep({ pattern: "parseConfig", output_mode: "content" })]); return { a: a.output, b: b.output, hits: hits.output };';
/**
 * Leads the description because the tool description is resent with every
 * request, while the first-message reminder fades in long turns; the eval
 * model still called hidden tools directly mid-conversation. The names are
 * this run_code's own child catalog, the same list and order the catalog
 * reminder prints (buildPtcCatalog passes this array to both).
 */
export function hiddenToolsParagraph(childTools) {
    const names = childTools.map((tool) => tool.def.name);
    if (names.length === 0)
        return [];
    const one = names.length === 1;
    return [
        `In this turn ${names.join(', ')} ${one ? 'is not a top-level tool' : 'are not top-level tools'}; calling ${one ? 'it' : 'them'} directly is rejected. Call ${one ? 'it' : 'them'} only inside run_code as await tools.<name>(args).`,
    ];
}
/** BATCH_EXAMPLE only when this Turn's children include both tools it calls. */
export function batchExampleParagraph(childTools) {
    const names = new Set(childTools.map((tool) => tool.def.name));
    return names.has('read') && names.has('grep') ? [BATCH_EXAMPLE] : [];
}
/**
 * Advice, not a rule: source length is not budgeted, so nothing refuses a long
 * body. Chunking one shows progress earlier, and reading existing content from
 * a file avoids sending it again. Only shown when this Turn's children have
 * both tools it names.
 */
const LONG_BODY_ADVICE = 'For long documents, consider writing in chunks for earlier visible progress; read existing content from files instead of embedding it again.';
export function longBodyAdviceParagraph(childTools) {
    const names = new Set(childTools.map((tool) => tool.def.name));
    return names.has('read') && names.has('write') ? [LONG_BODY_ADVICE] : [];
}
/**
 * description stays required in the schema the model sees, so models keep
 * writing a title for the call. It only labels the call (the chat card title
 * and "from PTC: ..." on a child's approval card), so a call that leaves it
 * out, sends it blank or sends a non-string still runs its code instead of
 * failing validation: some models sent only code in most run_code calls and
 * none of those programs ran. Pi validates after prepareArguments, which puts
 * in one of these values. The user never sees them: the chat card and history
 * keep the model's own arguments, and executeRunCode passes no parent
 * description for them, so a child's approval card uses the child's own text.
 */
const DESCRIPTION_FALLBACKS = {
    missing: 'run_code call without a description',
    blank: 'run_code call with a blank description',
    non_string: 'run_code call with a non-string description',
};
/**
 * run_code's prepareArguments: returns the model's arguments unchanged unless
 * description needs a fallback.
 */
function fillDescription(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args))
        return args;
    const reason = missingDescriptionReason(args.description);
    return (reason ? { ...args, description: DESCRIPTION_FALLBACKS[reason] } : args);
}
/**
 * run_code's prepareArguments: fills in a missing description, then expands a
 * `path` call into the entry program. `path` and `args` are not in the schema
 * and never reach the model except through the PTC script reminder, so this
 * runs before schema validation, which then sees a valid `code`.
 *
 * The original `path` stays on the arguments, so the run can be counted as
 * `source=path` and the debug panel can show what the model asked for.
 */
export function prepareRunCode(args) {
    return expandPtcScriptInvocation(fillDescription(args));
}
/**
 * run_code's prepareArguments when saved scripts are switched off
 * (`beta.ptcScripts`, which the host reports by wiring no `scriptRoots`).
 * Only the description fallback runs, so a `path` call is left exactly as the
 * model sent it and the schema refuses it for having no `code` — the behavior
 * run_code had before script files existed.
 */
export function prepareRunCodeWithoutScripts(args) {
    return fillDescription(args);
}
/**
 * The program a `run_code({ path, args })` call runs; see the proposal. `args`
 * is embedded as a JSON string and parsed at run time, never spliced in as a
 * JS literal: a literal `{"__proto__": ...}` would set the prototype instead of
 * an own property, so the script would see other arguments than the model sent.
 */
function ptcScriptEntryCode(path, argsJson) {
    const literal = JSON.stringify(path);
    return [
        `const __m = await import(${literal});`,
        `if (typeof __m.default !== "function") throw new TypeError("run_code script needs a default export function: " + ${literal});`,
        `return await __m.default(JSON.parse(${JSON.stringify(argsJson)}));`,
    ].join('\n');
}
function expandPtcScriptInvocation(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args))
        return args;
    const record = args;
    // `path: null`, `path: ""` and a blank `path` are how a model writes
    // "no path": the call runs its own program, exactly as if `path` had been
    // left out, so sending them together with `code` is fine.
    const invocation = ptcScriptInvocation(record);
    if (invocation.kind === 'inline')
        return args;
    if (invocation.kind === 'invalid') {
        throw new Error('run_code path must be a non-empty string.');
    }
    // A real `path` and a program are two different runs; refusing the call is
    // what stops the model from believing the script ran.
    if (hasProgram(record.code)) {
        throw new Error('run_code takes either code or path, not both.');
    }
    const argsJson = ptcScriptArgsJson(record.args);
    // No size check: the entry program carries the whole of `args`, and source
    // length is not budgeted, so a large payload is refused by nothing here.
    // Writing a long body to a file and passing its path in `args` remains the
    // way to avoid resending it, and keeps a call's arguments small.
    const code = ptcScriptEntryCode(invocation.path, argsJson);
    return { ...record, code };
}
/**
 * Whether the call carries a program of its own. `code: null` is how a model
 * writes "no code", the same way `path: null` writes "no path", and a `code`
 * that is blank once trimmed says the same thing, exactly as a blank `path`
 * does in `ptcScriptInvocation`. All of these count as no program rather than
 * as a second run, so `run_code({ path, code: "" })` is a script run.
 *
 * Only the `path` branch reads this: a call without a `path` never gets here,
 * so a blank `code` on its own is still refused by the schema's `minLength`.
 */
function hasProgram(code) {
    if (code === undefined || code === null)
        return false;
    return typeof code !== 'string' || code.trim() !== '';
}
/** The literal the entry program parses; a missing `args` reaches the script as null. */
function ptcScriptArgsJson(args) {
    if (args === undefined)
        return 'null';
    try {
        return JSON.stringify(args) ?? 'null';
    }
    catch {
        throw new Error('run_code args must be JSON-serializable.');
    }
}
function missingDescriptionReason(description) {
    if (description === undefined)
        return 'missing';
    if (typeof description !== 'string')
        return 'non_string';
    return description.trim() ? undefined : 'blank';
}
/**
 * The model's own description goes to child calls as their parent description.
 * A filled-in one is no title: it is only logged, and a child's approval card
 * then uses the child's own text. The log has the fields run-code-tool.ts
 * writeRunCodeEvent gives every run_code event.
 */
export function parentDescriptionOf(context, parentToolCallId, description) {
    const reason = Object.keys(DESCRIPTION_FALLBACKS).find((key) => DESCRIPTION_FALLBACKS[key] === description);
    if (!reason)
        return { parentDescription: description };
    writeLog(context.ptcLogger, 'ptc run_code description defaulted', {
        session_id: context.sessionId,
        turn_id: context.turnId,
        parent_tool_call_id: parentToolCallId,
        reason,
    });
    return {};
}
//# sourceMappingURL=run-code-description.js.map