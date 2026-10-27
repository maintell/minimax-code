var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
import { bindTool } from '@mavis/agent-core/tools';
import { createDefaultTokenEstimator } from '@mavis/context-manager';
import { z } from 'zod';
import { normalizeMavisCommand } from '../shared/mavis-operation-classifier.js';
import { CRON_CREATE_ME_REJECTED_MESSAGE, isCronDedicatedSessionTarget, isCronFixedSessionId, isMeSessionSentinel, } from '../shared/cron-schedule-input.js';
import { LocalMavisToolDef } from './builtin-defs.js';
import { LOCAL_MAVIS_COMMANDS, LOCAL_CRON_COMMANDS, } from './local-mavis-commands.js';
import { LocalMavisCronUnsupportedError, LocalMavisCronValidationError, } from './local-mavis-cron-adapter.js';
import { createDesktopOutputContinuation } from './output-limit.js';
import { toAgentRequestRef } from './subagent-roles.js';
export const DESKTOP_MANAGEMENT_MAX_TOKENS = 16_000;
const MAVIS_TOKEN_ESTIMATOR = createDefaultTokenEstimator();
const optionalString = z.string().optional();
const optionalNumber = z.number().int().nonnegative().optional();
const optionalBoolean = z.boolean().optional();
const pageParamSchema = z.object({
    search: optionalString,
    offset: optionalNumber,
    limit: optionalNumber,
    include_primary: optionalBoolean,
});
const agentGetSchema = z.object({ agent_name: z.string().min(1) });
const agentCreateSchema = z
    .object({
    name: optionalString,
    display_name: optionalString,
    system_prompt: optionalString,
    persona: optionalString,
    description: optionalString,
    avatar: optionalString,
    default_workspace_dir: optionalString,
})
    .refine((value) => Boolean(value.name?.trim()) || Boolean(value.display_name?.trim()), {
    message: 'agent create requires either `name` or `display_name`',
});
const agentUpdateSchema = z.object({
    agent_name: z.string().min(1),
    new_name: optionalString,
    system_prompt: optionalString,
    persona: optionalString,
    description: optionalString,
    avatar: optionalString,
});
const agentDeleteSchema = z.object({ agent_name: z.string().min(1) });
const helpSchema = z.object({});
const idString = z.string().min(1, 'ID must be a non-empty string');
const activeHoursSchema = z
    .object({
    start: z.string().regex(/^\d{2}:\d{2}$/, 'start must be HH:MM 24h'),
    end: z.string().regex(/^\d{2}:\d{2}$/, 'end must be HH:MM 24h'),
})
    .partial();
const cronSessionSchema = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('new') }).strict(),
    z.object({ mode: z.literal('sessionId'), session_id: idString }).strict(),
]);
const cronCreationSessionSchema = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('new') }).strict(),
    z.object({ mode: z.literal('sessionId'), session_id: idString.optional() }).strict(),
]);
const cronListSchema = z.object({
    agent_name: optionalString,
    cursor: optionalString,
    limit: optionalNumber,
});
const cronGetSchema = z.object({ cron_id: idString });
const cronExecutionFields = {
    project: z.string().optional(),
    model: z.string().optional(),
};
const cronResolveModelSchema = z.object({ model: z.string().trim().min(1) }).strict();
const cronCreateSchema = z
    .object({
    ...cronExecutionFields,
    agent_name: optionalString,
    cron_name: z.string().min(1),
    schedule: z.string().min(1),
    prompt: z.string().min(1),
    timezone: optionalString,
    active_hours: activeHoursSchema.optional(),
    session: cronCreationSessionSchema,
    enabled: optionalBoolean,
})
    .strict()
    .superRefine(validateCronCreationOwnerInput);
const cronSelfSchema = z.object({
    ...cronExecutionFields,
    cron_name: optionalString,
    every: z.string().min(1),
    prompt: z.string().min(1),
    timezone: optionalString,
    quiet_on_skip: optionalBoolean,
    session_id: optionalString,
});
const cronOnceSchema = z
    .object({
    ...cronExecutionFields,
    agent_name: optionalString,
    cron_name: optionalString,
    after: optionalString,
    at: z.union([z.string().min(1), z.number()]).optional(),
    prompt: z.string().min(1),
    timezone: optionalString,
    session: cronCreationSessionSchema,
})
    .strict()
    .superRefine(validateCronCreationOwnerInput);
const cronUpdateSchema = z
    .object({
    ...cronExecutionFields,
    cron_name: z.string().trim().min(1).optional(),
    cron_id: idString,
    schedule: optionalString,
    prompt: optionalString,
    timezone: optionalString,
    active_hours: activeHoursSchema.optional(),
    session: cronSessionSchema.optional(),
    enabled: optionalBoolean,
})
    .superRefine((value, refinement) => {
    // `fixed` 只表达「创建专用会话」。重新指向已有任务不会创建会话,
    // 更新入口只接受真实会话 ID。
    if (value.session?.mode === 'sessionId' && isCronFixedSessionId(value.session.session_id)) {
        refinement.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['session', 'session_id'],
            message: '"fixed" is only accepted when creating a task; updating re-points the target to a real session ID',
        });
    }
});
const cronDeleteSchema = z.object({ cron_id: idString });
const cronTriggerSchema = z.object({ cron_id: idString });
const cronSessionsSchema = z.object({
    cron_id: idString,
    cursor: optionalString,
    limit: optionalNumber,
});
const sessionListSchema = z.union([
    z.object({
        mode: z.literal('peers'),
        session_id: idString,
    }),
    z.object({
        mode: z.literal('sessions').optional(),
        agent_name: optionalString,
        parent_session_id: optionalString,
        archive_filter: z.enum(['Unarchived', 'Archived']).optional(),
        cursor: optionalString,
        limit: optionalNumber,
    }),
]);
const sessionReadSource = z.enum(['local', 'cloud']).optional();
const sessionGetSchema = z.object({ session_id: idString, source: sessionReadSource });
const sessionSendSchema = z
    .object({
    session_id: idString,
    content: z.string().trim().min(1, 'content must be a non-empty string'),
    // Default false: a send is a delivery, not a request/response call. Opt in
    // to sync only when the reply text is required to continue.
    sync: optionalBoolean,
    // Default false: routing follows the desktop composer send preference
    // unless the caller explicitly demands the steer entry point.
    force_steer: optionalBoolean,
})
    .strict();
