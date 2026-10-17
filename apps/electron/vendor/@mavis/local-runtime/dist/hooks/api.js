import { HookRegistry, configureHookRegistryHost, } from './engine/index.js';
import { createReviewLinkRecorderRegistration, } from '../review-link/hook.js';
import { LocalReviewLinkStore } from '../review-link/store.js';
export class LocalHookService {
    registry;
    constructor(options) {
        if (options.metricsReporter) {
            configureHookRegistryHost({ metricsReporter: options.metricsReporter });
        }
        this.registry = new HookRegistry();
        registerLocalBuiltinHooks(this.registry, {
            resolveWorkspaceDir: (sessionId) => options.resolveSessionWorkspaceDir
                ? options.resolveSessionWorkspaceDir(sessionId)
                : options.resolveWorkspaceDir?.(sessionId),
            store: new LocalReviewLinkStore(options.dataDir),
            ...(options.nowMs ? { nowMs: options.nowMs } : {}),
        });
    }
    async beforeToolCall(input) {
        const toolName = input.toolContext.toolCall.name;
        const toolCallId = readToolCallId(input.toolContext.toolCall);
        const toolSource = readToolSource(input.toolContext.toolCall);
        const toolArgs = { ...(readRecord(input.toolContext.args) ?? {}) };
        const preInput = {
            agentName: input.agentName,
            sessionId: input.sessionId,
            turnId: input.turnId,
            toolName,
            ...(toolSource ? { toolSource } : {}),
            ...(toolCallId ? { toolCallId } : {}),
            toolArgs,
            ...(input.model ? { model: input.model } : {}),
        };
        const preOutput = {
            toolArgs: { ...toolArgs },
            metadata: {},
        };
        const result = await this.registry.execute('PreToolUse', preInput, preOutput, toolName, input.agentName);
        if (!result.aborted) {
            replaceToolArgs(input.toolContext, preOutput.toolArgs);
            return undefined;
        }
        return {
            block: true,
            reason: result.abortReason ?? 'PreToolUse hook aborted local tool call.',
        };
    }
    async afterToolCall(input) {
        const toolName = input.toolContext.toolCall.name;
        const toolCallId = readToolCallId(input.toolContext.toolCall);
        const toolSource = readToolSource(input.toolContext.toolCall);
        const postInput = {
            agentName: input.agentName,
            sessionId: input.sessionId,
            turnId: input.turnId,
            toolName,
            ...(toolSource ? { toolSource } : {}),
            ...(toolCallId ? { toolCallId } : {}),
            toolArgs: readRecord(input.toolContext.args) ?? {},
            toolResult: input.toolContext.result,
        };
        const postOutput = { metadata: {} };
        const result = await this.registry.execute('PostToolUse', postInput, postOutput, toolName, input.agentName);
        if (result.aborted) {
            return {
                isError: true,
                content: [{ type: 'text', text: result.abortReason ?? 'PostToolUse hook aborted.' }],
            };
        }
        if (postOutput.toolResult === undefined)
            return undefined;
        if (typeof postOutput.toolResult === 'string') {
            return { content: [{ type: 'text', text: postOutput.toolResult }] };
        }
        if (!postOutput.toolResult || typeof postOutput.toolResult !== 'object')
            return undefined;
        const rewritten = postOutput.toolResult;
        const out = {};
        if (Array.isArray(rewritten.content))
            out.content = rewritten.content;
        if (rewritten.details !== undefined)
            out.details = rewritten.details;
        if (typeof rewritten.isError === 'boolean')
            out.isError = rewritten.isError;
        if (typeof rewritten.terminate === 'boolean')
            out.terminate = rewritten.terminate;
        return Object.keys(out).length > 0 ? out : undefined;
    }
}
function registerLocalBuiltinHooks(registry, reviewLinkDeps) {
    registry.registerBuiltin({
        id: 'local-builtin-binary-read-guard',
        hookEvent: 'PreToolUse',
        priority: 5,
        matcher: 'read',
        timeout: 1000,
        handler: async (input, output) => {
            const filePath = readString(input.toolArgs['path']);
            if (!filePath)
                return;
            output.metadata['localBuiltin'] = [
                ...readStringArray(output.metadata['localBuiltin']),
                'binary-read-guard',
            ];
            if (/\.(?:bin|exe|dll|dylib|so|zip|tar|gz|7z)$/iu.test(filePath)) {
                output._abort = { reason: `Binary file read blocked by local hook: ${filePath}` };
            }
        },
    });
    registry.registerBuiltin({
        id: 'local-builtin-image-compressor',
        hookEvent: 'PostToolUse',
        priority: 50,
        matcher: 'read',
        timeout: 1000,
        handler: async (input, output) => {
            const filePath = readString(input.toolArgs['path']);
            if (!filePath || !/\.(?:png|jpe?g|gif|webp)$/iu.test(filePath))
                return;
            output.metadata['localBuiltin'] = [
                ...readStringArray(output.metadata['localBuiltin']),
                'image-compressor',
            ];
        },
    });
    registry.registerBuiltin({
        id: 'local-builtin-office-file-skill-env-gate',
        hookEvent: 'PreToolUse',
        priority: 20,
        matcher: 'read|write|edit',
        timeout: 1000,
        handler: async (input, output) => {
            const filePath = readString(input.toolArgs['path']);
            if (!filePath || !/\.(?:docx|xlsx|pptx)$/iu.test(filePath))
                return;
            output.metadata['localBuiltin'] = [
                ...readStringArray(output.metadata['localBuiltin']),
                'office-file-skill-env-gate',
            ];
            if (process.env.MAVIS_LOCAL_RUNTIME_DISABLE_OFFICE_SKILLS === '1') {
                output._abort = {
                    reason: `Office file tool use is disabled by local runtime environment: ${filePath}`,
                };
            }
        },
    });
    // Review links — record the PR/MR a branch belongs to when the agent runs
    // `gh pr create|view` / `glab mr create|view`, so the TUI status line can
    // surface it.
    registry.registerBuiltin(createReviewLinkRecorderRegistration(reviewLinkDeps));
}
function readToolCallId(toolCall) {
    if (!toolCall || typeof toolCall !== 'object')
        return undefined;
    const id = toolCall.id;
    return typeof id === 'string' ? id : undefined;
}
function readToolSource(toolCall) {
    if (!toolCall || typeof toolCall !== 'object')
        return undefined;
    const source = toolCall.source;
    return typeof source === 'string' ? source : undefined;
}
function readString(value) {
    return typeof value === 'string' && value.trim() ? value : undefined;
}
function readRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function readStringArray(value) {
    return Array.isArray(value)
        ? value.filter((item) => typeof item === 'string')
        : [];
}
function replaceToolArgs(toolContext, nextArgs) {
    if (toolContext.args &&
        typeof toolContext.args === 'object' &&
        !Array.isArray(toolContext.args)) {
        if (toolContext.args === nextArgs)
            return;
        for (const key of Object.keys(toolContext.args)) {
            delete toolContext.args[key];
        }
        Object.assign(toolContext.args, nextArgs);
        return;
    }
    toolContext.args = nextArgs;
}
//# sourceMappingURL=api.js.map