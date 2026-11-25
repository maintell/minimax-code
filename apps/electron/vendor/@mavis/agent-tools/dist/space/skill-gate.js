/** Matches the `name` in the space SKILL.md frontmatter. */
export const SPACE_SKILL_NAME = 'space';
/**
 * Session-scoped record of which skills were read, so the space_* tools can require the space
 * skill once per session instead of once per turn.
 *
 * In-process only: a restart or a recycled cloud sandbox starts empty and the next call asks for
 * the skill again. That fails safe — the skill body is still in the restored message history, so
 * re-reading it is cheap, while never skipping it is the point of the gate.
 */
export class SpaceSkillLoads {
    bySession = new Map();
    mark(sessionId, skill) {
        const name = skill.trim();
        if (!sessionId || !name)
            return;
        const loaded = this.bySession.get(sessionId) ?? new Set();
        loaded.add(name);
        this.bySession.set(sessionId, loaded);
    }
    has(sessionId, skill) {
        return this.bySession.get(sessionId)?.has(skill) ?? false;
    }
    forget(sessionId) {
        this.bySession.delete(sessionId);
    }
    clear() {
        this.bySession.clear();
    }
}
/**
 * Process-wide store. Tool registries are rebuilt per turn and per workspace root, so the record
 * has to outlive one registry; a restarted process loses it and the next space_* call asks for
 * the skill again.
 */
export const sharedSpaceSkillLoads = new SpaceSkillLoads();
/** What both hosts pass to buildSpaceTools when they register a `skill` tool. */
export const sharedSpaceSkillGate = {
    skillName: SPACE_SKILL_NAME,
    loads: sharedSpaceSkillLoads,
};
/**
 * Wrap one `skill` tool so a successful read of the tracked skill is recorded for the session.
 *
 * Per tool, not per array: the cloud registry rebinds a fresh skill tool for an independent
 * workspace root, and an array-level wrap applied at build time would be dropped by that rebind.
 * Same shape as withHostSkillContracts — only `impl` is replaced, everything else passes through.
 */
export function trackSpaceSkillLoads(tool, loads = sharedSpaceSkillLoads, skillName = SPACE_SKILL_NAME) {
    if (tool.def.name !== 'skill')
        return tool;
    const inner = tool.impl;
    const impl = {
        async execute(ctx, input, signal, onUpdate) {
            const result = await inner.execute(ctx, input, signal, onUpdate);
            const details = result.details;
            if (!result.isError &&
                details?.kind === 'skill' &&
                details.found === true &&
                details.readable === true &&
                details.skill === skillName) {
                loads.mark(ctx.sessionId, skillName);
            }
            return result;
        },
    };
    return { ...tool, impl };
}
/**
 * The result a gated tool returns instead of running. A plain result, not a tool error: the call
 * did nothing, and the text says so together with the exact next step.
 */
export function spaceSkillRequiredResult(toolName, skillName) {
    const text = `${toolName} did not run: the "${skillName}" skill is not loaded in this session. ` +
        `Call the skill tool with name "${skillName}" first, then call ${toolName} again. ` +
        'Nothing was read and nothing in Space changed.';
    return {
        tool_name: toolName,
        text,
        content: [{ type: 'text', text }],
        details: { ok: false, code: 'SKILL_REQUIRED', skill: skillName },
    };
}
//# sourceMappingURL=skill-gate.js.map