const sessionUpdateSchema = z.object({
    session_id: idString,
    title: optionalString,
    archived: optionalBoolean,
    model: optionalString,
});
const sessionInterruptSchema = z.object({
    session_id: idString,
    turn_id: idString.optional(),
});
const sessionMessagesSchema = z.object({
    session_id: idString,
    source: sessionReadSource,
    limit: optionalNumber,
    before: optionalString,
});
const mcpTransportSchema = z.enum(['stdio', 'http', 'streamable-http', 'sse']);
const mcpStringMapSchema = z.record(z.string(), z.string());
const mcpListSchema = z.object({ search: optionalString }).strict();
const mcpGetSchema = z.object({ name: z.string().min(1) }).strict();
const mcpCreateSchema = z.discriminatedUnion('transport', [
    z
        .object({
        name: z.string().min(1),
        transport: z.literal('stdio'),
        command: z.string().min(1),
        args: z.array(z.string()).optional(),
        env: mcpStringMapSchema.optional(),
        timeout_ms: z.number().int().positive().optional(),
        description: optionalString,
        enabled: optionalBoolean,
    })
        .strict(),
    z
        .object({
        name: z.string().min(1),
        transport: z.enum(['http', 'streamable-http', 'sse']),
        url: z.string().min(1),
        headers: mcpStringMapSchema.optional(),
        timeout_ms: z.number().int().positive().optional(),
        description: optionalString,
        enabled: optionalBoolean,
    })
        .strict(),
]);
const mcpUpdateSchema = z
    .object({
    name: z.string().min(1),
    transport: mcpTransportSchema.optional(),
    command: optionalString,
    url: optionalString,
    args: z.array(z.string()).optional(),
    env: mcpStringMapSchema.optional(),
    headers: mcpStringMapSchema.optional(),
    timeout_ms: z.union([z.number().int().positive(), z.null()]).optional(),
    description: z.union([z.string(), z.null()]).optional(),
    enabled: optionalBoolean,
})
    .strict()
    .superRefine((value, ctx) => {
    if (Object.keys(value).length === 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'at least one field must be updated' });
    }
    const hasStdioFields = value.command !== undefined || value.args !== undefined || value.env !== undefined;
    const hasRemoteFields = value.url !== undefined || value.headers !== undefined;
    if (hasStdioFields && hasRemoteFields) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'cannot mix stdio and remote fields' });
    }
    if (value.transport === 'stdio') {
        if (hasRemoteFields) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'stdio does not accept remote fields',
            });
        }
    }
    else if (value.transport !== undefined && hasStdioFields) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'remote does not accept stdio fields',
        });
    }
});
const mcpDeleteSchema = z.object({ name: z.string().min(1) }).strict();
// `Record<LocalMavisCommandName, ...>` 让本表和 `LOCAL_MAVIS_COMMANDS` 词表
// 保持强同步：少一条或多一条命令都会直接编译失败。
const COMMAND_SCHEMAS = {
    'agent list': pageParamSchema,
    'agent get': agentGetSchema,
    'agent create': agentCreateSchema,
    'agent update': agentUpdateSchema,
    'agent delete': agentDeleteSchema,
    'agent help': helpSchema,
    'cron list': cronListSchema,
    'cron get': cronGetSchema,
    'cron resolve-model': cronResolveModelSchema,
    'cron create': cronCreateSchema,
    'cron self': cronSelfSchema,
    'cron once': cronOnceSchema,
    'cron update': cronUpdateSchema,
    'cron delete': cronDeleteSchema,
    'cron trigger': cronTriggerSchema,
    'cron sessions': cronSessionsSchema,
    'cron help': helpSchema,
    'session list': sessionListSchema,
    'session get': sessionGetSchema,
    'session send': sessionSendSchema,
    'session update': sessionUpdateSchema,
    'session interrupt': sessionInterruptSchema,
    'session messages': sessionMessagesSchema,
    'session help': helpSchema,
    'mcp list': mcpListSchema,
    'mcp get': mcpGetSchema,
    'mcp create': mcpCreateSchema,
    'mcp update': mcpUpdateSchema,
    'mcp delete': mcpDeleteSchema,
    'mcp help': helpSchema,
};
const KNOWN_COMMANDS = [...LOCAL_MAVIS_COMMANDS, ...LOCAL_CRON_COMMANDS];
const HANDLERS = {
    'agent list': handleAgentList,
    'agent get': handleAgentGet,
    'agent create': handleAgentCreate,
    'agent update': handleAgentUpdate,
    'agent delete': handleAgentDelete,
    'agent help': handleAgentHelp,
    'cron list': handleCronList,
    'cron get': handleCronGet,
    'cron resolve-model': handleCronResolveModel,
    'cron create': handleCronCreate,
    'cron self': handleCronSelf,
    'cron once': handleCronOnce,
    'cron update': handleCronUpdate,
    'cron delete': handleCronDelete,
    'cron trigger': handleCronTrigger,
    'cron sessions': handleCronSessions,
    'cron help': handleCronHelp,
    'session list': handleSessionList,
    'session get': handleSessionGet,
    'session send': handleSessionSend,
    'session update': handleSessionUpdate,
    'session interrupt': handleSessionInterrupt,
    'session messages': handleSessionMessages,
    'session help': handleSessionHelp,
    'mcp list': handleMcpList,
    'mcp get': handleMcpGet,
    'mcp create': handleMcpCreate,
    'mcp update': handleMcpUpdate,
    'mcp delete': handleMcpDelete,
    'mcp help': handleMcpHelp,
};
let LocalMavisTool = (() => {
    let _classDecorators = [bindTool(LocalMavisToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var LocalMavisTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            LocalMavisTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        agentAdapter;
        cronAdapter;
        sessionAdapter;
        mcpAdapter;
        constructor(agentAdapter, cronAdapter, sessionAdapter, mcpAdapter) {
            this.agentAdapter = agentAdapter;
            this.cronAdapter = cronAdapter;
            this.sessionAdapter = sessionAdapter;
            this.mcpAdapter = mcpAdapter;
        }
        async execute(ctx, input, signal) {
            if (normalizeCommand(input.command) === 'session create') {
                const text = JSON.stringify({
                    ok: false,
                    command: 'session create',
                    error: {
                        kind: 'validation',
                        code: 'SESSION_CREATE_MOVED',
                        message: 'Search for session_create with tool_search, then call mcp_invoke.',
                    },
                });
                return { tool_name: 'mavis', text, content: [{ type: 'text', text }], isError: true };
            }
            if (normalizeCommand(input.command) === 'session delete') {
                // Deletion stays a user action. Answering here, before the unknown-command
                // branch, keeps the command out of the advertised vocabulary while still
                // telling the model what to do instead.
                const text = JSON.stringify({
                    ok: false,
                    command: 'session delete',
                    error: {
                        kind: 'validation',
                        code: 'SESSION_DELETE_NOT_ALLOWED',
                        message: 'Deleting a session is reserved for the user. Ask the user to delete it in the app, or archive it with session update (archived: true).',
                    },
                });
                return { tool_name: 'mavis', text, content: [{ type: 'text', text }], isError: true };
            }
            if (normalizeCommand(input.command).startsWith('cron ')) {
                const text = JSON.stringify({
                    ok: false,
                    error: {
                        code: 'CRON_TOOL_MOVED',
                        message: 'Use self_reminder for task follow-up. Search for cron_create, cron_read, cron_update or cron_delete with tool_search, then call mcp_invoke.',
                    },
                });
                return { tool_name: 'mavis', text, content: [{ type: 'text', text }], isError: true };
            }
            const command = normalizeCommand(input.command);
            if (!LOCAL_MAVIS_COMMANDS.includes(command)) {
                const text = JSON.stringify({
                    ok: false,
                    command,
                    error: {
                        kind: 'validation',
                        message: 'Unknown mavis command.',
                        known_commands: LOCAL_MAVIS_COMMANDS,
                    },
                });
                return { tool_name: 'mavis', text, content: [{ type: 'text', text }], isError: true };
            }
            const output = await dispatchLocalMavis({
                agentAdapter: this.agentAdapter,
                ...(this.cronAdapter ? { cronAdapter: this.cronAdapter } : {}),
                ...(this.sessionAdapter ? { sessionAdapter: this.sessionAdapter } : {}),
                ...(this.mcpAdapter ? { mcpAdapter: this.mcpAdapter } : {}),
                currentAgentName: ctx.agentName,
                currentSessionId: ctx.sessionId,
                currentTurnId: ctx.turnId,
                currentModel: currentLocalCronModel(ctx),
            }, input.command, input.args, signal);
            const text = JSON.stringify(output, null, 2);
            const historyOutput = JSON.parse(text);
            const result = {
                tool_name: LocalMavisToolDef.name,
                text,
                content: [{ type: 'text', text }],
                details: { command: output.command, output: historyOutput },
                ...(output.ok ? {} : { isError: true }),
            };
            const limited = limitLocalManagementOutput(ctx, text, output);
            if (!limited.truncated)
                return result;
            const continuation = createDesktopOutputContinuation({
                continuation_hint: {
                    tool: 'mavis',
                    preserve_args: ['command', 'args'],
                    instruction: mavisRecoveryInstruction(output.command),
                },
            });
            return {
                ...result,
                text: limited.text,
                content: [{ type: 'text', text: limited.text }],
                details: {
                    ...result.details,
                    desktop_output_truncation: {
                        truncated: true,
                        has_more: true,
                        strategy: 'head_tail_tokens',
                        original_estimated_tokens: limited.originalTokens,
                        returned_estimated_tokens: limited.returnedTokens,
                        max_tokens: DESKTOP_MANAGEMENT_MAX_TOKENS,
                    },
                    desktop_output_continuation: continuation,
                },
            };
        }
    };
    return LocalMavisTool = _classThis;
})();
export { LocalMavisTool };
export function limitLocalManagementOutput(ctx, text, output, toolName = 'mavis', recoveryInstruction = mavisRecoveryInstruction(output.command)) {
    const originalTokens = estimateMavisResultTokens(ctx, text, !output.ok);
    if (originalTokens <= DESKTOP_MANAGEMENT_MAX_TOKENS) {
        return {
            text,
            truncated: false,
            originalTokens,
            returnedTokens: originalTokens,
        };
    }
    const notice = `\n\n[desktop ${toolName} output truncated: original_estimated_tokens=${originalTokens}; ` +
        `max_tokens=${DESKTOP_MANAGEMENT_MAX_TOKENS}; head+tail shown; ` +
        `if the omitted response is needed, ${recoveryInstruction}]\n\n`;
    const noticeOnly = notice.trim();
    let low = 0;
    let high = text.length;
    let bestText = noticeOnly;
    let bestTokens = estimateMavisResultTokens(ctx, bestText, !output.ok);
    while (low <= high) {
        const retainedUnits = Math.floor((low + high) / 2);
        const candidate = buildMavisHeadTailCandidate(text, retainedUnits, notice);
        const candidateTokens = estimateMavisResultTokens(ctx, candidate, !output.ok);
        if (candidateTokens <= DESKTOP_MANAGEMENT_MAX_TOKENS) {
            bestText = candidate;
            bestTokens = candidateTokens;
            low = retainedUnits + 1;
        }
        else {
            high = retainedUnits - 1;
        }
    }
    return {
        text: bestText,
        truncated: true,
        originalTokens,
        returnedTokens: bestTokens,
    };
}
function estimateMavisResultTokens(ctx, text, isError) {
    const message = {
        role: 'toolResult',
        toolCallId: ctx.toolCallId ?? 'unknown-tool-call',
        toolName: LocalMavisToolDef.name,
        content: [{ type: 'text', text }],
        isError,
        timestamp: 0,
    };
    return MAVIS_TOKEN_ESTIMATOR.estimateMessage(message);
}
function buildMavisHeadTailCandidate(text, retainedUnits, notice) {
    if (retainedUnits <= 0)
        return notice.trim();
    const headUnits = Math.ceil(retainedUnits / 2);
    const tailUnits = Math.floor(retainedUnits / 2);
    const head = safeSliceStart(text, headUnits).replace(/\s+$/u, '');
    const tail = safeSliceEnd(text, tailUnits).replace(/^\s+/u, '');
    if (!head && !tail)
        return notice.trim();
    if (!head)
        return `${notice}${tail}`.trim();
    if (!tail)
        return `${head}${notice}`.trim();
    return `${head}${notice}${tail}`.trim();
}
function safeSliceStart(text, maxUnits) {
    let end = Math.min(text.length, Math.max(0, maxUnits));
    if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1)))
        end -= 1;
    return text.slice(0, end);
}
function safeSliceEnd(text, maxUnits) {
    let start = Math.max(0, text.length - Math.max(0, maxUnits));
    if (start < text.length && isLowSurrogate(text.charCodeAt(start)))
        start += 1;
    return text.slice(start);
}
function isHighSurrogate(code) {
    return code >= 0xd800 && code <= 0xdbff;
}
function isLowSurrogate(code) {
    return code >= 0xdc00 && code <= 0xdfff;
}
const LOCAL_MAVIS_MUTATION_COMMANDS = new Set([
    'agent create',
    'agent update',
    'agent delete',
    'cron create',
    'cron self',
    'cron once',
    'cron update',
    'cron delete',
    'cron trigger',
    'session update',
    'session interrupt',
    'session send',
    'mcp create',
    'mcp update',
    'mcp delete',
]);
function mavisRecoveryInstruction(command) {
    if (LOCAL_MAVIS_MUTATION_COMMANDS.has(command)) {
        return (`do not repeat the mutation command ${JSON.stringify(command)} automatically; ` +
            'inspect current state with the corresponding get/list command');
    }
    return (`call mavis again with command=${JSON.stringify(command)} and narrower args ` +
        '(prefer a smaller limit, tighter search/filter, pagination cursor, or a specific get command); ' +
        'preserve the same logical query');
}
export async function dispatchLocalMavis(ctx, rawCommand, rawArgs, signal) {
    const command = normalizeCommand(rawCommand);
    if (rawArgs?.source !== undefined) {
        if (command !== 'session get' && command !== 'session messages') {
            return failure(command, 'validation', 'source is supported only for session get/messages');
        }
        if (rawArgs.source === 'cloud' && isMeSentinel(rawArgs.session_id)) {
            return failure(command, 'validation', 'Cloud reads require an explicit session_id');
        }
    }
    if (!isKnownCommand(command)) {
        if (command === 'help' || command.endsWith(' help')) {
            return failure(command, 'validation', 'Unknown help target. Valid help commands: agent help, cron help, session help, mcp help.', { valid_help_commands: ['agent help', 'cron help', 'session help', 'mcp help'] });
        }
        return failure(command, 'validation', `unknown command: ${JSON.stringify(rawCommand)}. Did you mean one of: ${suggestCommands(command).join(', ')}?`, { known_commands: KNOWN_COMMANDS });
    }
    // Answered before arg validation and before any other adapter lookup. A host
    // without a Cron adapter can never run these, so reporting a missing
    // `session_id` or an absent session service first would name the wrong cause.
    if (command.startsWith('cron ') && !ctx.cronAdapter) {
        return errorToFailure(command, cronUnsupportedHostError());
    }
    // `me` normally resolves to the current session, but that substitution would
    // silently bind a scheduled task to the conversation creating it. The creation
    // entry owns the decision, so it rejects the old alias on the raw arguments
    // before any substitution happens.
    if ((command === 'cron create' || command === 'cron once') &&
        isMeSessionSentinel(cronCreationSessionId(rawArgs))) {
        return failure(command, 'validation', CRON_CREATE_ME_REJECTED_MESSAGE, {
            code: 'CRON_CREATE_ME_REJECTED',
        });
    }
    const schema = COMMAND_SCHEMAS[command];
    let substitutedArgs;
    try {
        substitutedArgs = substituteMe(rawArgs ?? {}, ctx.currentAgentName, ctx.currentSessionId);
    }
    catch (error) {
        if (error instanceof LocalMavisValidationError) {
            return failure(command, 'validation', error.message, error.details);
        }
        throw error;
    }
    const parsed = schema.safeParse(substitutedArgs);
    if (!parsed.success) {
        return failure(command, 'validation', formatZodError(parsed.error), {
            issues: parsed.error.issues,
        });
    }
    try {
        return await HANDLERS[command]({ ...ctx, command }, parsed.data, signal);
    }
    catch (error) {
        return errorToFailure(command, error);
    }
}
async function handleAgentList(ctx, args, signal) {
    const response = await ctx.agentAdapter.listAgents({
        include: 'identity,persona,system_prompt',
        ...(args.search ? { search: args.search } : {}),
        ...(args.offset !== undefined ? { offset: args.offset } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        excludePrimary: args.include_primary !== true,
    }, signal);
    return success(ctx.command, {
        ...response,
        ...(response.agents
            ? {
                agents: response.agents.map((agent) => {
                    const requestRef = toAgentRequestRef(agent);
                    return requestRef === undefined ? agent : { ...agent, requestRef };
                }),
            }
            : {}),
    });
}
async function handleAgentGet(ctx, args, signal) {
    const name = await resolveAgentReadName(ctx, args.agent_name, signal);
    return success(ctx.command, await ctx.agentAdapter.getAgent({ name, include: 'identity,persona,system_prompt' }, signal));
}
async function handleAgentCreate(ctx, args, signal) {
    const displayName = args.display_name?.trim() || args.name?.trim();
    const response = await ctx.agentAdapter.createAgent({
        ...(args.name?.trim() ? { name: args.name.trim() } : {}),
        ...(displayName ? { displayName } : {}),
        ...(Object.hasOwn(args, 'persona') ? { persona: args.persona } : {}),
        ...(Object.hasOwn(args, 'system_prompt') ? { systemPrompt: args.system_prompt } : {}),
        ...(Object.hasOwn(args, 'description') ? { description: args.description } : {}),
        ...(Object.hasOwn(args, 'avatar') ? { avatar: args.avatar } : {}),
        ...(Object.hasOwn(args, 'default_workspace_dir')
            ? { defaultWorkspaceDir: args.default_workspace_dir }
            : {}),
    }, signal);
    return success(ctx.command, response);
}
async function handleAgentUpdate(ctx, args, signal) {
    const name = await resolveAgentExactName(ctx, args.agent_name, signal);
    const response = await ctx.agentAdapter.updateAgent({
        name,
        ...(Object.hasOwn(args, 'new_name') ? { displayName: args.new_name } : {}),
        ...(Object.hasOwn(args, 'persona') ? { persona: args.persona } : {}),
        ...(Object.hasOwn(args, 'system_prompt') ? { systemPrompt: args.system_prompt } : {}),
        ...(Object.hasOwn(args, 'description') ? { description: args.description } : {}),
        ...(Object.hasOwn(args, 'avatar') ? { avatar: args.avatar } : {}),
    }, signal);
    return success(ctx.command, response);
}
async function handleAgentDelete(ctx, args, signal) {
    const name = await resolveAgentExactName(ctx, args.agent_name, signal);
    return success(ctx.command, await ctx.agentAdapter.deleteAgent({ name }, signal));
}
async function handleAgentHelp(ctx) {
    return success(ctx.command, {
        group: 'agent',
        summary: 'Manage local desktop Mavis agents through the internal local-runtime agent service.',
        commands: [
            {
                command: 'agent list',
                summary: 'List local agents; use each row requestRef for agent_name.',
                args: ['search?', 'offset?', 'limit?', 'include_primary?'],
                examples: ['mavis({ command: "agent list", args: { limit: 20 } })'],
            },
            {
                command: 'agent get',
                summary: 'Get one local agent by built-in target or roster requestRef; agent:<stable-name> selects an exact manual/custom colliding name.',
                args: ['agent_name'],
                examples: ['mavis({ command: "agent get", args: { agent_name: "me" } })'],
            },
            {
                command: 'agent create',
                summary: 'Create a local agent and root session. Provide name or display_name.',
                args: [
                    'name?',
                    'display_name?',
                    'system_prompt?',
                    'persona?',
                    'description?',
                    'avatar?',
                    'default_workspace_dir?',
                ],
                examples: [
                    'mavis({ command: "agent create", args: { display_name: "Researcher" } })',
                    'mavis({ command: "agent create", args: { name: "researcher", system_prompt: "Help with research." } })',
                ],
            },
            {
                command: 'agent update',
                summary: 'Patch identity, persona, or system prompt fields for a local agent.',
                args: ['agent_name', 'new_name?', 'system_prompt?', 'persona?', 'description?', 'avatar?'],
                examples: [
                    'mavis({ command: "agent update", args: { agent_name: "researcher", new_name: "Research Lead" } })',
                ],
            },
            {
                command: 'agent delete',
                summary: 'Delete a local non-built-in agent.',
                args: ['agent_name'],
                examples: ['mavis({ command: "agent delete", args: { agent_name: "researcher" } })'],
            },
        ],
    });
}
async function handleCronList(ctx, args, signal) {
    const adapter = requireCronAdapter(ctx);
    const agentName = args.agent_name
        ? await resolveAgentReadName(ctx, args.agent_name, signal)
        : undefined;
    return success(ctx.command, await adapter.listCrons({
        ...(agentName ? { agentName } : {}),
        ...(args.cursor ? { cursor: args.cursor } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
    }, signal));
}
async function handleCronGet(ctx, args, signal) {
    const response = await requireCronAdapter(ctx).getCron({ cronId: args.cron_id }, signal);
    if (!response.task) {
        return failure(ctx.command, 'local_runtime', 'cron task not found', { cron_id: args.cron_id });
    }
    return success(ctx.command, response);
}
async function handleCronResolveModel(ctx, args, signal) {
    const resolveModel = requireCronModelResolver(ctx);
    return success(ctx.command, await resolveModel({
        model: args.model,
        ...(ctx.currentSessionId ? { sessionId: ctx.currentSessionId } : {}),
    }, signal));
}
async function handleCronCreate(ctx, args, signal) {
    const session = toAdapterCronCreationSession(ctx, args.session);
    const agentName = await resolveCronCreationAgentName(ctx, args.agent_name, session, signal);
    const project = await resolveCronCreationProject(ctx, args.project, signal);
    const model = args.model ?? ctx.currentModel;
    return success(ctx.command, await requireCronAdapter(ctx).createCron({
        agentName,
        cronName: args.cron_name,
        schedule: args.schedule,
        ...cronExecutionConfig(args),
        prompt: args.prompt,
        ...(args.timezone ? { timezone: args.timezone } : {}),
        ...(args.active_hours ? { activeHours: args.active_hours } : {}),
        session,
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
        ...(project === undefined ? {} : { project }),
        ...(model === undefined ? {} : { model }),
    }, signal));
}
async function resolveCronCreationProject(ctx, explicitProject, signal) {
    if (explicitProject !== undefined)
        return explicitProject;
    if (!ctx.currentSessionId || !ctx.sessionAdapter)
        return undefined;
    const response = await ctx.sessionAdapter.getSession({ sessionId: ctx.currentSessionId }, signal);
    const session = response.session;
    if (session?.isDefaultWorkspace !== false)
        return undefined;
    return session.workspaceDir?.trim() || undefined;
}
async function handleCronSelf(ctx, args, signal) {
    const sessionId = args.session_id ?? ctx.currentSessionId;
    if (!sessionId) {
        return failure(ctx.command, 'validation', 'cron self requires `session_id` outside a session', {
            missing: 'session_id',
        });
    }
    const agentName = await resolveCronTargetAgentName(ctx, sessionId, signal);
    const model = args.model ?? ctx.currentModel;
    return success(ctx.command, await requireCronAdapter(ctx).createSelfReminder({
        agentName,
        sessionId,
        every: args.every,
        ...cronExecutionConfig(args),
        prompt: args.prompt,
        ...(args.cron_name ? { cronName: args.cron_name } : {}),
        ...(args.timezone ? { timezone: args.timezone } : {}),
        ...(args.quiet_on_skip !== undefined ? { quietOnSkip: args.quiet_on_skip } : {}),
        ...(args.project === undefined ? {} : { project: args.project }),
        ...(model === undefined ? {} : { model }),
    }, signal));
}
async function handleCronOnce(ctx, args, signal) {
    const session = toAdapterCronCreationSession(ctx, args.session);
    const agentName = await resolveCronCreationAgentName(ctx, args.agent_name, session, signal);
    const project = await resolveCronCreationProject(ctx, args.project, signal);
    const model = args.model ?? ctx.currentModel;
    return success(ctx.command, await requireCronAdapter(ctx).createOnceCron({
        agentName,
        ...(args.cron_name ? { cronName: args.cron_name } : {}),
        ...(args.after ? { after: args.after } : {}),
        ...cronExecutionConfig(args),
        ...(args.at !== undefined ? { at: args.at } : {}),
        prompt: args.prompt,
        ...(args.timezone ? { timezone: args.timezone } : {}),
        session,
        ...(project === undefined ? {} : { project }),
        ...(model === undefined ? {} : { model }),
    }, signal));
}
export function currentLocalCronModel(ctx) {
    const provider = ctx.parentAgentConfig?.model?.provider?.trim();
    const modelId = ctx.parentAgentConfig?.model?.model_id?.trim();
    if (!provider || !modelId)
        return undefined;
    return `${provider}/${modelId}`;
}
async function handleCronUpdate(ctx, args, signal) {
    const adapter = requireCronAdapter(ctx);
    const session = args.session ? toAdapterCronSession(ctx, args.session) : undefined;
    if (session?.mode === 'sessionId') {
        await validateCronUpdateTargetOwner(ctx, adapter, args.cron_id, session.sessionId, signal);
    }
    return success(ctx.command, await adapter.updateCron({
        cronId: args.cron_id,
        ...(args.schedule !== undefined ? { schedule: args.schedule } : {}),
        ...(args.cron_name === undefined ? {} : { cronName: args.cron_name }),
        ...cronExecutionConfig(args),
        ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
        ...(args.timezone !== undefined ? { timezone: args.timezone } : {}),
        ...(args.active_hours ? { activeHours: args.active_hours } : {}),
        ...(session ? { session } : {}),
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
    }, signal));
}
function cronExecutionConfig(args) {
    return {
        ...(args.project === undefined ? {} : { project: args.project }),
        ...(args.model === undefined ? {} : { model: args.model }),
    };
}
async function handleCronDelete(ctx, args, signal) {
    return success(ctx.command, await requireCronAdapter(ctx).deleteCron({ cronId: args.cron_id }, signal));
}
async function handleCronTrigger(ctx, args, signal) {
    return success(ctx.command, await requireCronAdapter(ctx).triggerCron({ cronId: args.cron_id }, signal));
}
async function handleCronSessions(ctx, args, signal) {
    return success(ctx.command, await requireCronAdapter(ctx).listCronSessions({
        cronId: args.cron_id,
        ...(args.cursor ? { cursor: args.cursor } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
    }, signal));
}
async function handleCronHelp(ctx) {
    return success(ctx.command, {
        group: 'cron',
        summary: 'Manage local desktop scheduled tasks through LocalCronRuntime.',
        commands: [
            {
                command: 'cron list',
                args: ['agent_name?', 'cursor?', 'limit?'],
                examples: ['mavis({ command: "cron list", args: { agent_name: "me" } })'],
            },
            { command: 'cron get', args: ['cron_id'] },
            {
                command: 'cron resolve-model',
                summary: 'Resolve user-authored model text against the live model catalog without writing.',
                args: ['model'],
            },
            {
                command: 'cron create',
                summary: 'Create recurrence requested by the user. It remains active until disabled or deleted.',
                args: [
                    'agent_name (required for session.mode=new and for a dedicated conversation)',
                    'cron_name',
                    'schedule',
                    'prompt',
                    'timezone?',
                    'active_hours?',
                    'session (session_id:"fixed" gives the task its own reused conversation)',
                    'enabled?',
                    'model?',
                ],
            },
            {
                command: 'cron self',
                summary: 'Periodically re-check external state with no completion signal; state when to report and delete it.',
                args: [
                    'cron_name?',
                    'every',
                    'prompt',
                    'timezone?',
                    'quiet_on_skip?',
                    'session_id?',
                    'model?',
                ],
                examples: [
                    'mavis({ command: "cron self", args: { cron_name: "Check CI", every: "5m", prompt: "Check CI. Running: exit quietly. Passed: report and delete this cron. Failed: summarize and delete this cron." } })',
                ],
            },
            {
                command: 'cron once',
                summary: 'Schedule one future turn. Default to a new session with agent_name. Use sessionId with "fixed" and agent_name for a dedicated conversation, or with a real session ID when the user explicitly requests an existing conversation; then omit agent_name.',
                args: [
                    'agent_name (required for session.mode=new and for a dedicated conversation)',
                    'cron_name?',
                    'after?',
                    'at?',
                    'prompt',
                    'timezone?',
                    'session (session_id:"fixed" gives the task its own reused conversation)',
                    'model?',
                ],
                examples: [
                    'mavis({ command: "cron once", args: { after: "10m", prompt: "Remind the user to review the draft.", agent_name: "me", session: { mode: "new" } } })',
                ],
            },
            {
                command: 'cron update',
                args: [
                    'cron_id',
                    'schedule?',
                    'prompt?',
                    'timezone?',
                    'active_hours?',
                    'session?',
                    'enabled?',
                ],
            },
            { command: 'cron delete', args: ['cron_id'] },
            {
                command: 'cron trigger',
                summary: 'Create one persisted manual run and return its run_id.',
                args: ['cron_id'],
            },
            {
                command: 'cron sessions',
                summary: 'List Cron history. V2 adapters return Runs; legacy adapters preserve Session records. Deleting a V2 Definition does not delete its Runs.',
                args: ['cron_id', 'cursor?', 'limit?'],
            },
        ],
    });
}
async function handleSessionList(ctx, args, signal) {
    const adapter = requireSessionAdapter(ctx);
    if (args.mode === 'peers') {
        const sessionId = resolveSessionId(ctx, args.session_id);
        const current = await adapter.getSession({ sessionId }, signal);
        return success(ctx.command, await adapter.listSessions({ agentName: current.session?.agentName, limit: 100 }, signal));
    }
    const agentName = args.agent_name
        ? await resolveAgentReadName(ctx, args.agent_name, signal)
        : undefined;
    return success(ctx.command, await adapter.listSessions({
        ...(agentName ? { agentName } : {}),
        ...(args.parent_session_id
            ? { parentSessionId: resolveSessionId(ctx, args.parent_session_id) }
            : {}),
        ...(args.archive_filter ? { archiveFilter: args.archive_filter } : {}),
        ...(args.cursor ? { cursor: args.cursor } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
    }, signal));
}
async function handleSessionGet(ctx, args, signal) {
    const sessionId = resolveSessionId(ctx, args.session_id);
    const response = await requireSessionAdapter(ctx).getSession({ sessionId, ...(args.source ? { source: args.source } : {}) }, signal);
    if (!response.session) {
        return failure(ctx.command, 'local_runtime', 'session not found', { session_id: sessionId });
    }
    return success(ctx.command, response);
}
async function handleSessionSend(ctx, args, signal) {
    if (!ctx.currentSessionId) {
        return failure(ctx.command, 'validation', 'session send requires a caller session in the runtime context', { missing: 'caller_session_id' });
    }
    const sessionId = resolveSessionId(ctx, args.session_id);
    return success(ctx.command, await requireSessionAdapter(ctx).sendSession({
        callerSessionId: ctx.currentSessionId,
        // The caller Turn lets the runtime attribute a new round it starts in a
        // sub-session to that Turn (Goal token accounting).
        ...(ctx.currentTurnId ? { callerTurnId: ctx.currentTurnId } : {}),
        sessionId,
        content: args.content,
        // Both switches are passed only when the caller set them, so the
        // adapter owns the defaults (async delivery, preference routing).
        ...(Object.hasOwn(args, 'sync') ? { sync: args.sync } : {}),
        ...(Object.hasOwn(args, 'force_steer') ? { forceSteer: args.force_steer } : {}),
    }, signal));
}
async function handleSessionUpdate(ctx, args, signal) {
    const sessionId = resolveSessionId(ctx, args.session_id);
    return success(ctx.command, await requireSessionAdapter(ctx).updateSession({
        sessionId,
        ...(Object.hasOwn(args, 'title') ? { title: args.title } : {}),
        ...(Object.hasOwn(args, 'archived') ? { archived: args.archived } : {}),
        ...(Object.hasOwn(args, 'model') ? { model: args.model } : {}),
    }, signal));
}
async function handleSessionInterrupt(ctx, args, signal) {
    if (!ctx.currentSessionId) {
        return failure(ctx.command, 'validation', 'session interrupt requires a caller session', {
            code: 'SESSION_INTERRUPT_NO_CALLER',
        });
    }
    // The Turn making this call cannot stop itself through a tool: the result
    // would land in the Turn being torn down. The user stops it from the UI.
    if (isMeSentinel(args.session_id) || args.session_id === ctx.currentSessionId) {
        return failure(ctx.command, 'validation', 'A session cannot interrupt itself. Ask the user to stop it from the app.', { code: 'SESSION_INTERRUPT_SELF', session_id: ctx.currentSessionId });
    }
    return success(ctx.command, await requireSessionAdapter(ctx).interruptSession({
        callerSessionId: ctx.currentSessionId,
        sessionId: args.session_id,
        ...(args.turn_id ? { turnId: args.turn_id } : {}),
    }, signal));
}
async function handleSessionMessages(ctx, args, signal) {
    const sessionId = resolveSessionId(ctx, args.session_id);
    return success(ctx.command, await requireSessionAdapter(ctx).listMessages({
        sessionId,
        ...(args.source ? { source: args.source } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.before ? { before: args.before } : {}),
    }, signal));
}
async function handleSessionHelp(ctx) {
    return success(ctx.command, {
        group: 'session',
        summary: 'Read and manage local desktop Mavis sessions.',
        commands: [
            {
                command: 'session list',
                args: ['agent_name?', 'parent_session_id?', 'archive_filter?', 'cursor?', 'limit?'],
            },
            { command: 'session get', args: ['session_id', 'source? (local|cloud; default local)'] },
            {
                command: 'session send',
                args: ['session_id', 'content', 'sync? (default false)', 'force_steer? (default false)'],
                summary: 'Deliver a message to an existing unarchived local session. Returns an admission ACK by default without waiting; a busy session queues (or merges into the running turn) instead of failing. sync: true waits for the turn and returns its reply text, except for a merged steer, which has no separate reply. force_steer: true merges into the running turn instead of following the desktop composer send preference.',
                examples: [
                    'mavis({ command: "session send", args: { session_id: "mvs_target", content: "Continue with the follow-up requirement." } })',
                    'mavis({ command: "session send", args: { session_id: "mvs_target", content: "What did you conclude?", sync: true } })',
                    'mavis({ command: "session send", args: { session_id: "mvs_target", content: "Also cover the rollback path.", force_steer: true } })',
                ],
            },
            {
                command: 'session update',
                args: ['session_id', 'title?', 'archived?', 'model?'],
            },
            {
                command: 'session interrupt',
                args: ['session_id', 'turn_id?'],
                summary: 'Stop the target session\'s current turn and keep the session. Queued messages still run afterwards; background work and the goal are untouched. Returns outcome aborted or not_running. Cannot target the calling session.',
                examples: ['mavis({ command: "session interrupt", args: { session_id: "mvs_target" } })'],
            },
            {
                command: 'session messages',
                args: [
                    'session_id',
                    'source? (local|cloud; default local)',
                    'limit? (cloud default 20, max 100)',
                    'before?',
                ],
            },
        ],
    });
}
async function handleMcpList(ctx, args, signal) {
    return success(ctx.command, await requireMcpAdapter(ctx).listServers({ ...(args.search ? { search: args.search } : {}) }, signal));
}
async function handleMcpGet(ctx, args, signal) {
    const response = await requireMcpAdapter(ctx).getServer({ name: args.name }, signal);
    if (!response.server) {
        return failure(ctx.command, 'local_runtime', 'MCP server not found', {
            status: 404,
            code: 'MCP_SERVER_NOT_FOUND',
        });
    }
    return success(ctx.command, response);
}
async function handleMcpCreate(ctx, args, signal) {
    return success(ctx.command, await requireMcpAdapter(ctx).createServer({
        name: args.name,
        transport: args.transport,
        ...(args.transport === 'stdio'
            ? {
                command: args.command,
                ...(args.args ? { args: args.args } : {}),
                ...(args.env ? { env: args.env } : {}),
            }
            : {
                url: args.url,
                ...(args.headers ? { headers: args.headers } : {}),
            }),
        ...(args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
    }, signal));
}
async function handleMcpUpdate(ctx, args, signal) {
    return success(ctx.command, await requireMcpAdapter(ctx).updateServer({
        name: args.name,
        ...(args.transport !== undefined ? { transport: args.transport } : {}),
        ...(args.command !== undefined ? { command: args.command } : {}),
        ...(args.url !== undefined ? { url: args.url } : {}),
        ...(args.args !== undefined ? { args: args.args } : {}),
        ...(args.env !== undefined ? { env: args.env } : {}),
        ...(args.headers !== undefined ? { headers: args.headers } : {}),
        ...(Object.hasOwn(args, 'timeout_ms') ? { timeoutMs: args.timeout_ms } : {}),
        ...(Object.hasOwn(args, 'description') ? { description: args.description } : {}),
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
    }, signal));
}
async function handleMcpDelete(ctx, args, signal) {
    return success(ctx.command, await requireMcpAdapter(ctx).deleteServer({ name: args.name }, signal));
}
async function handleMcpHelp(ctx) {
    return success(ctx.command, {
        group: 'mcp',
        summary: 'Manage current-profile MCP server settings. Secret values are accepted for writes but never returned.',
        commands: [
            { command: 'mcp list', args: ['search?'] },
            { command: 'mcp get', args: ['name'] },
            {
                command: 'mcp create',
                summary: 'stdio requires command; remote transports require url. Do not mix stdio and remote fields.',
                args: [
                    'name',
                    'transport',
                    'command?|url?',
                    'args?',
                    'env?',
                    'headers?',
                    'timeout_ms?',
                    'description?',
                    'enabled?',
                ],
            },
            {
                command: 'mcp update',
                summary: 'Provide name and at least one changed field. Do not mix stdio and remote fields.',
                args: [
                    'name',
                    'transport?',
                    'command?|url?',
                    'args?',
                    'env?',
                    'headers?',
                    'timeout_ms?',
                    'description?',
                    'enabled?',
                ],
            },
            { command: 'mcp delete', args: ['name'] },
        ],
    });
}
/**
 * Not a misconfiguration and not a startup failure: this runtime host has no
 * Scheduler at all. The previous "is not configured" wording sent agents off
 * probing ports, config.yaml and processes for a service that was never meant
 * to exist here.
 */
function cronUnsupportedHostError() {
    return new LocalMavisRuntimeError('Scheduled tasks are not supported on this runtime host. Cron is a desktop-app capability; ' +
        'do not retry, probe the runtime, or look for a service to start. ' +
        'Track the pending work in this conversation and ask the user to check back instead.', {
        code: 'CRON_UNSUPPORTED_HOST',
        status: 501,
    });
}
function requireCronAdapter(ctx) {
    if (!ctx.cronAdapter)
        throw cronUnsupportedHostError();
    return ctx.cronAdapter;
}
function requireCronModelResolver(ctx) {
    const adapter = requireCronAdapter(ctx);
    if (!adapter.resolveModel) {
        throw new LocalMavisRuntimeError('Cron model resolution is not supported on this legacy runtime host.', {
            code: 'CRON_MODEL_RESOLUTION_UNAVAILABLE',
            status: 501,
        });
    }
    return adapter.resolveModel.bind(adapter);
}
function requireMcpAdapter(ctx) {
    if (!ctx.mcpAdapter) {
        throw new LocalMavisRuntimeError('Local MCP settings service is not configured', {
            code: 'MCP_SETTINGS_UNAVAILABLE',
            status: 503,
        });
    }
    return ctx.mcpAdapter;
}
function requireSessionAdapter(ctx) {
    if (!ctx.sessionAdapter) {
        throw new LocalMavisRuntimeError('Local session service is not configured', {
            code: 'SESSION_UNAVAILABLE',
            status: 503,
        });
    }
    return ctx.sessionAdapter;
}
function toAdapterCronSession(ctx, session) {
    if (session.mode === 'new')
        return { mode: 'new' };
    return { mode: 'sessionId', sessionId: resolveSessionId(ctx, session.session_id) };
}
function toAdapterCronCreationSession(ctx, session) {
    if (session.mode === 'new')
        return { mode: 'new' };
    // `fixed` is a creation-only sentinel for a dedicated conversation. The
    // runtime already binds a missing target on the first run, so translate it
    // into the same pending shape the desktop UI sends and never persist the
    // literal or resolve it as a session.
    const { session_id: sessionId } = session;
    if (sessionId === undefined || isCronFixedSessionId(sessionId)) {
        return { mode: 'sessionId' };
    }
    return { mode: 'sessionId', sessionId: resolveSessionId(ctx, sessionId) };
}
function validateCronCreationOwnerInput(value, refinement) {
    if (value.session.mode === 'new' || !isBoundCronCreationSession(value.session)) {
        if (!value.agent_name?.trim()) {
            refinement.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['agent_name'],
                message: 'agent_name is required when creating a new target session',
            });
        }
        return;
    }
    if (value.agent_name !== undefined) {
        refinement.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['agent_name'],
            message: 'agent_name must be omitted when session.mode=sessionId',
        });
    }
}
/** 只有真实会话 ID 才是已绑定目标；`fixed` 与缺 ID 都要求 `agent_name`。 */
function isBoundCronCreationSession(session) {
    return session.mode === 'sessionId' && !isCronDedicatedSessionTarget(session);
}
async function resolveCronCreationAgentName(ctx, rawAgentName, session, signal) {
    if (session.mode === 'sessionId' && session.sessionId !== undefined) {
        return resolveCronTargetAgentName(ctx, session.sessionId, signal);
    }
    if (!rawAgentName) {
        throw new LocalMavisValidationError('agent_name is required when creating a new target session');
    }
    return resolveAgentWriteName(ctx, rawAgentName, signal);
}
async function resolveCronTargetAgentName(ctx, sessionId, signal) {
    const response = await requireSessionAdapter(ctx).getSession({ sessionId }, signal);
    const session = response.session;
    if (!session) {
        throw new LocalMavisValidationError(`cron target session not found: ${sessionId}`, {
            code: 'CRON_SESSION_TARGET_NOT_FOUND',
            session_id: sessionId,
        });
    }
    if (session.archived) {
        throw new LocalMavisValidationError(`cron target session is archived: ${sessionId}`, {
            code: 'CRON_SESSION_TARGET_ARCHIVED',
            session_id: sessionId,
        });
    }
    const agentName = session.agentName?.trim();
    if (!agentName) {
        throw new LocalMavisValidationError(`cron target session has no agent owner: ${sessionId}`, {
            code: 'CRON_SESSION_TARGET_AGENT_MISSING',
            session_id: sessionId,
        });
    }
    try {
        const owner = await ctx.agentAdapter.getAgent({ name: agentName, include: 'identity' }, signal);
        if (owner.agent?.name)
            return agentName;
    }
    catch (error) {
        if (!isLocalRuntimeNotFound(error))
            throw error;
    }
    throw new LocalMavisValidationError(`cron target session agent not found: ${agentName}`, {
        code: 'CRON_SESSION_TARGET_AGENT_NOT_FOUND',
        session_id: sessionId,
        agent_name: agentName,
    });
}
async function validateCronUpdateTargetOwner(ctx, adapter, cronId, sessionId, signal) {
    const current = await adapter.getCron({ cronId }, signal);
    if (!current.task) {
        throw new LocalMavisValidationError(`cron task not found: ${cronId}`, {
            code: 'CRON_NOT_FOUND',
            cron_id: cronId,
        });
    }
    const targetAgentName = await resolveCronTargetAgentName(ctx, sessionId, signal);
    const cronAgentName = current.task.agentName?.trim();
    if (!cronAgentName) {
        throw new LocalMavisValidationError(`cron task has no agent owner: ${cronId}`, {
            code: 'CRON_AGENT_MISSING',
            cron_id: cronId,
        });
    }
    const [resolvedCronAgentName, resolvedTargetAgentName] = await Promise.all([
        resolveAgentWriteName(ctx, cronAgentName, signal),
        resolveAgentWriteName(ctx, targetAgentName, signal),
    ]);
    if (resolvedCronAgentName !== resolvedTargetAgentName) {
        throw new LocalMavisValidationError(`cron target session belongs to agent ${JSON.stringify(targetAgentName)}, expected ${JSON.stringify(cronAgentName)}`, {
            code: 'CRON_SESSION_TARGET_AGENT_MISMATCH',
            cron_id: cronId,
            session_id: sessionId,
        });
    }
}
function resolveSessionId(ctx, rawSessionId) {
    if (!isMeSentinel(rawSessionId))
        return rawSessionId;
    if (!ctx.currentSessionId) {
        throw new LocalMavisValidationError('cannot resolve "me" placeholder for session_id: runtime context has no sessionId', { session_id: rawSessionId, reason: 'missing_current_session' });
    }
    return ctx.currentSessionId;
}
async function resolveAgentReadName(ctx, rawName, signal) {
    const name = rawName.trim();
    if (isMeSentinel(name)) {
        if (!ctx.currentAgentName) {
            throw new LocalMavisValidationError('cannot resolve "me" placeholder for agent_name: runtime context has no agentName', { agent_name: rawName, reason: 'missing_current_agent' });
        }
        return ctx.currentAgentName;
    }
    return (await ctx.agentAdapter.resolveAgentReadScope(name, signal)).canonicalName;
}
async function resolveAgentWriteName(ctx, rawName, signal) {
    const name = rawName.trim();
    if (isMeSentinel(name)) {
        if (!ctx.currentAgentName) {
            throw new LocalMavisValidationError('cannot resolve "me" placeholder for agent_name: runtime context has no agentName', { agent_name: rawName, reason: 'missing_current_agent' });
        }
        return ctx.currentAgentName;
    }
    return ctx.agentAdapter.resolveAgentWriteTarget(name, signal);
}
async function resolveAgentExactName(ctx, rawName, signal) {
    const name = rawName.trim();
    if (isMeSentinel(name)) {
        if (!ctx.currentAgentName) {
            throw new LocalMavisValidationError('cannot resolve "me" placeholder for agent_name: runtime context has no agentName', { agent_name: rawName, reason: 'missing_current_agent' });
        }
        return ctx.currentAgentName;
    }
    return ctx.agentAdapter.requireExactAgentKey(name, signal);
}
function substituteMe(value, currentAgentName, currentSessionId) {
    return substituteMeValue(value, currentAgentName, currentSessionId, '');
}
function substituteMeValue(value, currentAgentName, currentSessionId, path) {
    if (Array.isArray(value)) {
        return value.map((item, idx) => substituteMeValue(item, currentAgentName, currentSessionId, `${path}[${idx}]`));
    }
    if (!value || typeof value !== 'object')
        return value;
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
        const childPath = path ? `${path}.${key}` : key;
        if (key === 'agent_name') {
            // Agent-name sentinel resolution is intentionally left to the explicit
            // read/write/exact seam; replacing it here would erase persisted-owner
            // exact semantics for `me` before the seam can see it.
            out[key] = raw;
            continue;
        }
        if ((key === 'session_id' || key === 'parent_session_id') && isMeSentinel(raw)) {
            if (!currentSessionId) {
                throw new LocalMavisValidationError(`cannot resolve "me" placeholder for ${childPath}: runtime context has no sessionId`, { field: childPath, reason: 'missing_current_session' });
            }
            out[key] = currentSessionId;
            continue;
        }
        out[key] = substituteMeValue(raw, currentAgentName, currentSessionId, childPath);
    }
    return out;
}
function isMeSentinel(value) {
    return isMeSessionSentinel(value);
}
/** 读取创建入口的原始 `session.session_id`，供替换与校验之前的判定使用。 */
function cronCreationSessionId(rawArgs) {
    const session = rawArgs?.session;
    if (!session || typeof session !== 'object')
        return undefined;
    return session.session_id;
}
function success(command, response) {
    return { ok: true, command, response };
}
function failure(command, kind, message, extra = {}) {
    return { ok: false, command, error: { kind, message, ...extra } };
}
class LocalMavisValidationError extends Error {
    details;
    constructor(message, details = {}) {
        super(message);
        this.details = details;
        this.name = 'LocalMavisValidationError';
    }
}
class LocalMavisRuntimeError extends Error {
    status;
    code;
    constructor(message, details = {}) {
        super(message);
        this.name = 'LocalMavisRuntimeError';
        this.status = details.status;
        this.code = details.code;
    }
}
const INPUT_CONDITION_ERROR_CODES = new Set([
    'SESSION_UPDATE_INVALID_FIELD',
    'SESSION_INTERRUPT_SELF',
    'SESSION_INTERRUPT_TURN_MISMATCH',
    'SESSION_CREATE_NO_CALLER',
    'SESSION_CREATE_INVALID_CONTENT',
    'SESSION_CREATE_UNKNOWN_AGENT',
    'SESSION_CREATE_INVALID_WORKSPACE',
    'SESSION_CREATE_MODEL_UNRESOLVED',
]);
/**
 * Kind for a session error code. Input and precondition codes are validation;
 * an admission failure is validation only when the same input would fail again.
 * Everything else is a runtime failure. Status is not consulted.
 */
