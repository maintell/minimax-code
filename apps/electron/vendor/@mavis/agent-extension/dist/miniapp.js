import { defineRuntimeTool, } from '@mavis/agent-runtime';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { projectMiniAppFailure, } from './miniapp-diagnostics.js';
const TARGET_ACTIONS = ['init', 'open', 'inspect', 'publish', 'restart', 'stop'];
const MINIAPP_ACTIONS = ['list', ...TARGET_ACTIONS];
const PluginId = Type.String({
    minLength: 1,
    maxLength: 80,
    pattern: '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$',
    description: 'Required for every Mini App action except list.',
});
const OpenPath = Type.String({
    minLength: 1,
    maxLength: 4096,
    pattern: String.raw `^/(?!/)(?:[^\u0000-\u0020\u007f\\#%]|%[0-9a-fA-F]{2})*(?![\s\S])`,
    description: 'Only for open. An origin-relative path, optionally including a query string, such as /items/42?tab=details. Omit to open the default surface. Must start with a single /; URLs, backslashes, ASCII whitespace and control characters, fragments, and malformed percent escapes are forbidden.',
});
const SourcePath = Type.String({
    minLength: 1,
    maxLength: 4096,
    pattern: '^[^\\u0000]*$',
    description: 'Publish only: path to a finished Mini App package directory, absolute or relative to the current Session workspace. Omit to publish the workspace package.',
});
// Keep the provider-facing input as one concrete object. Exact action/input pairing
// remains a runtime concern below; exposing the action contracts as a root object
// union produces a top-level anyOf that some OpenAI-compatible providers reject.
const MiniAppProviderInputSchema = Type.Object({
    action: Type.String({
        enum: [...MINIAPP_ACTIONS],
        pattern: `^(?:${MINIAPP_ACTIONS.join('|')})$`,
        description: 'Mini App lifecycle action.',
    }),
    pluginId: Type.Optional(PluginId),
    path: Type.Optional(OpenPath),
    sourcePath: Type.Optional(SourcePath),
}, {
    additionalProperties: false,
    description: 'pluginId is required for every Mini App action except list. path is accepted only for open. sourcePath is accepted only for publish.',
});
const MiniAppActionInputSchema = Type.Union([
    Type.Object({ action: Type.Literal('list') }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal('open'), pluginId: PluginId, path: Type.Optional(OpenPath) }, { additionalProperties: false }),
    Type.Object({
        action: Type.Literal('publish'),
        pluginId: PluginId,
        sourcePath: Type.Optional(SourcePath),
    }, { additionalProperties: false }),
    ...TARGET_ACTIONS.filter((action) => action !== 'open' && action !== 'publish').map((action) => Type.Object({ action: Type.Literal(action), pluginId: PluginId }, { additionalProperties: false })),
]);
export class MiniAppLifecycleError extends Error {
    name = 'MiniAppLifecycleError';
    code;
    retryable;
    busyReason;
    diagnosticReason;
    runtimeError;
    diagnosticId;
    lastGoodAvailable;
    constructor(input) {
        super(input.message);
        this.code = input.code;
        const projection = projectMiniAppFailure(input.code, input.diagnosticReason);
        this.retryable =
            input.busyReason === 'capacity_busy' ? false : (projection?.retryable ?? input.retryable);
        if (input.code === 'BUSY')
            this.busyReason = input.busyReason;
        if (input.code === 'INTERNAL_ERROR') {
            this.diagnosticId = input.diagnosticId;
            if (input.lastGoodAvailable !== undefined) {
                this.lastGoodAvailable = input.lastGoodAvailable;
            }
        }
        if (projection)
            this.diagnosticReason = projection.diagnostic.reasonCode;
        if (input.runtimeError)
            this.runtimeError = input.runtimeError;
    }
}
/** Creates the host extension only when a real Mini App lifecycle adapter is available. */
export function createMiniAppControlExtension(lifecycle) {
    const tool = createMiniAppTool(lifecycle);
    return {
        id: 'miniapp-control',
        description: 'Host-owned Mini App bootstrap and runtime lifecycle control.',
        init(api) {
            api.registerTool((context) => (isMiniAppTurn(context) ? tool : null));
        },
    };
}
function createMiniAppTool(lifecycle) {
    return defineRuntimeTool({
        name: 'miniapp',
        description: "Initialize, list, open, inspect, publish, restart, or stop a Mini App. Init scaffolds or binds the package root in the current Session workspace for authoring without publishing it. Open accepts an optional origin-relative path with a query string to select a page in the current Session's Mini App tab. Inspect returns the installed Mini App's source (official or local) and runtime state. Inspect reads the current or latest run and bounded Host diagnostics without starting the runtime; diagnostics are kept in Host memory and exclude business logs and raw stdout/stderr. Before editing an installed Mini App, inspect its source; official Plugin implementations do not support local editing or republishing. Use miniapp-creator for authoring and recovery guidance. Publish starts or replaces the runtime. Init is not required for a complete package directory. Restart restarts an installed runtime. Stop releases an installed runtime without deleting its Mini App package; use the Mini App Plugin's own Skills, MCP servers, and Connectors for business operations.",
        schema: MiniAppProviderInputSchema,
        source: 'builtin',
        operationClassifier: {
            allowedValues: MINIAPP_ACTIONS,
            classify: (input) => readRecord(input).action,
        },
        execute: async (context, rawInput, signal) => {
            const action = readMiniAppAction(rawInput);
            if (signal?.aborted)
                return errorResult(action, cancelledError());
            if (!Value.Check(MiniAppActionInputSchema, rawInput)) {
                return errorResult(action, invalidArgumentsError(action, rawInput));
            }
            const input = rawInput;
            try {
                const result = await dispatch(lifecycle, input, {
                    sessionId: context.sessionId,
                    turnId: context.turnId,
                    ...(signal ? { signal } : {}),
                });
                return successResult(input.action, result);
            }
            catch (error) {
                return errorResult(input.action, normalizeError(error, signal));
            }
        },
    });
}
async function dispatch(lifecycle, input, context) {
    if (input.action === 'list')
        return lifecycle.list(context);
    const target = { ...context, pluginId: input.pluginId };
    switch (input.action) {
        case 'init':
            return lifecycle.init(target);
        case 'open':
            return lifecycle.open({
                ...target,
                ...(input.path !== undefined ? { path: input.path } : {}),
            });
        case 'inspect':
            return lifecycle.inspect(target);
        case 'publish':
            return lifecycle.publish({
                ...target,
                ...(input.sourcePath !== undefined ? { sourcePath: input.sourcePath } : {}),
            });
        case 'restart':
            return lifecycle.restart(target);
        case 'stop':
            return lifecycle.stop(target);
    }
}
function successResult(action, result) {
    const response = { ok: true, action, result };
    const text = JSON.stringify(response);
    return {
        tool_name: 'miniapp',
        text,
        content: [{ type: 'text', text }],
        details: response,
    };
}
function errorResult(action, error) {
    const response = { ok: false, action, error };
    const text = JSON.stringify(response);
    return {
        tool_name: 'miniapp',
        text,
        content: [{ type: 'text', text }],
        details: response,
        isError: true,
    };
}
function normalizeError(error, signal) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        return cancelledError();
    }
    if (isKnownLifecycleError(error)) {
        const projection = projectMiniAppFailure(error.code, error.diagnosticReason);
        const runtimeError = error instanceof MiniAppLifecycleError ? error.runtimeError : undefined;
        if (projection) {
            return {
                code: error.code,
                ...projection,
                ...(runtimeError ? { runtimeError } : {}),
            };
        }
        if (error.code === 'INTERNAL_ERROR') {
            return {
                code: error.code,
                message: MINIAPP_RECORDED_INTERNAL_ERROR_MESSAGE,
                retryable: false,
                diagnosticId: error.diagnosticId,
                ...(error.lastGoodAvailable !== undefined
                    ? { lastGoodAvailable: error.lastGoodAvailable }
                    : {}),
            };
        }
        return {
            code: error.code,
            message: MINIAPP_PUBLIC_ERROR_MESSAGES[error.code],
            retryable: error.busyReason === 'capacity_busy'
                ? false
                : stableRetryability(error.code, error.retryable),
            ...(error.busyReason ? { busyReason: error.busyReason } : {}),
            ...(runtimeError ? { runtimeError } : {}),
        };
    }
    return {
        code: 'INTERNAL_ERROR',
        message: MINIAPP_PUBLIC_ERROR_MESSAGES.INTERNAL_ERROR,
        retryable: false,
    };
}
const MINIAPP_PUBLIC_ERROR_MESSAGES = {
    NOT_FOUND: 'Mini App was not found.',
    NOT_ENABLED: 'Mini App is not enabled.',
    PLUGIN_ALREADY_EXISTS: 'Mini App Plugin is already installed.',
    BUSY: 'Mini App is busy.',
    SERVICE_RESTARTED: 'Mini App service restarted.',
    PREPARATION_FAILED: 'Mini App preparation failed.',
    RUNTIME_FAILED: 'Mini App runtime failed.',
    OPEN_UNAVAILABLE: 'Mini App open is unavailable.',
    INTERNAL_ERROR: 'The Mini App host could not complete the action.',
    CANCELLED: 'The Mini App action was cancelled.',
};
const MINIAPP_RECORDED_INTERNAL_ERROR_MESSAGE = 'The Mini App Host could not complete this action. A diagnostic ID was created automatically.';
function stableRetryability(code, fallback) {
    if (code === 'BUSY' || code === 'SERVICE_RESTARTED')
        return true;
    if (code === 'PLUGIN_ALREADY_EXISTS' || code === 'PREPARATION_FAILED')
        return false;
    return fallback;
}
function cancelledError() {
    return {
        code: 'CANCELLED',
        message: 'The Mini App action was cancelled.',
        retryable: false,
    };
}
function invalidArgumentsError(action, input) {
    const record = readRecord(input);
    let message = 'Mini App arguments are invalid for the selected action.';
    if (action === 'list' && Object.prototype.hasOwnProperty.call(record, 'pluginId')) {
        message = 'pluginId must be omitted for the list action.';
    }
    else if (action !== 'unknown' &&
        action !== 'publish' &&
        Object.prototype.hasOwnProperty.call(record, 'sourcePath')) {
        message = 'sourcePath is only accepted for the publish action.';
    }
    else if (action !== 'unknown' &&
        action !== 'list' &&
        !Object.prototype.hasOwnProperty.call(record, 'pluginId')) {
        message = 'pluginId is required for this Mini App action.';
    }
    return {
        code: 'INVALID_ARGUMENTS',
        message,
        retryable: false,
    };
}
function readMiniAppAction(input) {
    const action = readRecord(input).action;
    return typeof action === 'string' && MINIAPP_ACTIONS.includes(action)
        ? action
        : 'unknown';
}
function isMiniAppTurn(context) {
    const config = readRecord(context.agentConfig);
    const profile = readRecord(config.agent_profile);
    return profile.surface === 'interactive';
}
function isKnownLifecycleError(error) {
    if (!(error instanceof Error) || error.name !== 'MiniAppLifecycleError')
        return false;
    const candidate = error;
    return (typeof candidate.code === 'string' &&
        candidate.code in MINIAPP_PUBLIC_ERROR_MESSAGES &&
        typeof candidate.retryable === 'boolean' &&
        validBusyReason(candidate.code, candidate.busyReason) &&
        validInternalDiagnostic(candidate.code, candidate.diagnosticId, candidate.lastGoodAvailable));
}
function validBusyReason(code, value) {
    if (code === 'BUSY')
        return value === 'operation_busy' || value === 'capacity_busy';
    return value === undefined;
}
function validInternalDiagnostic(code, diagnosticId, lastGoodAvailable) {
    if (code === 'INTERNAL_ERROR') {
        return (typeof diagnosticId === 'string' &&
            diagnosticId.length > 0 &&
            (lastGoodAvailable === undefined || typeof lastGoodAvailable === 'boolean'));
    }
    return diagnosticId === undefined && lastGoodAvailable === undefined;
}
function readRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
//# sourceMappingURL=miniapp.js.map