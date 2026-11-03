import { createHash } from 'node:crypto';
/** Sessions remembered per process; the least recently observed one is dropped first. */
const MAX_TRACKED_SESSIONS = 512;
const DIGEST_LENGTH = 16;
/**
 * First line of the local-only `_v2/PTC_TOOL_CALLS.md.hbs`; every template
 * inserts the section right before its `# Harness` heading.
 */
const PTC_SECTION_HEADING = '# Tool calls in this turn (PTC)';
const SECTION_END = '\n# Harness';
const baselines = new Map();
export function fingerprintPtcPrefix(prefix) {
    const runCode = prefix.tools.find((tool) => tool.def.name === 'run_code');
    const section = ptcSections(prefix.systemPrompt);
    return {
        native_catalog_sha: digest(declarations(prefix.nativeCatalog)),
        system_prompt_sha: digest(prefix.systemPrompt),
        ptc_section_sha: section === undefined ? 'none' : digest(section),
        tools_sha: digest(declarations(prefix.tools)),
        run_code_sha: runCode
            ? digest(JSON.stringify({
                description: runCode.def.description ?? '',
                parameters: runCode.def.schema ?? null,
            }))
            : 'none',
    };
}
/**
 * Remembers this Turn's fingerprint as the Session's baseline and warns when a
 * PTC output differs from the previous Turn's under the same native catalog.
 * The first Turn after a process start, a committed compaction or an eviction
 * only sets the baseline.
 */
export function comparePtcPrefix(input, logger) {
    const previous = baselines.get(input.sessionId);
    baselines.delete(input.sessionId);
    baselines.set(input.sessionId, { turnId: input.turnId, fingerprint: input.fingerprint });
    evictOldest();
    if (!previous)
        return;
    // The native catalog changed too: native mode would send a new prefix as well.
    if (previous.fingerprint.native_catalog_sha !== input.fingerprint.native_catalog_sha)
        return;
    const changed = changedParts(previous.fingerprint, input.fingerprint);
    if (changed.length === 0)
        return;
    try {
        logger?.warn?.({
            session_id: input.sessionId,
            turn_id: input.turnId,
            previous_turn_id: previous.turnId,
            source: input.source,
            changed,
        }, 'ptc prefix changed');
    }
    catch {
        // Diagnostics must not affect the Turn.
    }
}
/**
 * Drops the Session's baseline. A committed summary compaction may switch the
 * tool call mode and any committed compaction rewrites the history, so the next
 * Turn starts a new baseline; a deleted Session has no next Turn.
 */
export function resetPtcPrefixBaseline(sessionId) {
    baselines.delete(sessionId);
}
function changedParts(previous, current) {
    return [
        ...(previous.ptc_section_sha === current.ptc_section_sha ? [] : ['ptc_section']),
        ...(previous.tools_sha === current.tools_sha ? [] : ['tools']),
        ...(previous.run_code_sha === current.run_code_sha ? [] : ['run_code']),
    ];
}
/** Every PTC section in the prompt (a layered prompt may carry it more than once), joined. */
function ptcSections(systemPrompt) {
    const sections = [];
    let start = systemPrompt.indexOf(PTC_SECTION_HEADING);
    while (start >= 0) {
        const end = systemPrompt.indexOf(SECTION_END, start);
        sections.push(systemPrompt.slice(start, end < 0 ? undefined : end));
        if (end < 0)
            break;
        start = systemPrompt.indexOf(PTC_SECTION_HEADING, end);
    }
    return sections.length > 0 ? sections.join('\n') : undefined;
}
function declarations(tools) {
    return JSON.stringify(tools.map(({ def }) => ({
        name: def.name,
        description: def.description ?? '',
        parameters: def.schema ?? null,
    })));
}
function digest(value) {
    return createHash('sha256').update(value).digest('hex').slice(0, DIGEST_LENGTH);
}
function evictOldest() {
    while (baselines.size > MAX_TRACKED_SESSIONS) {
        const oldest = baselines.keys().next();
        if (oldest.done)
            return;
        baselines.delete(oldest.value);
    }
}
//# sourceMappingURL=ptc-prefix-fingerprint.js.map