export function sessionCommandErrorKind(code, reason) {
    if (code === 'SESSION_CREATE_ADMISSION_FAILED') {
        return reason === 'invalid-input' ? 'validation' : 'local_runtime';
    }
    return INPUT_CONDITION_ERROR_CODES.has(code) ? 'validation' : 'local_runtime';
}
function errorToFailure(command, error) {
    if (error instanceof LocalMavisValidationError) {
        return failure(command, 'validation', error.message, error.details);
    }
    if (error instanceof LocalMavisCronUnsupportedError) {
        return failure(command, 'validation', error.message, {
            code: error.code,
            parameter: error.parameter,
        });
    }
    if (error instanceof LocalMavisCronValidationError) {
        return failure(command, 'validation', error.message, { code: error.code });
    }
    if (error instanceof LocalMavisRuntimeError) {
        return failure(command, 'local_runtime', error.message, {
            status: error.status,
            code: error.code,
        });
    }
    if (isLocalRuntimeError(error)) {
        // These codes name bad input or a precondition, even though the runtime
        // reports them with a status. Everything else with a status stays a runtime failure.
        const kind = sessionCommandErrorKind(error.code ?? '', error.reason);
        return failure(command, kind, error.message, {
            status: error.status,
            code: error.code,
            ...(error.sessionId ? { session_id: error.sessionId } : {}),
            ...(error.turnId ? { turn_id: error.turnId } : {}),
            ...(error.requestedTurnId ? { requested_turn_id: error.requestedTurnId } : {}),
            ...(error.reason ? { reason: error.reason } : {}),
            ...(error.field ? { field: error.field } : {}),
        });
    }
    if (error instanceof Error) {
        if (error.name === 'AbortError')
            return failure(command, 'unknown', 'aborted', { aborted: true });
        return failure(command, 'unknown', error.message, { name: error.name });
    }
    return failure(command, 'unknown', String(error));
}
function isLocalRuntimeError(error) {
    return error instanceof Error && ('status' in error || 'code' in error);
}
function isLocalRuntimeNotFound(error) {
    return isLocalRuntimeError(error) && (error.status === 404 || error.code === 'AGENT_NOT_FOUND');
}
function normalizeCommand(raw) {
    return normalizeMavisCommand(raw);
}
function isKnownCommand(command) {
    return KNOWN_COMMANDS.includes(command);
}
function suggestCommands(unknown) {
    const scored = KNOWN_COMMANDS.map((name) => ({ name, score: sharedPrefixLen(name, unknown) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 5).map((item) => item.name);
}
function sharedPrefixLen(a, b) {
    const max = Math.min(a.length, b.length);
    let i = 0;
    while (i < max && a[i] === b[i])
        i += 1;
    return i;
}
function formatZodError(error) {
    return error.issues
        .map((issue) => {
        const path = issue.path.length ? issue.path.join('.') : '<root>';
        return `${path}: ${issue.message}`;
    })
        .join('; ');
}
//# sourceMappingURL=local-mavis.js.map