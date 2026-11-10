/**
 * Renders the full content of every Skill the Agent's `skills` lists, for the
 * first user message of a Session (README "Desktop Local Agent 定义"). A Skill
 * that cannot be found or read is skipped: the Session still starts. There is
 * no size limit; one log line records the names, skip reasons and injected
 * bytes, never paths or content.
 */
export async function renderAgentSkillPreload(input) {
    const names = uniqueNames(input.names ?? []);
    if (names.length === 0)
        return '';
    const results = await Promise.all(names.map((name) => readPreloadSkill(input.readSkill, name)));
    const loaded = results.flatMap((result) => (result.kind === 'loaded' ? [result] : []));
    const text = loaded.length === 0
        ? ''
        : [
            [
                '<system-reminder>',
                `This conversation preloads these skills: ${loaded.map(({ name }) => name).join(', ')}. Their full instructions follow. Apply them when relevant; do not load them again with the skill tool.`,
                '</system-reminder>',
            ].join('\n'),
            ...loaded.map(({ name, text: skill }) => [`<preloaded-skill name="${escapeAttribute(name)}">`, skill, '</preloaded-skill>'].join('\n')),
        ].join('\n\n');
    logPreload(input, {
        requested: names.length,
        loaded: loaded.map(({ name }) => name),
        skipped: results.flatMap((result) => result.kind === 'skipped' ? [{ name: result.name, reason: result.reason }] : []),
        injectedBytes: new TextEncoder().encode(text).length,
    });
    return text;
}
async function readPreloadSkill(readSkill, name) {
    if (!readSkill)
        return { kind: 'skipped', name, reason: 'reader_unavailable' };
    try {
        const skill = await readSkill(name);
        if (!skill)
            return { kind: 'skipped', name, reason: 'not_found' };
        return { kind: 'loaded', name, text: formatSkillContent(name, skill.content, skill.location) };
    }
    catch {
        return { kind: 'skipped', name, reason: 'read_failed' };
    }
}
/** The same header the `skill` tool puts on a Skill it loads. */
function formatSkillContent(name, content, location) {
    const header = [`# Skill: ${name}`];
    if (location)
        header.push(`Location: ${location}`);
    return `${header.join('\n')}\n\n${content}`;
}
function logPreload(input, outcome) {
    try {
        input.logger?.info?.({
            event: 'agent_skill_preload',
            session_id: input.sessionId,
            ...(input.turnId ? { turn_id: input.turnId } : {}),
            ...(input.agentName ? { agent_name: input.agentName } : {}),
            requested: outcome.requested,
            loaded: outcome.loaded,
            skipped: outcome.skipped,
            injected_bytes: outcome.injectedBytes,
        }, '[local-runtime-v2] agent skill preload');
    }
    catch {
        // Diagnostics must not affect the Turn.
    }
}
function uniqueNames(values) {
    const seen = new Set();
    const names = [];
    for (const value of values) {
        const name = value.trim();
        const key = name.normalize('NFKC').toLocaleLowerCase('en-US');
        if (!name || seen.has(key))
            continue;
        seen.add(key);
        names.push(name);
    }
    return names;
}
function escapeAttribute(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}
//# sourceMappingURL=agent-skill-preload.js.map