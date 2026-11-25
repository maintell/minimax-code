import { defineRuntimeTool } from '@mavis/agent-core/tools';
import { MINIAPP_TOOL_DEFINITION } from '@mavis/agent-extension';
import { cronToolDefinitions, LocalSelfReminderToolDef } from '@mavis/agent-tools/desktop';
import { isCoordinatorAgent } from '@mavis/shared/agent-coordination';
import { CLI_REFUSAL } from '../../coordinator-text/index.js';
function applyHostedCapabilityRestrictions(capabilities, restrictions) {
    if (!restrictions.disableMavis)
        return capabilities;
    return {
        ...capabilities,
        features: {
            ...capabilities.features,
            mavis: false,
        },
    };
}
/**
 * The CLI ceiling turns `mavis` off, but a coordinator still works through it:
 * the shared session and agent reads it checks a task with are the migrated
 * mavis tools behind their Skill. Its own space and task model operations are
 * top-level tools of their own (`space_*`, `task_model_*`) and do not depend on
 * this feature. Keeping it on keeps that shared vocabulary; the final catalog
 * still admits only what the coordinator's authority allows.
 */
export function resolveHostedToolCapabilities(capabilities, restrictions, coordination) {
    if (restrictions.disableMavis !== true || !isCoordinatorAgent(coordination)) {
        return applyHostedCapabilityRestrictions(capabilities, restrictions);
    }
    return { ...capabilities, features: { ...capabilities.features, mavis: true } };
}
const CLI_CRON_REFUSAL = {
    code: 'CRON_UNAVAILABLE_IN_CLI',
    message: CLI_REFUSAL.cron,
};
const CLI_MINIAPP_REFUSAL = {
    code: 'MINIAPP_UNAVAILABLE_IN_CLI',
    message: CLI_REFUSAL.miniapp,
};
/**
 * Bunny keeps its desktop tool vocabulary in the command-line runtime, but the
 * runtime has no Scheduler and no Mini App host. Each call answers with one
 * structured, user-presentable refusal instead of the tool silently
 * disappearing (MANUAL-BUG-001; Bunny P0 section 6).
 */
export function shouldExposeCliRefusals(restrictions, coordination) {
    return restrictions.disableCron === true && isCoordinatorAgent(coordination);
}
export function createCliRefusalTools() {
    return [
        ...cronToolDefinitions('cron_id').map((def) => refusalTool(def, CLI_CRON_REFUSAL)),
        refusalTool(LocalSelfReminderToolDef, CLI_CRON_REFUSAL),
        refusalTool(MINIAPP_TOOL_DEFINITION, CLI_MINIAPP_REFUSAL),
    ];
}
function refusalTool(def, error) {
    return defineRuntimeTool({
        name: def.name,
        description: def.description,
        schema: def.schema,
        // Keep the refusal discoverable for Bunny, matching its inline Cron loading.
        loading: 'default',
        execute: async () => {
            const text = JSON.stringify({ ok: false, error });
            return { tool_name: def.name, text, content: [{ type: 'text', text }], isError: true };
        },
    });
}
//# sourceMappingURL=hosted-agent-capability-restrictions.js.map