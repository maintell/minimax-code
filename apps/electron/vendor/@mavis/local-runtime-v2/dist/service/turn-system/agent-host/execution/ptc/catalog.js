const childToolsByRunCode = new WeakMap();
export function registerPtcChildTools(runCode, childTools, trustedNativeTools = []) {
    const nativeTools = new Set(trustedNativeTools);
    const evidenceSourceByTool = new Map();
    for (const tool of childTools) {
        if (nativeTools.has(tool))
            evidenceSourceByTool.set(tool, tool.source ?? 'builtin');
    }
    childToolsByRunCode.set(runCode, { childTools, evidenceSourceByTool });
    return runCode;
}
/** Evidence ownership follows the admitted object, never its name or permission source. */
export function readPtcToolEvidenceSource(runCode, tool) {
    if (!tool)
        return undefined;
    const source = childToolsByRunCode.get(runCode)?.evidenceSourceByTool.get(tool);
    return source === undefined ? undefined : { tool, source };
}
/** Returns the original final authorization snapshot behind a visible run_code tool. */
export function readPtcChildTools(tools) {
    if (!tools)
        return undefined;
    for (const tool of tools) {
        const catalog = childToolsByRunCode.get(tool);
        if (catalog)
            return catalog.childTools;
    }
    return undefined;
}
/** Full authorized snapshot for host validation; model disclosure stays separate. */
export function readAuthorizedTurnTools(visibleTools) {
    const childTools = readPtcChildTools(visibleTools);
    if (!childTools)
        return visibleTools;
    const toolsByName = new Map(visibleTools.map((tool) => [tool.def.name, tool]));
    for (const tool of childTools) {
        if (!toolsByName.has(tool.def.name))
            toolsByName.set(tool.def.name, tool);
    }
    return [...toolsByName.values()];
}
/**
 * The native task_output, the only reader of the background task store. A
 * configured or MCP namesake cannot read it. A Turn whose executable tools
 * (run_code's children on a PTC Turn) include it lets a direct Bash call move
 * to the background (executor.ts, canConsumeNativeTaskOutput); a run_code Bash
 * child never does (Agent Core gives program children
 * allowBashAutoPromotion: false).
 */
export function isNativeTaskOutputTool(tool) {
    return (tool.def.name === 'task_output' && (tool.source === undefined || tool.source === 'builtin'));
}
/**
 * The catalog's PTC reminder reaches the executor only inside the merged user
 * prompt prefix. Keeping the same string beside this Turn's run_code lets the
 * executor restore exactly that text after compaction replaced the user message,
 * without a second copy of the wording or a new assembly field.
 */
const turnReminderByRunCode = new WeakMap();
export function registerPtcTurnReminder(runCode, reminder) {
    turnReminderByRunCode.set(runCode, reminder);
    return runCode;
}
/** The reminder registered with a visible run_code; undefined on Turns without PTC. */
export function readPtcTurnReminder(tools) {
    if (!tools)
        return undefined;
    for (const tool of tools) {
        const reminder = turnReminderByRunCode.get(tool);
        if (reminder !== undefined)
            return reminder;
    }
    return undefined;
}
/**
 * The catalog this Turn lists without PTC (buildPtcCatalog's input), kept beside
 * run_code so the prefix fingerprint can tell a change PTC made from one the
 * native catalog made too (a config change the user made mid-conversation).
 */
const nativeCatalogByRunCode = new WeakMap();
export function registerPtcNativeCatalog(runCode, nativeCatalog) {
    nativeCatalogByRunCode.set(runCode, nativeCatalog);
    return runCode;
}
/** The native catalog registered with a visible run_code; undefined on Turns without PTC. */
export function readPtcNativeCatalog(tools) {
    if (!tools)
        return undefined;
    for (const tool of tools) {
        const catalog = nativeCatalogByRunCode.get(tool);
        if (catalog)
            return catalog;
    }
    return undefined;
}
/**
 * Whether this Session's current Turn can call TodoWrite only inside
 * run_code. Registered once per Turn from the same object registration every
 * other PTC consumer reads, because the Todo cadence reminder is a fixed
 * before-LLM hook that never sees this Turn's tool objects. Overwritten on
 * every Turn, so a Turn without PTC never inherits an earlier one's answer;
 * one boolean per Session, replaced rather than accumulated.
 */
const childTodoWriteBySession = new Map();
export function registerPtcTurnChildTodoWrite(sessionId, tools) {
    const childTools = readPtcChildTools(tools);
    childTodoWriteBySession.set(sessionId, childTools?.some((tool) => tool.def.name.toLowerCase() === 'todowrite') === true);
}
/** False for any Session that has not registered a Turn yet. */
export function hasPtcTurnChildTodoWrite(sessionId) {
    return childTodoWriteBySession.get(sessionId) === true;
}
//# sourceMappingURL=catalog.js.map