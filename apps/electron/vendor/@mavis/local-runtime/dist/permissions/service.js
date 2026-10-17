/**
 * Wires the permission system into pi-agent local-runtime.
 *
 * Builds a thin facade (`LocalPermissionFacade`) backed by:
 *   - the deterministic decision pipeline (Permission Core by default,
 *     `PermissionEngine` as checker registry and explicit rollback, plus the
 *     `evaluateBashStatic` / `decideUnknownToolPathCapabilities` primitives —
 *     see `permission/tools/`)
 *   - `HttpCloudGatewayClient` hitting the
 *     `POST /mavis/api/v1/permission/check` endpoint (the cloud side is a
 *     gemini-flash gateway that owns the classifier prompt)
 *   - `renderConversationContext` for the cloud gateway's
 *     `conversation_context` payload
 *
 * Facade surface:
 *   - `checkPermission(params): Promise<{behavior, reason, requestId?, ruleContents?, …}>`
 *     — consumed by `api/routes/permissions.ts` and the
 *     `beforeLocalToolCall` hook. Routes own the pending-request map + waiter
 *     + permission.ask Global Event flow; the facade is a pure decision function
 *     from their POV.
 *   - `runStartupAliasSeed(): Promise<void>` — seeds acceptEdits allow rules.
 *
 * Wire surface:
 *   - HTTP endpoints (`/permission/{rules,check,update,requests,batch-reply}`).
 *   - UI `'allowOnce'` / `'allowAlways'` / `'deny'` decision strings.
 *   - PermissionMode (`default` / `auto` / `bypassPermissions`); the facade
 *     maps these internally to an `AskForApproval` policy.
 *
 * Region / build-env / managed-auth wiring goes through `configurePermissionHost`
 * so the HttpCloudGatewayClient's region routing + Bearer token resolver work.
 */
import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { getConfig, getRuntimeRegion, getRuntimeBuildEnv } from '@mavis/config';
import { configurePermissionHost, AUTO_CLASSIFIER_TIMEOUT_MS_DEFAULT, } from '@mavis/permission';
import { logger as runtimeLogger } from '../common/logger.js';
import { readLocalPermissionMode } from '../api/host-helpers.js';
import { LocalPermissionFacade, } from './facade.js';
export function isLocalAgentResolverError(err) {
    if (!err || typeof err !== 'object')
        return false;
    const value = err;
    return typeof value.status === 'number' && typeof value.code === 'string';
}
function createPermissionHostLogger(bindings = {}) {
    const fields = (arg) => arg !== null && typeof arg === 'object' && !Array.isArray(arg)
        ? arg
        : { value: arg };
    const write = (level, arg, message, args = []) => {
        runtimeLogger[level]({
            ...bindings,
            ...fields(arg),
            ...(args.length > 0 ? { args } : {}),
        }, message ?? 'permission.internal');
    };
    return {
        trace: () => undefined,
        debug: () => undefined,
        info: (arg, message, ...args) => write('info', arg, message, args),
        warn: (arg, message, ...args) => write('warn', arg, message, args),
        error: (arg, message, ...args) => write('error', arg, message, args),
        fatal: (arg, message, ...args) => write('error', arg, message, args),
        child: (extra) => createPermissionHostLogger({ ...bindings, ...extra }),
    };
}
const permissionHostLogger = createPermissionHostLogger();
/**
 * Build a LocalPermissionService (= LocalPermissionFacade) wired to local-
 * runtime adapters, and register the permission host
 * ports. Idempotent host registration (last-write-wins per field), so calling
 * this alongside cron's `configureCronHost({ datetimeHelpers })` is safe.
 */
export function createLocalPermissionService(deps) {
    configurePermissionHost({
        runtimeConfigProvider: {
            getConfig: () => toRuntimeConfig(deps.configGetter()),
            getRuntimeRegion: () => resolveRegion(deps),
            getRuntimeBuildEnv: () => resolveBuildEnv(deps),
            isManagedRuntime: () => Boolean(readManagedToken(deps)),
        },
        managedAuthTokenGetter: () => readManagedToken(deps),
        promptProvider: {
            resolvePrompt: (name) => resolvePermissionPrompt(deps.configGetter(), name),
        },
        logger: permissionHostLogger,
        // No stage-2 local LLM injection — the cloud gateway is the only LLM path.
    });
    const service = new LocalPermissionFacade({
        ruleStore: deps.ruleStore,
        pluginHookPermissionStore: deps.pluginHookPermissionStore,
        configGetter: deps.configGetter,
        getSessionById: deps.getSessionById,
        getLocalAgent: deps.getLocalAgent,
        messageStore: deps.messageStore,
        shellFamily: deps.shellFamily,
        metricsClient: deps.metricsClient,
    });
    // Fire-and-forget: when the persisted permissionMode is `acceptEdits`, seed
    // the global edit/write/apply_patch allow rules so the rest of the runtime
    // can treat the effective mode as `default`.
    void service.runStartupAliasSeed().catch(() => {
        // Swallow — startup seed is non-critical; the next check will surface
        // any persistent rule store failure.
    });
    return service;
}
function readManagedToken(deps) {
    const token = deps.authContextGetter?.()?.accessToken?.trim();
    return token || undefined;
}
let cachedLlmGatePrompt;
/**
 * Prompt provider — the cloud side owns the llm-gate-classifier prompt, but
 * this hook still serves tooling/tests that import the prompt text directly.
 */
