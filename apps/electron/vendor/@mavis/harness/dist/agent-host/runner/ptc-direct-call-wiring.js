import { legacyMavisToolRefusal } from './policy/mavis-moved-refusal.js';
import { ptcMcpInvokeRefusalTool } from '../assembly/local-turn-tool-ptc/ptc-unavailable-tools.js';
import { prepareDirectCallArguments, withDirectCallArguments, } from './ptc/direct-call-arguments.js';
import { createDirectCallReminder, } from './ptc/direct-call-reminder.js';
/**
 * PTC-Turn wiring for direct calls of run_code children: the resolver, and the reminder
 * hook placed after every other after-tool hook so it ends the final result. Empty when
 * the Turn has no PTC.
 */
export function directPtcChildCallWiring(input, ptcTools, context, metrics) {
    if (!ptcTools)
        return {
            input: {},
            toolConfig: {
                resolveMissingTool: (toolCall) => legacyMavisToolRefusal(toolCall.name, metrics, context.coordination),
            },
        };
    const reminder = createDirectCallReminder((fields) => {
        writePtcDirectCallEvent(context, 'ptc hidden tool reminder', fields);
        context.ptcObserver?.directCallSettled(fields.tool, fields.tool_call_id, fields.appended);
    });
    return {
        input: {
            hooks: {
                ...input.hooks,
                afterToolCallHook: [...(input.hooks?.afterToolCallHook ?? []), reminder.afterToolCall],
            },
        },
        toolConfig: {
            ptcTools,
            resolveMissingTool: (toolCall) => resolveDirectPtcChildTool(toolCall, ptcTools, context, { reminder, metrics }),
        },
    };
}
/**
 * A run_code child the model called directly although the top-level catalog omits it runs
 * as that native tool, as it would with PTC off, after the argument repair in
 * `ptc/direct-call-arguments.ts`; the last such call of a reply gets the reminder of
 * `ptc/direct-call-reminder.ts`. The events name the tool, the call, the repair kinds and
 * whether the reminder was appended, never argument values or content.
 */
function resolveDirectPtcChildTool(toolCall, childTools, context, deps) {
    const { reminder, metrics } = deps;
    const tool = childTools.find((candidate) => candidate.def.name === toolCall.name);
    if (!tool) {
        // The composite `mavis` is in no Desktop catalog, so a top-level legacy
        // `mavis({ command })` call lands here with no tool. Answer it exactly as the
        // non-PTC resolver does: the moved refusal names the tool that replaced the
        // command, and a coordinator reads the assignment tool to use instead. Pi's
        // missing-tool error names neither.
        const legacy = legacyMavisToolRefusal(toolCall.name, metrics, context.coordination);
        if (legacy) {
            writePtcDirectCallEvent(context, 'ptc mavis called directly', {
                tool: toolCall.name,
                tool_call_id: toolCall.id,
            });
            return legacy;
        }
        // A PTC Turn has no gateway, so the other name left without a tool here is
        // answered with where its targets went instead of Pi's missing-tool error.
        if (toolCall.name !== 'mcp_invoke')
            return undefined;
        writePtcDirectCallEvent(context, 'ptc mcp_invoke called directly', {
            tool: toolCall.name,
            tool_call_id: toolCall.id,
        });
        return ptcMcpInvokeRefusalTool();
    }
    const call = { tool: toolCall.name, tool_call_id: toolCall.id };
    writePtcDirectCallEvent(context, 'ptc hidden tool called directly', call);
    let prepared;
    try {
        prepared = prepareDirectCallArguments(tool, toolCall.arguments);
    }
    catch {
        // The tool's own preparation threw; Pi reports that error when it prepares the call.
        prepared = { fixes: [], valid: false };
    }
    writePtcDirectCallEvent(context, 'ptc hidden tool arguments prepared', {
        ...call,
        fixes: [...prepared.fixes],
        valid: prepared.valid,
    });
    // Before noteResolved: an invalid call is settled (and logged) inside it.
    context.ptcObserver?.directCallResolved(toolCall.id, prepared.valid);
    reminder.noteResolved(toolCall, prepared.valid);
    return withDirectCallArguments(tool);
}
function writePtcDirectCallEvent(context, event, fields) {
    try {
        context.ptcLogger?.info?.({ session_id: context.sessionId, turn_id: context.turnId, ...fields }, event);
    }
    catch {
        // Diagnostics must not change the tool call.
    }
}
//# sourceMappingURL=ptc-direct-call-wiring.js.map