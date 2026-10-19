import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getRuntimeRegion } from '@mavis/config';
import { DAILY_RECENT_CAP_CHARS, MEMORY_SUMMARY_INJECTION_CAP_CHARS, MEMORY_TAIL_INJECTION_CAP_CHARS, MEMORY_CONTEXT_CAP_CHARS, createMemoryContextBudget, } from '@mavis/shared';
import { AgentFrameworkType, AgentRole, Role, SessionType, buildAgentMemoryUpdateBlock, buildDailyMemoryUpdateBlock, buildMemorySummaryUpdateBlock, buildMemoryTopicsBlock, buildUserMemoryUpdateBlock, } from '@mavis/system-reminder';
import { isLocalDirectTaskPurpose } from '../sessions/session-policy.js';
import { loadCliSunsetCandidates } from './cli-sunset-notice.js';
import { detectProjectInstructions } from '../project/instructions.js';
import { resolveLocalRuntimeLocale } from '../runtime/locale.js';
import { formatLocalDate } from './local-memory-store-utils.js';
import { agentDetailToIdentity, isBuiltinAgentDetail, isPersonaMissing, toCreationSource, } from './local-data-agent-profile.js';
export class LocalDataCollector {
    memory;
    input;
    baselines = new Map();
    constructor(memory, input) {
        this.memory = memory;
        this.input = input;
    }
    async collect(session, msg, turnCount) {
        const agentName = session.agentName?.trim();
        const memoryGloballyEnabled = this.input.memoryEnabled();
        const userMemoryEnabled = this.input.userMemoryEnabled?.() !== false;
        const reader = agentName ? this.input.agentFacts?.() : undefined;
        const factsAgentName = agentName;
        const detail = reader && factsAgentName
            ? await reader
                .getAgent({ name: factsAgentName, include: 'identity,persona' })
                .then((response) => response.agent)
                .catch((error) => {
                const candidate = Object(error);
                if (candidate.status === 404 || candidate.code === 'AGENT_NOT_FOUND') {
                    return undefined;
                }
                throw error;
            })
            : undefined;
        const agentMemoryEnabled = memoryGloballyEnabled &&
            isPrimaryAgent(agentName ?? '') &&
            detail !== undefined &&
            isTrustedPrimaryAgentDetail(detail);
        const memoryRecallEnabled = agentMemoryEnabled &&
            session.memoryRecallEnabled !== false &&
            this.input.memoryRecallEnabled?.(session.memoryExecutionTarget?.trim() || agentName || '') !==
                false;
        const memoryWriteEnabled = agentMemoryEnabled &&
            session.memoryWriteEnabled !== false &&
            this.input.memoryAutoWriteEnabled?.() !== false;
        const memoryAccessible = memoryRecallEnabled || memoryWriteEnabled;
        if (memoryAccessible && !agentName) {
            // No agent directory name → nothing to address agent-scoped memory against.
            // Silent "no memory" would make "why was no memory injected this turn" only
            // inferable by absence, so surface it as an event.
            this.input.emitBusEvent?.('memory.provider_agent_resolve_failed', {
                sessionId: session.sessionId,
                turnId: msg.turnId,
                agentName: session.agentName,
                error: 'session has no agentName',
            });
        }
        // SystemReminder tracks only the canonical writable Memory target. Retired
        // aliases are injected as explicitly read-only durable context by the
        // static system-prompt builder; they are not a second dynamic delta source.
        const canonicalSnapshot = memoryAccessible && agentName
            ? await this.collectCanonicalMemory(session, msg, agentName)
            : undefined;
        const userMemory = userMemoryEnabled ? await this.readUserMemory(session, msg) : undefined;
        const currentDaily = canonicalSnapshot
            ? await this.readCanonicalDaily(session, msg)
            : undefined;
        const canonicalAgentName = session.memoryExecutionTarget?.trim() || agentName || session.agentName;
        const previous = this.baselines.get(session.sessionId);
        const baseline = previous?.canonicalAgentName === canonicalAgentName ? previous : undefined;
        if ((memoryRecallEnabled && canonicalSnapshot) || userMemory !== undefined) {
            this.baselines.set(session.sessionId, {
                canonicalAgentName,
                ...(memoryRecallEnabled && canonicalSnapshot
                    ? {
                        main: canonicalSnapshot.main,
                        summary: canonicalSnapshot.summary,
                    }
                    : {}),
                ...(userMemory !== undefined ? { user: userMemory } : {}),
                ...(memoryRecallEnabled && canonicalSnapshot ? { daily: currentDaily } : {}),
            });
        }
        const identity = detail ? agentDetailToIdentity(detail) : null;
        const personaEnabled = session.builtinCapabilities?.persona.enabled !== false;
        const persona = personaEnabled && detail && factsAgentName
            ? await isPersonaMissing({
                agentConfigDir: detail.agentConfigDir ?? join(this.input.dataDir(), 'agents', factsAgentName),
                identityDisplayName: identity?.display_name,
                builtin: isBuiltinAgentDetail(detail),
                builtinPersona: detail.persona,
            })
            : undefined;
        const deltas = baseline && canonicalSnapshot ? diffMemory(baseline, canonicalSnapshot, currentDaily) : {};
        const userDelta = baseline && userMemory !== undefined && userMemory !== baseline.user
            ? userMemory.trim()
            : undefined;
        const memoryUpdates = limitMemoryUpdates({
            ...(memoryRecallEnabled ? deltas : {}),
            ...(memoryRecallEnabled && canonicalSnapshot?.summary.trim()
                ? { memorySummaryUpdate: canonicalSnapshot.summary.trim() }
                : {}),
            ...(userMemoryEnabled && userDelta ? { userMemoryUpdate: userDelta } : {}),
            ...(memoryRecallEnabled && turnCount <= 1 && canonicalSnapshot?.topics.length
                ? { memoryTopics: canonicalSnapshot.topics }
                : {}),
        }, MEMORY_CONTEXT_CAP_CHARS - (session.memoryContextCharsUsed ?? 0));
        const dataDir = this.input.dataDir();
        const workspaceDir = session.workspaceDir ?? process.cwd();
        const agentRole = detail
            ? detail.agentRole === 'orchestrator'
                ? 'orchestrator'
                : 'worker'
            : session.agentRole === AgentRole.Orchestrator
                ? 'orchestrator'
                : 'worker';
        const sessionType = session.sessionType === SessionType.Root ? 1 : 0;
        const userConfiguredName = this.input.userConfiguredName?.()?.trim();
        return {
            env: {
                environmentInSystemPrompt: session.environmentInSystemPrompt,
                workspaceDir,
                isDefaultWorkspace: session.isDefaultWorkspace ?? true,
                agentConfigDir: `${dataDir}/agents/${agentName}`,
                agentName,
                agentRole,
                sessionId: session.sessionId,
                sessionType,
                parentSessionId: session.parentSessionId ?? undefined,
                taskResultDelivery: session.taskResultDelivery,
                rootSessionId: session.rootSessionId,
                platform: process.platform,
                scene: 'local',
                date: this.input.formatDate(),
                dataDir,
                scratchpadPath: session.scratchpadPath,
                systemLocale: resolveLocalRuntimeLocale(),
                region: getRuntimeRegion(),
                projectInstructions: detectProjectInstructions(workspaceDir),
                ...(identity?.display_name ? { displayName: identity.display_name } : {}),
                ...(userConfiguredName ? { userConfiguredName } : {}),
            },
            turnCount,
            teamModeOff: true,
            ...(memoryWriteEnabled && this.input.proactiveMemoryEnabled?.() === true
                ? { proactiveMemoryEnabled: true }
                : {}),
            mavisEnabled: session.builtinCapabilities?.features.mavis !== false,
            ...(this.input.cronEnabled ? { cronEnabled: this.input.cronEnabled() } : {}),
            ...(identity ? { identity } : {}),
            ...(persona ? { personaMissing: persona.missing, personaPath: persona.personaPath } : {}),
            workspaceDir,
            isGitWorkspace: isGitCheckout(workspaceDir),
            isInsideWorktree: isInsideWorktree(workspaceDir),
            creationSource: toCreationSource(detail?.creationSource),
            ...memoryUpdates,
            ...(memoryWriteEnabled && canonicalSnapshot?.main.trim()
                ? {
                    memorySkillReminder: {
                        path: canonicalSnapshot.mainPath,
                        lines: canonicalSnapshot.mainLines,
                        sizeBytes: canonicalSnapshot.mainSizeBytes,
                    },
                }
                : {}),
            ...(memoryRecallEnabled && canonicalSnapshot && turnCount <= 1
                ? await this.collectCliSunsetNotice(canonicalSnapshot)
                : {}),
        };
    }
    async collectCanonicalMemory(session, msg, agentName) {
        try {
            return await this.memory.collectReminderMemory(agentName);
        }
        catch (err) {
            this.input.emitBusEvent?.('memory.provider_collect_failed', {
                sessionId: session.sessionId,
                turnId: msg.turnId,
                agentName,
                error: err instanceof Error ? err.message : String(err),
            });
            return undefined;
        }
    }
    async readUserMemory(session, msg) {
        try {
            return (await this.memory.getUserMemory()).content;
        }
        catch (err) {
            this.input.emitBusEvent?.('memory.provider_user_collect_failed', {
                sessionId: session.sessionId,
                turnId: msg.turnId,
                error: err instanceof Error ? err.message : String(err),
            });
            return undefined;
        }
    }
    async readCanonicalDaily(session, msg) {
        const agentName = session.memoryExecutionTarget?.trim() || session.agentName?.trim();
        if (!agentName)
            return '';
        try {
            const date = formatLocalDate(this.input.nowMs?.() ?? Date.now());
            return (await this.memory.getDaily(agentName, date)).content;
        }
        catch (err) {
            this.input.emitBusEvent?.('memory.provider_daily_collect_failed', {
                sessionId: session.sessionId,
                turnId: msg.turnId,
                agentName,
                error: err instanceof Error ? err.message : String(err),
            });
            return '';
        }
    }
    async collectCliSunsetNotice(memory) {
        const notice = await this.input.cliSunsetNotice?.evaluate(this.input.nowMs?.() ?? Date.now(), () => loadCliSunsetCandidates({
            mainPath: memory.mainPath,
            mainContent: memory.main,
            userPath: memory.userPath,
            userContent: memory.user,
            topicPaths: memory.topics.map((topic) => topic.path),
        }));
        return notice ? { cliSunsetMemoryNotice: notice } : {};
    }
    onSessionRemoved(sessionId) {
        this.baselines.delete(sessionId);
    }
    toSessionInfo(session, builtinCapabilities, memory) {
        const isRoot = session.sessionType === 'root';
        const runtimeAgentName = memory?.executionTarget?.trim() || session.agentName;
        return {
            sessionId: session.sessionId,
            // SystemReminder facts/persona/config are execution-scoped. The
            // persisted session owner remains available to lifecycle/event callers
            // through the original LocalSessionRecord and is never rewritten here.
            agentName: runtimeAgentName,
            agentRole: isPrimaryAgent(runtimeAgentName) ? AgentRole.Orchestrator : AgentRole.Worker,
            sessionType: isRoot ? SessionType.Root : SessionType.Branch,
            frameworkType: session.runtime === 'pi-agent' ? AgentFrameworkType.PiAgent : AgentFrameworkType.OpenCode,
            workspaceDir: session.workspaceDir,
            isDefaultWorkspace: session.isDefaultWorkspace,
            parentSessionId: session.parentSessionId,
            ...(session.sessionType === 'branch' &&
                !!session.parentSessionId &&
                isLocalDirectTaskPurpose(session.purpose)
                ? { taskResultDelivery: 'runtime-managed' }
                : {}),
            scratchpadPath: session.scratchpadPath,
            createdAt: session.createdAtMs,
            updatedAt: session.updatedAtMs,
            ...(builtinCapabilities ? { builtinCapabilities } : {}),
            ...(memory?.executionTarget ? { memoryExecutionTarget: memory.executionTarget } : {}),
            ...(memory?.recallEnabled !== undefined ? { memoryRecallEnabled: memory.recallEnabled } : {}),
            ...(memory?.writeEnabled !== undefined ? { memoryWriteEnabled: memory.writeEnabled } : {}),
        };
    }
    toMessage(content, turnId, model) {
        return { content, fromRole: Role.User, turnId, ...(model ? { model } : {}) };
    }
}
function diffMemory(prev, current, daily) {
    return {
        ...(current.main && current.main !== prev.main
            ? { agentMemoryUpdate: suffix(prev.main, current.main) }
            : {}),
        ...(daily !== undefined && daily.trim() && daily !== prev.daily
            ? { dailyMemoryUpdate: daily.trim() }
            : {}),
    };
}
/** 先完成全文差分，再消费静态记忆留下的预算；保留完整基线。 */
function limitMemoryUpdates(input, maxChars) {
    const budget = createMemoryContextBudget(maxChars);
    const agentMemoryUpdate = budget.take(input.agentMemoryUpdate ?? '', buildAgentMemoryUpdateBlock, 'tail', MEMORY_TAIL_INJECTION_CAP_CHARS);
    const userMemoryUpdate = budget.take(input.userMemoryUpdate ?? '', buildUserMemoryUpdateBlock, 'tail', MEMORY_TAIL_INJECTION_CAP_CHARS);
    const memorySummaryUpdate = budget.take(input.memorySummaryUpdate ?? '', buildMemorySummaryUpdateBlock, 'head', MEMORY_SUMMARY_INJECTION_CAP_CHARS);
    const dailyMemoryUpdate = budget.take(input.dailyMemoryUpdate ?? '', buildDailyMemoryUpdateBlock, 'tail', DAILY_RECENT_CAP_CHARS);
    const memoryTopics = input.memoryTopics && budget.include(buildMemoryTopicsBlock(input.memoryTopics))
        ? input.memoryTopics
        : undefined;
    return {
        agentMemoryUpdate,
        userMemoryUpdate,
        memorySummaryUpdate,
        dailyMemoryUpdate,
        memoryTopics,
    };
}
function suffix(prev, current) {
    if (prev && current.startsWith(prev))
        return current.slice(prev.length).trim();
    return current.trim();
}
function isPrimaryAgent(agentName) {
    return agentName === 'mavis' || agentName === 'main';
}
function isTrustedPrimaryAgentDetail(detail) {
    return isBuiltinAgentDetail(detail) && isPrimaryAgent(detail.name?.trim() ?? '');
}
function isGitCheckout(workspaceDir) {
    return existsSync(join(workspaceDir, '.git'));
}
function isInsideWorktree(workspaceDir) {
    return existsSync(join(workspaceDir, '.git')) && !existsSync(join(workspaceDir, '.git', 'HEAD'));
}
//# sourceMappingURL=local-data-collector.js.map