function resolvePermissionPrompt(config, name) {
    if (config.beta?.promptOverride) {
        const override = readOptionalPrompt(path.join(config.dataDir, 'internal', 'prompts', `${name}.md`));
        if (override)
            return override;
    }
    if (name !== 'llm-gate-classifier')
        return undefined;
    cachedLlmGatePrompt ??= readFileSync(new URL('../../prompts/llm-gate-classifier.md', import.meta.url), 'utf-8');
    return cachedLlmGatePrompt;
}
function readOptionalPrompt(filePath) {
    try {
        const content = readFileSync(filePath, 'utf-8').trim();
        return content || undefined;
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return undefined;
        throw err;
    }
}
function toRuntimeConfig(local) {
    return {
        ...local,
        permissionMode: readLocalPermissionMode(local.permissionMode),
        permission: {
            policyOwner: local.permission?.policyOwner ?? getConfig().permission?.policyOwner ?? 'core',
            storageWriteVersion: local.permission?.storageWriteVersion ?? getConfig().permission?.storageWriteVersion ?? 2,
            classifierTimeoutMs: local.permission?.classifierTimeoutMs ??
                getConfig().permission?.classifierTimeoutMs ??
                AUTO_CLASSIFIER_TIMEOUT_MS_DEFAULT,
            userConfirmationEnabled: local.permission?.userConfirmationEnabled ??
                getConfig().permission?.userConfirmationEnabled ??
                true,
        },
        beta: { ...(local.beta ?? {}), promptOverride: local.beta?.promptOverride ?? false },
        provider: local.provider,
        defaultModel: local.defaultModel,
        defaultLightModel: local.defaultModel,
        dataDir: local.dataDir,
        agentsDir: path.join(local.dataDir, 'agents'),
    };
}
function resolveRegion(_deps) {
    return getRuntimeRegion();
}
function resolveBuildEnv(_deps) {
    return getRuntimeBuildEnv();
}
const _serviceCache = new WeakMap();
export function resolveLocalPermissionService(host) {
    let service = _serviceCache.get(host.permissionRules);
    if (!service) {
        service = createLocalPermissionService({
            configGetter: host.configGetter,
            authContextGetter: host.authContextGetter,
            ruleStore: host.permissionRules,
            pluginHookPermissionStore: host.pluginHookPermissionStore,
            getSessionById: (sessionId) => host.getSessionById(sessionId),
            getLocalAgent: (agentName) => host.agentRoutes.getLocalAgent(agentName),
            messageStore: resolvePermissionMessageSource(host),
            configUpdater: (body) => host.configUpdater(body),
            shellFamily: host.shellFamily,
            metricsClient: host.metricsClient,
        });
        _serviceCache.set(host.permissionRules, service);
    }
    return service;
}
export function resolvePermissionMessageSource(host) {
    return host.runtimeConversation
        ? createConversationPermissionMessageSource(host.runtimeConversation)
        : host.messageStore;
}
function createConversationPermissionMessageSource(conversation) {
    return {
        listRecentDisplayMessages: (sessionId, options) => listRecentConversationMessages(conversation, sessionId, options),
    };
}
async function listRecentConversationMessages(conversation, sessionId, options) {
    if (!Number.isFinite(options.limit) || options.limit <= 0)
        return [];
    return collectRecentConversationMessages({
        conversation,
        sessionId,
        options: { ...options, limit: Math.floor(options.limit) },
        newerMessages: [],
        seenCursors: new Set(),
    });
}
async function collectRecentConversationMessages(input) {
    const page = await input.conversation.query.listMessages(input.sessionId, {
        limit: 80,
        ...(input.before ? { before: input.before } : {}),
    });
    const matching = page.messages.flatMap((message) => {
        if (!isAgentMessageProtocol(message.raw))
            return [];
        if (input.options.role && message.raw.role !== input.options.role)
            return [];
        if (input.options.excludePermissionResponses && containsPermissionResponse(message.raw)) {
            return [];
        }
        return [message.raw];
    });
    const collected = [...matching, ...input.newerMessages];
    const nextCursor = page.nextCursor;
    if (collected.length >= input.options.limit ||
        !page.hasMore ||
        !nextCursor ||
        input.seenCursors.has(nextCursor)) {
        return collected.slice(-input.options.limit);
    }
    return collectRecentConversationMessages({
        ...input,
        before: nextCursor,
        newerMessages: collected,
        seenCursors: new Set([...input.seenCursors, nextCursor]),
    });
}
function isAgentMessageProtocol(value) {
    return (typeof value === 'object' &&
        value !== null &&
        typeof Reflect.get(value, 'msg_id') === 'string' &&
        Reflect.get(value, 'msg_id').trim().length > 0);
}
function containsPermissionResponse(message) {
    try {
        return JSON.stringify(message).includes('<permission-response>');
    }
    catch {
        return false;
    }
}
// Silence unused warnings for helpers reserved for facade future use.
void statSync;
//# sourceMappingURL=service.js.map