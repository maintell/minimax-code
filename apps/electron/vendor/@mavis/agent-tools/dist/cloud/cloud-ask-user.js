import { defineRuntimeTool } from '@mavis/agent-core/tools';
import { LocalAskUserToolDef } from '../desktop/builtin-defs.js';
// Keep the existing questionnaire schema and provider argument normalization.
export const CloudAskUserToolDef = {
    ...LocalAskUserToolDef,
    description: LocalAskUserToolDef.description.replace('local desktop user', 'user'),
};
export function createCloudAskUserTool(adapter) {
    return defineRuntimeTool({
        ...CloudAskUserToolDef,
        async execute(ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            let result;
            try {
                result = await adapter.begin(ctx, input, signal);
            }
            catch (error) {
                if (signal?.aborted)
                    throw error;
                // A lost response can mean the question was persisted. Never continue
                // executing the unresolved action just because its acknowledgement was lost.
                const text = 'The questionnaire could not be confirmed. Stop this turn and reconcile the pending question before continuing.';
                return {
                    tool_name: CloudAskUserToolDef.name,
                    text,
                    content: [{ type: 'text', text }],
                    isError: true,
                    terminate: true,
                };
            }
            if ('suppressed' in result) {
                const text = 'Question not asked: the user has already sent a new instruction. Follow the incoming user message instead.';
                return {
                    tool_name: CloudAskUserToolDef.name,
                    text,
                    content: [{ type: 'text', text }],
                    details: { suppressed: true, reason: result.reason, waiting_for_user: false },
                };
            }
            const text = `Questionnaire ${result.requestId} is waiting for the user. Stop this turn until the user replies.`;
            return {
                tool_name: CloudAskUserToolDef.name,
                text,
                content: [{ type: 'text', text }],
                details: {
                    request_id: result.requestId,
                    schema_version: result.schemaVersion,
                    step_count: result.stepCount,
                    waiting_for_user: true,
                },
                terminate: true,
            };
        },
    });
}
//# sourceMappingURL=cloud-ask-user.js.map