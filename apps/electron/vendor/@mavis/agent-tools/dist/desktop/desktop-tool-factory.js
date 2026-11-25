import { defineRuntimeTool } from '@mavis/agent-core/tools';
import { desktopToolErrorCode, desktopToolErrorMessage, desktopToolFailure, desktopToolOk, } from './desktop-tool-result.js';
/** A tool whose capability the Runtime owns; a throw becomes a coded failure. */
export function namespacedTool(def, run) {
    return defineRuntimeTool({
        name: def.name,
        namespace: def.namespace,
        loading: 'on_demand',
        description: def.description,
        schema: def.schema,
        execute: async (ctx, input, signal) => {
            try {
                const data = await run(input, ctx, signal);
                return desktopToolOk(def.name, data, {
                    ...(data.has_more === true ? { hasMore: true } : {}),
                });
            }
            catch (error) {
                return desktopToolFailure(def.name, desktopToolErrorCode(error), desktopToolErrorMessage(error));
            }
        },
    });
}
/**
 * A tool whose capability only the desktop UI has. The Runtime raises one
 * `ui.request`, the UI performs it and replies; a window that never answers
 * becomes `UI_UNAVAILABLE` and a UI-reported failure keeps its own code.
 */
export function uiRequestTool(def, adapter, toRequest) {
    return namespacedTool(def, async (input, ctx, signal) => {
        const result = await adapter.request(toRequest(input, ctx), signal);
        if (!result.ok) {
            const failure = new Error(result.message);
            failure.code = result.code;
            throw failure;
        }
        return result.data;
    });
}
/** The conversation whose Turn called the tool; every UI request carries it. */
export function callerSessionId(ctx) {
    const sessionId = ctx.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
        const failure = new Error('This tool needs a conversation to act on.');
        failure.code = 'INVALID_ARGUMENT';
        throw failure;
    }
    return sessionId;
}
/** A stable `INVALID_ARGUMENT` failure, so bad model input is not `INTERNAL`. */
export function invalidArgument(message) {
    const failure = new Error(message);
    failure.code = 'INVALID_ARGUMENT';
    return failure;
}
//# sourceMappingURL=desktop-tool-factory.js.map