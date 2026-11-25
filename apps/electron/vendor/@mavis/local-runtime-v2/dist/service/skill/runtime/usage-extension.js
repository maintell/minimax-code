import { skillCatalogListing } from '@mavis/agent-tools';
import { normalizeSkillUsageKey } from '@mavis/context-manager';
import { incrementMetric } from '@mavis/shared/local-runtime-logging/metric-registry';
const SKILL_TOOL_NAME = 'skill';
function skillLoadStatus(isError, details) {
    if (isError)
        return 'error';
    if (details?.found === true && details.readable === true)
        return 'ok';
    return details?.unavailable === true ? 'unavailable' : 'not_found';
}
/**
 * Counts the model's `skill` tool loads: `skill_load_total` for every call, and one local
 * usage count for each successful load (as archon-server counts cloud loads), which ranks
 * catalog descriptions in later windows. Slash commands, Agent preloads and other reads
 * never pass through the tool, so they are not counted.
 */
export function createSkillUsageExtension(options) {
    return {
        id: 'local-skill-usage',
        description: 'Count skill tool loads for the skill catalog usage ranking and metrics.',
        init(api) {
            api.on('after_tool_call', (toolContext, _signal, turn) => {
                if (toolContext.toolCall.name !== SKILL_TOOL_NAME)
                    return undefined;
                const details = readSkillDetails(toolContext.result?.details);
                const requested = details?.skill ?? readRequestedName(toolContext.toolCall.arguments);
                const listing = requested ? skillCatalogListing(turn.sessionId, requested) : 'unlisted';
                const status = skillLoadStatus(toolContext.isError === true, details);
                incrementMetric(options.metricsClient, 'skill_load_total', 1, { status, listing });
                if (status !== 'ok' || !details)
                    return undefined;
                const key = normalizeSkillUsageKey(details.skill);
                if (key)
                    options.store.recordUse(key, options.nowMs());
                return undefined;
            });
        },
    };
}
function readSkillDetails(details) {
    if (typeof details !== 'object' || details === null)
        return undefined;
    const record = details;
    if (record.kind !== 'skill' || typeof record.skill !== 'string')
        return undefined;
    return {
        kind: 'skill',
        skill: record.skill,
        ...(typeof record.found === 'boolean' ? { found: record.found } : {}),
        ...(typeof record.readable === 'boolean' ? { readable: record.readable } : {}),
        ...(record.unavailable === true ? { unavailable: true } : {}),
    };
}
function readRequestedName(args) {
    if (typeof args !== 'object' || args === null || !('name' in args))
        return undefined;
    const name = args.name;
    return typeof name === 'string' && name.trim() ? name.trim() : undefined;
}
//# sourceMappingURL=usage-extension.js.map