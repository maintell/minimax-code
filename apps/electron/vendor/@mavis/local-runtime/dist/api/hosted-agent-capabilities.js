import { memoryContextCharsUsed } from '@mavis/shared/memory-context-budget';
import { isLegacyMemoryRecallEnabled, isMemoryV2Enabled } from '@mavis/config';
import { join } from 'node:path';
import { AuthStorage } from '@earendil-works/pi-coding-agent/auth-storage';
import { resolveAgentCapabilities } from '@mavis/config';
import { createChildBashLifecycle } from '../background-task/child-bash-lifecycle.js';
import { isLocalChildWorkerSession } from '../sessions/session-policy.js';
import { createHostedBackgroundReminderCapabilities } from '../background-task/hosted-reminder-capabilities.js';
import { HttpRemoteTokenCounter } from '../context/remote-token-counter.js';
import { createHostedAgentContextUsageCapabilities } from '../context/hosted-agent-context-usage-capabilities.js';
import { recordMemorySessionTerminal, v1AutoMemoryWritesStopped, } from '../memory/local-memory-orchestration.js';
import { PI_TURN_RUNNER_LOGGER } from '../runtime/pi-turn-observability.js';
import { createWebsiteDeployAfterLlmHook, createWebsiteDeployAfterToolCallHook, WebsiteDeployTurnState, } from '../website-deploy/index.js';
import { projectWebsiteDeployRuntimeEvent } from '../website-deploy/projection-writer.js';
import { prepareDeployedSources } from '../website-management/deployed-website-source.js';
import { createHostedAttachmentCapabilities } from './hosted-agent-attachments.js';
import { toLocalSessionRecord } from './hosted-agent-session.js';
import { applyHostedCapabilityRestrictions } from './hosted-agent-capability-restrictions.js';
import { createHostedAgentPermissionCapabilities } from './hosted-agent-permission-capabilities.js';
import { HostedReviewCapability } from '../review/hosted-capability.js';
import { resolveBuiltinReviewPromptDir } from '../review/preparation.js';
import { classifyThreadGoalFailure } from '../thread-goal/failure-classification.js';
import { createHostedSkillCapabilities } from './hosted-agent-skill-capabilities.js';
export { toLocalSessionRecord } from './hosted-agent-session.js';
/**
 * Narrow, immutable v1 capability bundle consumed by the v2 composition root.
 * It exposes product-owned facts and adapters, never the v1 Host itself.
 */
