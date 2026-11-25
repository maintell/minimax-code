import { isLightweightRootSession } from './preparation/session-read.js';
const AGENT_CONFIG_ALLOWLIST = [
    'system_prompt',
    'tools',
    'skills',
    'hooks',
    'permission_policy',
    'team',
    'title',
    'description',
    'memories',
    'persona',
    'display_name',
    'timezone',
    'locale',
    'agent_id',
    'system_reminders',
    'subagent_types',
    'creation_source',
    'background_task_enabled',
    'resourceAgentName',
    'builtinCapabilities',
    'computerUseActive',
    'desktopPluginSkills',
    'ptc_enabled',
    'capability_ceiling',
    'agent_profile',
];
const MODEL_ALLOWLIST = [
    'provider',
    'provider_id',
    'providerId',
    'model_id',
    'modelId',
    'variant',
    'thinking_level',
    'thinkingLevel',
    'base_url',
    'baseUrl',
    'capabilities',
    'context_window',
    'contextWindow',
    'max_tokens',
    'maxTokens',
];
export class AgentHostAssemblyContextValidationError extends Error {
    field;
    name = 'AgentHostAssemblyContextValidationError';
    constructor(field) {
        super(`AgentHost assembly context ${field} is not a secret-free URL.`);
        this.field = field;
    }
}
export function createSecretFreeTurnAssemblyContext(scope) {
    const { input, canonicalUserInput } = scope;
    const context = createSecretFreeModelContextAssemblyContext({
        sessionId: input.lease.sessionId,
        turnId: input.lease.turnId,
        session: scope.session,
        agent: scope.agent,
        preparation: scope.preparation,
        history: scope.history,
    });
    const turnIntent = projectTurnIntent(input.request.provenance);
    // The session record is the source of truth: a promoted SideChat keeps the
    // sidechat_mode marker in its history but becomes visible. Same rule as
    // isConversationMutationEligibleSession.
    const sideChat = Boolean(scope.session.sideChatOrigin) && scope.session.visibility === 'hidden';
    const outputSchema = input.request.outputContract?.type === 'json_schema'
        ? input.request.outputContract.schema
        : undefined;
    return {
        ...context,
        userInput: { text: canonicalUserInput.text },
        // A continuation re-enters the loop without appending a message, so this
        // Turn renders no user prompt prefix that has to reach the model.
        sendsUserMessage: input.request.executionMode !== 'continuation',
        ...nextStepContext(input, scope.session, sideChat, turnIntent?.kind),
        ...(outputSchema !== undefined || scope.preparation.outputRevisionInstruction !== undefined
            ? {
                outputContract: {
                    ...(outputSchema === undefined ? {} : { schema: outputSchema }),
                    ...(scope.preparation.outputRevisionInstruction === undefined
                        ? {}
                        : { revisionInstruction: scope.preparation.outputRevisionInstruction }),
                },
            }
            : {}),
        ...(turnIntent ? { turnIntent } : {}),
        ...(scope.plan ? { plan: scope.plan } : {}),
        ...(scope.promptRead ? { promptRead: scope.promptRead } : {}),
    };
}
export function createSecretFreeModelContextAssemblyContext(scope) {
    const { sessionId, turnId, session, agent, preparation, history } = scope;
    const model = projectResolvedModel(preparation);
    return {
        sessionId,
        turnId,
        agentName: agent.agentName,
        workspaceDir: session.workspaceDir,
        agentConfig: {
            ...projectAllowedFields(preparation.agentConfig, AGENT_CONFIG_ALLOWLIST),
            model,
            // Secret-free advisor binding: the tool catalog offers the advisor tool only with it,
            // and the advisor tool reads its model group from it.
            ...(preparation.advisor ? { advisor: { ...preparation.advisor } } : {}),
            ...(isLightweightRootSession(session) ? { lightweightRoot: true } : {}),
        },
        model,
        history,
        ...(session.miniAppOrigin
            ? { sessionOrigin: { miniApp: { pluginId: session.miniAppOrigin.pluginId } } }
            : {}),
    };
}
function projectTurnIntent(provenance) {
    const cloudHandoff = readRecord(provenance.sourceContext?.cloudHandoff);
    if (cloudHandoff.trigger === 'slash') {
        return { kind: 'cloud-handoff', attributes: { trigger: 'slash' } };
    }
    // The Goal verifier child is an ordinary `task` delegation; the run id in its
    // origin is what lets the host attach the verification contract and this
    // run's execution caps to that one Turn.
    if (provenance.source === 'task') {
        return projectGoalVerifierIntent(readRecord(provenance.sourceContext?.origin));
    }
    if (provenance.source === 'code_review') {
        return projectCodeReviewIntent(readRecord(provenance.sourceContext?.review));
    }
    return undefined;
}
function projectGoalVerifierIntent(origin) {
    const verifier = readRecord(origin.goalVerifier);
    if (typeof verifier.runId !== 'string' ||
        verifier.runId.trim().length === 0 ||
        typeof verifier.profile !== 'string' ||
        verifier.profile.trim().length === 0) {
        return undefined;
    }
    return {
        kind: 'goal-verifier',
        attributes: { runId: verifier.runId, profile: verifier.profile },
    };
}
function projectCodeReviewIntent(review) {
    if (review.scope !== 'local_changes' ||
        !['slash', 'natural_language', 'subagent'].includes(String(review.trigger))) {
        return undefined;
    }
    return {
        kind: 'code-review',
        attributes: {
            trigger: String(review.trigger),
            scope: 'local_changes',
        },
    };
}
function projectResolvedModel(preparation) {
    const configured = readRecord(preparation.agentConfig.model);
    const resolved = preparation.llm.model;
    const projected = projectAllowedFields(configured, MODEL_ALLOWLIST);
    return {
        ...projected,
        provider: resolved.provider,
        model_id: resolved.id,
        context_window: resolved.contextWindow,
        max_tokens: resolved.maxTokens,
    };
}
function projectAllowedFields(input, allowlist) {
    const entries = allowlist.flatMap((key) => {
        const value = input[key];
        return value === undefined || isSensitiveConfigKey(key)
            ? []
            : [[key, projectConfigValue(key, value)]];
    });
    return Object.fromEntries(entries);
}
function projectConfigValue(key, value) {
    return isBaseUrlKey(key) ? validateSecretFreeBaseUrl(key, value) : projectNestedConfig(value);
}
function projectNestedConfig(value) {
    if (Array.isArray(value))
        return value.map(projectNestedConfig);
    if (!isRecord(value))
        return value;
    return Object.fromEntries(Object.entries(value).flatMap(([key, nested]) => isSensitiveConfigKey(key) ? [] : [[key, projectConfigValue(key, nested)]]));
}
function validateSecretFreeBaseUrl(field, value) {
    try {
        if (typeof value !== 'string')
            throw new TypeError('Base URL must be a string.');
        const parsed = new URL(value);
        if (parsed.username || parsed.password || parsed.search || parsed.hash) {
            throw new TypeError('Base URL contains non-public URL components.');
        }
        return value;
    }
    catch {
        throw new AgentHostAssemblyContextValidationError(field);
    }
}
function isBaseUrlKey(key) {
    return key === 'base_url' || key === 'baseUrl';
}
function isSensitiveConfigKey(key) {
    const normalized = key.replaceAll(/[_-]/gu, '').toLowerCase();
    if (normalized === 'maxtokens')
        return false;
    return (normalized === 'token' ||
        normalized.endsWith('token') ||
        normalized.endsWith('tokens') ||
        ['apikey', 'authorization', 'secret', 'password', 'credential', 'privatekey'].some((fragment) => normalized.includes(fragment)));
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function readRecord(value) {
    return isRecord(value) ? value : {};
}
/** The turn's input came through an IM channel, directly or in a queued batch. */
export function arrivedThroughChannel(request) {
    return Boolean(request.input.channelContext ||
        request.input.queuedMessages?.some((message) => message.channelContext));
}
const FOREGROUND_USER_SOURCES = new Set([
    'api',
    'conversation-mutation',
    'questionnaire',
    'turn-continuation',
]);
/**
 * Nobody is waiting, but the card stays in the Session until the user reads the result.
 * A message from another Session counts: a reminder or a peer drove the Turn, not the user.
 */
const UNATTENDED_CARD_SOURCES = new Set([
    'cron',
    'background-task',
    'communication',
]);
function nextStepContext(input, session, sideChat, turnIntentKind) {
    const sessionEligible = isNextStepSession(session, sideChat);
    return {
        nextStepSessionEligible: sessionEligible,
        nextStepEligible: sessionEligible && isNextStepTurn(input, turnIntentKind),
        nextStepUnattended: UNATTENDED_CARD_SOURCES.has(input.request.provenance.source),
        nextStepReplyOnly: sideChat,
    };
}
/**
 * Sessions that carry wrap_up. Decided by the Session alone: every Turn of the Session
 * then sends the same system prompt and tools, which keeps the request prefix cached.
 * This is the only gate for task children too: the extension registers wrap_up after the local
 * catalog, so tool lists cannot remove it.
 */
function isNextStepSession(session, sideChat) {
    return ((session.sessionKind === 'conversation' || session.sessionKind === 'cron') &&
        (session.visibility !== 'hidden' || sideChat) &&
        !session.miniAppOrigin);
}
/**
 * Turns that may show a card: a send, an edited resend, Continue, an answered question, a cron
 * run, a background-task notice or a message from another Session. IM input is left out, whatever its source, because those replies carry no clickable answer;
 * an answer that resumes a Goal's turn belongs to the Goal, which never shows a card.
 */
function isNextStepTurn(input, turnIntentKind) {
    const provenance = input.request.provenance;
    return ((FOREGROUND_USER_SOURCES.has(provenance.source) ||
        UNATTENDED_CARD_SOURCES.has(provenance.source)) &&
        !arrivedThroughChannel(input.request) &&
        readRecord(provenance.sourceContext?.questionnaireOwner).kind !== 'thread-goal' &&
        !turnIntentKind?.startsWith('goal-'));
}
//# sourceMappingURL=assembly-context.js.map