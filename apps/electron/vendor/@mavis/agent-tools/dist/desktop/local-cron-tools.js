import { defineRuntimeTool } from '@mavis/agent-core/tools';
import { Value } from '@sinclair/typebox/value';
import { cronCommand, cronToolDefinitions, cronToolFailure, LocalSelfReminderToolDef, } from '../cron/tool-defs.js';
import { DESKTOP_MANAGEMENT_MAX_TOKENS, currentLocalCronModel, dispatchLocalMavis, limitLocalManagementOutput, } from './local-mavis.js';
export function buildLocalCronTools(deps) {
    const crud = cronToolDefinitions('cron_id').map((def) => defineRuntimeTool({
        ...def,
        execute: async (ctx, input, signal) => {
            try {
                const command = cronCommand(def.name, input, 'cron_id');
                const { view: _view, ...args } = input;
                // Never use truthiness here: the string "false" must pause, not resume.
                if (args.enabled === 'true' || args.enabled === 'false') {
                    args.enabled = args.enabled === 'true';
                }
                if (def.name === 'cron_create' && typeof args.model === 'string') {
                    const resolution = await deps.cronAdapter.resolveModel?.({ model: args.model, sessionId: ctx.sessionId }, signal);
                    if (!resolution || resolution.kind !== 'resolved') {
                        const text = JSON.stringify({
                            ok: false,
                            error: {
                                code: 'CRON_MODEL_RESOLUTION_REQUIRED',
                                ...(resolution ?? { kind: 'not_found' }),
                            },
                        });
                        return {
                            tool_name: def.name,
                            text,
                            content: [{ type: 'text', text }],
                            isError: true,
                        };
                    }
                    args.model = resolution.model;
                }
                const output = await dispatchLocalMavis({
                    agentAdapter: deps.agentAdapter,
                    cronAdapter: deps.cronAdapter,
                    sessionAdapter: deps.sessionAdapter,
                    currentAgentName: ctx.agentName,
                    currentSessionId: ctx.sessionId,
                    currentModel: currentLocalCronModel(ctx),
                }, command, args, signal);
                const recovery = 'Use mcp_invoke with cron_read and a smaller limit or exact task ID. Do not repeat successful creation or updates.';
                const limited = limitLocalManagementOutput(ctx, JSON.stringify(output), output, def.name, recovery);
                const text = limited.text;
                return {
                    tool_name: def.name,
                    text,
                    content: [{ type: 'text', text }],
                    details: {
                        command,
                        output,
                        ...(limited.truncated
                            ? {
                                desktop_output_truncation: {
                                    truncated: true,
                                    has_more: true,
                                    strategy: 'head_tail_tokens',
                                    original_estimated_tokens: limited.originalTokens,
                                    returned_estimated_tokens: limited.returnedTokens,
                                    max_tokens: DESKTOP_MANAGEMENT_MAX_TOKENS,
                                },
                            }
                            : {}),
                    },
                    ...(output.ok ? {} : { isError: true }),
                };
            }
            catch (error) {
                return cronToolFailure(def.name, error instanceof Error ? error.message : String(error));
            }
        },
    }));
    return [
        ...crud,
        defineRuntimeTool({
            ...LocalSelfReminderToolDef,
            execute: async (ctx, args, signal) => {
                if (!Value.Check(LocalSelfReminderToolDef.schema, args))
                    return cronToolFailure('self_reminder', 'Invalid self_reminder arguments.');
                const adapter = deps.cronAdapter;
                try {
                    let response;
                    if (args.action === 'cancel') {
                        if (args.delay_seconds !== undefined || args.prompt !== undefined)
                            return cronToolFailure('self_reminder', 'cancel accepts only action.');
                        if (!adapter.cancelSelfReminder)
                            return cronToolFailure('self_reminder', 'Self reminders are unavailable on this host.', 'SELF_REMINDER_UNAVAILABLE');
                        response = await adapter.cancelSelfReminder({ sessionId: ctx.sessionId }, signal);
                    }
                    else {
                        if (!args.prompt?.trim())
                            return cronToolFailure('self_reminder', 'prompt is required for set.');
                        if (args.delay_seconds === undefined)
                            return cronToolFailure('self_reminder', 'delay_seconds is required for set.');
                        if (!ctx.agentName || !ctx.toolCallId || !ctx.turnId)
                            return cronToolFailure('self_reminder', 'Current agent and complete creation provenance are required.');
                        if (!adapter.setSelfReminder)
                            return cronToolFailure('self_reminder', 'Self reminders are unavailable on this host.', 'SELF_REMINDER_UNAVAILABLE');
                        response = await adapter.setSelfReminder({
                            sessionId: ctx.sessionId,
                            turnId: ctx.turnId,
                            toolCallId: ctx.toolCallId,
                            agentName: ctx.agentName,
                            model: currentLocalCronModel(ctx),
                            project: deps.workspaceRoot,
                            prompt: args.prompt,
                            delaySeconds: args.delay_seconds,
                        }, signal);
                    }
                    const text = JSON.stringify({ ok: true, response });
                    return {
                        tool_name: 'self_reminder',
                        text,
                        content: [{ type: 'text', text }],
                        details: { output: { ok: true, response } },
                    };
                }
                catch (error) {
                    return cronToolFailure('self_reminder', error instanceof Error ? error.message : String(error), error instanceof Error && 'code' in error && typeof error.code === 'string'
                        ? error.code
                        : 'SELF_REMINDER_FAILED');
                }
            },
        }),
    ];
}
//# sourceMappingURL=local-cron-tools.js.map