export function createHostedAgentCapabilities(host, restrictions = {}) {
    const review = new HostedReviewCapability({
        reviewPromptDir: host.reviewPromptDir ?? resolveBuiltinReviewPromptDir(),
        configGetter: host.configGetter,
        ...(host.runtimeConversation ? { conversation: host.runtimeConversation } : {}),
        ...(host.metricsClient ? { metricsClient: host.metricsClient } : {}),
        remoteCounter: new HttpRemoteTokenCounter({
            timeoutMs: 3_000,
            ...(host.fetchImpl ? { fetchFn: host.fetchImpl } : {}),
        }),
        nowMs: host.nowMs,
        // 两个读取器在最小 host（单测夹具、精简装配）上可缺席；消费方本就接受 undefined。
        promptSnapshots: () => host.getPromptSnapshots?.(),
        internalTurnPromptReads: () => host.getInternalTurnPromptReads?.(),
    });
    return {
        config: host.configGetter,
        runnerLogger: PI_TURN_RUNNER_LOGGER,
        llmRequestFailureHook: host.llmRequestFailureHook,
        observeLLMRequest: host.observeLLMRequest,
        authContextGetter: host.authContextGetter,
        authContextInvalidator: host.authContextInvalidator,
        routingContextGetter: host.routingContextGetter,
        fetchImpl: host.fetchImpl,
        providerAuthGetter: (provider) => AuthStorage.create(join(host.configGetter().dataDir, 'codex-auth.json')).getApiKey(provider, {
            includeFallback: false,
        }),
        skills: createHostedSkillCapabilities(host, restrictions),
        memory: host.memoryFacade,
        toolSources: {
            resolve: (input) => {
                const builtinCapabilities = applyHostedCapabilityRestrictions(input.builtinCapabilities ?? resolveAgentCapabilities(), restrictions);
                const memoryGloballyEnabled = !restrictions.disableMemory &&
                    host.configGetter().memory?.enabled !== false &&
                    !isMemoryV2Enabled(host.configGetter().memory);
                const memoryReadEnabled = memoryGloballyEnabled &&
                    isLegacyMemoryRecallEnabled(host.configGetter().memory, input.resourceAgentName) &&
                    input.session.memoryPolicy?.recallEnabled !== false;
                const memoryWriteEnabled = memoryGloballyEnabled &&
                    // v2 写入互斥（§15.16）：v2 接管后 v1 记忆工具停写，读取注入保留。
                    !v1AutoMemoryWritesStopped(host.configGetter().memory) &&
                    input.session.memoryPolicy?.writeEnabled !== false;
                return host.buildOwnerTurnToolSources({
                    session: toLocalSessionRecord(input.session),
                    resourceAgentName: input.resourceAgentName,
                    ...(input.excludeAgentResources ? { excludeAgentResources: true } : {}),
                    ...(input.expectedAgentInstanceId
                        ? { expectedAgentInstanceId: input.expectedAgentInstanceId }
                        : {}),
                    ...(input.skipAgentResolution ? { skipAgentResolution: true } : {}),
                    builtinCapabilities,
                    toolsDisabled: input.toolsDisabled,
                    computerUseActive: input.computerUseActive,
                    memoryEnabled: memoryGloballyEnabled,
                    memoryReadEnabled,
                    memoryWriteEnabled,
                    ...(input.agentMemoryEnabled === undefined
                        ? {}
                        : { memoryAgentScopeEnabled: input.agentMemoryEnabled }),
                    ...(input.agentMemoryReadNames === undefined
                        ? {}
                        : { memoryReadAgentNames: input.agentMemoryReadNames }),
                    ...(input.allowedSkillNames === undefined
                        ? {}
                        : { allowedSkillNames: input.allowedSkillNames }),
                    ...(input.allowedExtensionSkillNames === undefined
                        ? {}
                        : { allowedExtensionSkillNames: input.allowedExtensionSkillNames }),
                    cronEnabled: !restrictions.disableCron,
                    ...(restrictions.disabledBuiltinSkillNames
                        ? { disabledBuiltinSkillNames: restrictions.disabledBuiltinSkillNames }
                        : {}),
                    ...(restrictions.resumeCodexAvailable === true ? { resumeCodexAvailable: true } : {}),
                    ...(input.miniappAvailable === true ? { miniappAvailable: true } : {}),
                    ...(input.desktopCapabilities ? { desktopCapabilities: input.desktopCapabilities } : {}),
                });
            },
        },
        review,
        websiteDeploy: {
            materializeSources: (input) => prepareDeployedSources({
                authContextGetter: host.authContextGetter,
                routingContextGetter: host.routingContextGetter,
                fetchImpl: host.fetchImpl,
            }, { content: input.content, signal: input.signal }, input.workspaceDir),
            createTurnProjection: () => {
                const state = new WebsiteDeployTurnState();
                return {
                    projectRuntimeEvent: (event) => projectWebsiteDeployRuntimeEvent(event, state),
                    afterToolCallHook: createWebsiteDeployAfterToolCallHook(state),
                    afterLlmCallHook: createWebsiteDeployAfterLlmHook(state),
                };
            },
        },
        createChildBashLifecycle: (input) => isLocalChildWorkerSession(input.session)
            ? createChildBashLifecycle(host.backgroundTaskService, {
                sessionId: input.session.sessionId,
                turnId: input.turnId,
                signal: input.signal,
            })
            : undefined,
        checkpointState: {
            captureSubagents: (input) => host.backgroundTaskService.captureCheckpointSnapshot(input.sessionId),
        },
        reminders: {
            ...createHostedBackgroundReminderCapabilities(host.backgroundTaskService),
            buildSystem: async (input) => {
                const session = {
                    ...toLocalSessionRecord(input.session),
                    agentName: input.resourceAgentName,
                };
                const reminderSession = {
                    ...host.localDataCollector.toSessionInfo(session, undefined, {
                        recallEnabled: input.session.memoryPolicy?.recallEnabled !== false,
                        writeEnabled: input.session.memoryPolicy?.writeEnabled !== false,
                    }),
                    environmentInSystemPrompt: true,
                    memoryContextCharsUsed: memoryContextCharsUsed(input.contextUsagePromptRanges),
                };
                const reminderMessage = host.localDataCollector.toMessage(input.promptText, input.turnId, input.model);
                const reminder = await host.systemReminderService.buildReminder(reminderSession, reminderMessage, {
                    ...(input.deferTelemetry ? { deferTelemetry: true } : {}),
                    ...(input.availableSkillNames
                        ? { availableSkillNames: input.availableSkillNames }
                        : {}),
                });
                return {
                    content: asSingleReminderBlock(reminder.text),
                    ...(reminder.diagnostic !== undefined ? { diagnostic: reminder.diagnostic } : {}),
                    ...(reminder.finalizeTelemetry
                        ? {
                            finalizeTelemetry: (final) => reminder.finalizeTelemetry?.({
                                text: final.content,
                                ...(final.diagnostic !== undefined ? { diagnostic: final.diagnostic } : {}),
                            }),
                        }
                        : {}),
                };
            },
        },
        attachments: createHostedAttachmentCapabilities(host),
        permissions: createHostedAgentPermissionCapabilities(host),
        hooks: {
            beforeToolCall: (...args) => host.hookService.beforeToolCall(...args),
            afterToolCall: (...args) => host.hookService.afterToolCall(...args),
        },
        reviewContent: host.contentSafetyChecker,
        fileChanges: {
            begin: async (input) => {
                await host.turnFileChanges.begin(toLocalSessionRecord({
                    sessionId: input.sessionId,
                    agentName: input.agentName,
                    workspaceDir: input.workspaceDir,
                    sessionType: 'branch',
                    archived: false,
                    status: 'started',
                    createdAtMs: host.nowMs(),
                    updatedAtMs: host.nowMs(),
                }), input.turnId);
            },
            finalize: (input) => host.turnFileChanges.finalizeLatestPending(input.sessionId, {
                turnId: input.turnId,
                ...(input.assistantMessageId ? { assistantMessageId: input.assistantMessageId } : {}),
            }),
            markFailed: (input) => host.turnFileChanges.markPendingFailed(input.sessionId, input.turnId),
            takeToolProgress: (input) => host.turnFileChanges.takeToolArtifactProgress(input),
        },
        turnLifecycle: {
            started: (input) => host.beginHostedTurn(input),
            checkBudget: (input) => host.checkHostedTurnBudget(input),
            classifyFailure: classifyThreadGoalFailure,
            settled: (input) => host.settleHostedTurn(input),
            abandoned: (input) => host.abandonHostedTurn(input),
        },
        terminalMemory: {
            record: (input) => {
                if (restrictions.disableMemory ||
                    host.configGetter().memory?.enabled === false ||
                    // v2 写入互斥（§15.16）：daily 记账是 daily digest 的唯一来源，一并停写。
                    v1AutoMemoryWritesStopped(host.configGetter().memory)) {
                    return Promise.resolve();
                }
                return recordMemorySessionTerminal({
                    ...input,
                    nowMs: host.nowMs,
                    memoryFacade: host.memoryFacade,
                    emitBusEvent: (type, payload) => host.emitBusEvent(type, payload),
                });
            },
        },
        ...createHostedAgentContextUsageCapabilities(host),
        reportFailure: (sessionId, message) => host.reportPiTurnFailure(sessionId, message),
        metricsClient: host.metricsClient,
    };
}
function asSingleReminderBlock(text) {
    const normalized = text
        .trim()
        .replaceAll(/<\s*system-reminder\s*>/giu, '')
        .replaceAll(/<\s*\/\s*system-reminder\s*>/giu, '')
        .trim();
    return normalized ? ['<system-reminder>', normalized, '</system-reminder>'].join('\n') : '';
}
//# sourceMappingURL=hosted-agent-capabilities.js.map