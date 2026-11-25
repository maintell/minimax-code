/**
 * What a PTC Turn answers for a name it offers no tool for inside run_code.
 * Each refusal replaces QuickJS's "not a function", which names neither the
 * tool nor what to do instead, and each is a hidden child: callable, never
 * listed in the SDK, the reminder or `Object.keys(tools)`.
 */
import { createMcpInvokeTool } from '@mavis/agent-tools/mcp-disclosure';
import { coordinatorHiddenToolNames, coordinatorHiddenToolRefusal, } from '@mavis/agent-tools/namespaced-tools';
/**
 * Arguments these refusals never read: they are about the name, and a call
 * that never ran has no arguments worth validating. The mcp_invoke schema is
 * borrowed as the permissive one — every property optional, extra properties
 * allowed — so whatever the model sent for the name it reached for still
 * validates and still reads the refusal instead of an argument error. Reusing
 * a real schema keeps this module inside the agent-host import boundary,
 * which admits no schema library.
 */
const REFUSAL_ARGUMENTS = createMcpInvokeTool(new Map()).def.schema;
/**
 * There is no mcp_invoke on a PTC Turn: Tool Search hands the model a
 * definition, and the tool behind it is called by its own name inside the
 * program. The same wording answers a top-level `mcp_invoke` call.
 */
export const PTC_MCP_INVOKE_UNAVAILABLE_MESSAGE = [
    'This turn has no mcp_invoke.',
    'A tool found through tool_search is called inside run_code under its own name: await tools["<tool_name>"](args).',
].join(' ');
/** The hidden child and the missing-tool answer for an `mcp_invoke` call. */
export function ptcMcpInvokeRefusalTool() {
    const text = PTC_MCP_INVOKE_UNAVAILABLE_MESSAGE;
    return refusalTool({
        name: 'mcp_invoke',
        event: 'ptc mcp_invoke refused',
        result: () => ({
            tool_name: 'mcp_invoke',
            text,
            content: [{ type: 'text', text }],
            isError: true,
            // The metric label and the failure log read the bounded code from here.
            details: { ok: false, errorCode: 'INVALID_ARGUMENT' },
        }),
    });
}
/**
 * One refusal per namespaced tool a trusted coordinator must not call. The
 * result is the executor guard's own answer for that name
 * (`coordinatorHiddenToolRefusal`), so a program reads exactly what the tool
 * would have said — including the assignment tool a session command moved to,
 * and the reason the Agent roster is the user's. Without these the name is not
 * a function at all, which is what made the coordinator search for another way
 * to send.
 */
export function coordinatorHiddenToolRefusalTools() {
    return coordinatorHiddenToolNames().map((name) => refusalTool({
        name,
        event: 'ptc coordinator hidden tool refused',
        result: () => coordinatorHiddenToolRefusal(name),
    }));
}
function refusalTool(input) {
    return {
        def: {
            name: input.name,
            description: `Refuses a ${input.name} call this turn cannot serve.`,
            schema: REFUSAL_ARGUMENTS,
        },
        source: 'builtin',
        impl: {
            execute: async (context) => {
                logRefusal(context, input.event, input.name);
                return input.result();
            },
        },
    };
}
/** One line per refused call; the tool name only, never arguments. */
function logRefusal(context, event, toolName) {
    try {
        context.ptcLogger?.info?.({ session_id: context.sessionId, turn_id: context.turnId, tool: toolName }, event);
    }
    catch {
        // Diagnostics must not change the tool call.
    }
}
//# sourceMappingURL=ptc-unavailable-tools.js.map