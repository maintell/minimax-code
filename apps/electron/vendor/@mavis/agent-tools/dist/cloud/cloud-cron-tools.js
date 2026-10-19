import { defineRuntimeTool } from '@mavis/agent-core/tools';
import { cronCommand, cronToolDefinitions, cronToolFailure, LocalSelfReminderToolDef as SelfReminderToolDef, } from '../cron/tool-defs.js';
import { executeCloudSelfReminder } from './cloud-self-reminder.js';
import { dispatchDofld } from './mavis/dispatcher.js';
import { currentCloudCronModel } from './mavis/index.js';
import { toToolResult } from './mavis/output.js';
export function buildCloudCronTools(deps) {
    return [
        ...cronToolDefinitions('task_id').map((def) => defineRuntimeTool({
            ...def,
            execute: async (ctx, input, signal) => {
                try {
                    const command = cronCommand(def.name, input, 'task_id');
                    const { view: _view, ...args } = input;
                    const output = await dispatchDofld(cloudCronDeps(deps, ctx), command, args, signal);
                    return { ...toToolResult(output, def.name), ...(output.ok ? {} : { isError: true }) };
                }
                catch (error) {
                    return cronToolFailure(def.name, error instanceof Error ? error.message : String(error));
                }
            },
        })),
        defineRuntimeTool({
            ...SelfReminderToolDef,
            execute: (ctx, input, signal) => executeCloudSelfReminder(cloudCronDeps(deps, ctx), input, signal),
        }),
    ];
}
function cloudCronDeps(deps, ctx) {
    return {
        ...deps,
        sessionId: ctx.sessionId,
        toolCallId: ctx.toolCallId,
        currentModel: currentCloudCronModel(ctx),
        agentId: ctx.agentId,
        agentDisplayName: ctx.parentAgentConfig?.display_name,
        timezone: ctx.timezone,
    };
}
//# sourceMappingURL=cloud-cron-tools.js.map