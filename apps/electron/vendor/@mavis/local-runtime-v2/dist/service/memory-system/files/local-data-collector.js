import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getRuntimeRegion } from '@mavis/config';
import { DAILY_RECENT_CAP_CHARS, MEMORY_SUMMARY_INJECTION_CAP_CHARS, MEMORY_TAIL_INJECTION_CAP_CHARS, MEMORY_CONTEXT_CAP_CHARS, createMemoryContextBudget, } from '@mavis/shared';
import { AgentFrameworkType, AgentRole, Role, SessionType, buildAgentMemoryUpdateBlock, buildDailyMemoryUpdateBlock, buildMemorySummaryUpdateBlock, buildMemoryTopicsBlock, buildUserMemoryUpdateBlock, } from '@mavis/system-reminder';
import { isLocalDirectTaskPurpose, detectProjectInstructions } from '../../session-system/index.js';
import { loadCliSunsetCandidates, } from '../policies/cli-sunset-notice.js';
import { resolveLocalRuntimeLocale } from '../../../infra/config/locale.js';
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
        const detail = reader && factsAgentName ? await readAgentFactsDetail(reader, factsAgentName) : undefined;
        const agentMemoryEnabled = isAgentMemoryEnabled(memoryGloballyEnabled, agentName, detail);
        const memory = await this.collectMemoryState(session, msg, agentName, {
            ...this.resolveMemoryAccess(session, agentName, agentMemoryEnabled),
            userMemoryEnabled,
        });
        const baseline = this.rotateBaseline(session, agentName, memory);
        const identity = detail ? agentDetailToIdentity(detail) : null;
        const persona = await this.readPersona(session, detail, factsAgentName, identity);
        const memoryUpdates = buildMemoryUpdates(memory, baseline, turnCount, session.memoryContextCharsUsed);
        const dataDir = this.input.dataDir();
        const workspaceDir = session.workspaceDir ?? process.cwd();
        const agentRole = resolveReminderAgentRole(session, detail);
        const { canonicalSnapshot } = memory;
        return {
            env: this.buildReminderEnv(session, identity, {
                agentName,
                agentRole,
                dataDir,
                workspaceDir,
            }),
            turnCount,
            teamModeOff: true,
            ...this.reminderFeatureFlags(session, memory.memoryWriteEnabled),
            ...agentProfileFields(identity, persona),
            workspaceDir,
            isGitWorkspace: isGitCheckout(workspaceDir),
            isInsideWorktree: isInsideWorktree(workspaceDir),
            creationSource: toCreationSource(detail?.creationSource),
            ...memoryUpdates,
            ...memorySkillReminderFields(memory),
            ...(memory.memoryRecallEnabled && canonicalSnapshot && turnCount <= 1
                ? await this.collectCliSunsetNotice(canonicalSnapshot)
                : {}),
        };
    }
    resolveMemoryAccess(session, agentName, agentMemoryEnabled) {
        const memoryRecallEnabled = agentMemoryEnabled &&
            session.memoryRecallEnabled !== false &&
            this.input.memoryRecallEnabled?.(session.memoryExecutionTarget?.trim() || agentName || '') !==
                false;
        const memoryWriteEnabled = agentMemoryEnabled &&
            session.memoryWriteEnabled !== false &&
            this.input.memoryAutoWriteEnabled?.() !== false;
        return { memoryRecallEnabled, memoryWriteEnabled };
    }
    async collectMemoryState(session, msg, agentName, access) {
        const memoryAccessible = access.memoryRecallEnabled || access.memoryWriteEnabled;
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
        const userMemory = access.userMemoryEnabled
            ? await this.readUserMemory(session, msg)
            : undefined;
        const currentDaily = canonicalSnapshot
            ? await this.readCanonicalDaily(session, msg)
            : undefined;
        return { ...access, canonicalSnapshot, userMemory, currentDaily };
    }
    /** Returns the previous same-target baseline, then records this Turn's reads as the next one. */
    rotateBaseline(session, agentName, memory) {
        const canonicalAgentName = session.memoryExecutionTarget?.trim() || agentName || session.agentName;
        const previous = this.baselines.get(session.sessionId);
        const baseline = previous?.canonicalAgentName === canonicalAgentName ? previous : undefined;
        const next = nextMemoryBaseline(canonicalAgentName, memory);
        if (next)
            this.baselines.set(session.sessionId, next);
        return baseline;
    }
    async readPersona(session, detail, agentName, identity) {
        const personaEnabled = session.builtinCapabilities?.persona.enabled !== false;
        if (!personaEnabled || !detail || !agentName)
            return undefined;
        return isPersonaMissing({
            agentConfigDir: detail.agentConfigDir ?? join(this.input.dataDir(), 'agents', agentName),
            identityDisplayName: identity?.display_name,
            builtin: isBuiltinAgentDetail(detail),
            builtinPersona: detail.persona,
        });
    }
    buildReminderEnv(session, identity, facts) {
        const { agentName, agentRole, dataDir, workspaceDir } = facts;
        const sessionType = session.sessionType === SessionType.Root ? 1 : 0;
        const userConfiguredName = this.input.userConfiguredName?.()?.trim();
        return {
            environmentInSystemPrompt: session.environmentInSystemPrompt,
            workspaceDir,
            isDefaultWorkspace: session.isDefaultWorkspace ?? true,
            agentConfigDir: `${dataDir}/agents/${agentName}`,
            agentName,
            agentRole,
            sessionId: session.sessionId,
            ...(session.sessionIdInContext ? { sessionIdInContext: true } : {}),
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
        };
    }
    reminderFeatureFlags(session, memoryWriteEnabled) {
        return {
            ...(memoryWriteEnabled && this.input.proactiveMemoryEnabled?.() === true
                ? { proactiveMemoryEnabled: true }
                : {}),
            mavisEnabled: session.builtinCapabilities?.features.mavis !== false,
            ...(this.input.cronEnabled ? { cronEnabled: this.input.cronEnabled() } : {}),
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
            ...sessionMemoryFields(memory),
        };
    }
    toMessage(content, turnId, model) {
        return { content, fromRole: Role.User, turnId, ...(model ? { model } : {}) };
    }
}
/** A missing Agent degrades to "no facts"; any other read failure still fails the reminder. */
async function readAgentFactsDetail(reader, agentName) {
    // Start the read outside `try`: only a rejected read is classified, so a
    // synchronous throw from `getAgent` still escapes unchanged.
    const response = reader.getAgent({ name: agentName, include: 'identity,persona' });
    try {
        return (await response).agent;
    }
    catch (error) {
        const candidate = Object(error);
        if (candidate.status === 404 || candidate.code === 'AGENT_NOT_FOUND') {
            return undefined;
        }
        throw error;
    }
}
function isAgentMemoryEnabled(memoryGloballyEnabled, agentName, detail) {
    return (memoryGloballyEnabled &&
        isPrimaryAgent(agentName ?? '') &&
        detail !== undefined &&
        isTrustedPrimaryAgentDetail(detail));
}
function nextMemoryBaseline(canonicalAgentName, memory) {
    const { memoryRecallEnabled, canonicalSnapshot, userMemory, currentDaily } = memory;
    if (!((memoryRecallEnabled && canonicalSnapshot) || userMemory !== undefined))
        return undefined;
    return {
        canonicalAgentName,
        ...(memoryRecallEnabled && canonicalSnapshot
            ? {
                main: canonicalSnapshot.main,
                summary: canonicalSnapshot.summary,
            }
            : {}),
        ...(userMemory !== undefined ? { user: userMemory } : {}),
        ...(memoryRecallEnabled && canonicalSnapshot ? { daily: currentDaily } : {}),
    };
}
function diffAgainstBaseline(memory, baseline) {
    const { canonicalSnapshot, userMemory, currentDaily } = memory;
    const deltas = baseline && canonicalSnapshot ? diffMemory(baseline, canonicalSnapshot, currentDaily) : {};
    const userDelta = baseline && userMemory !== undefined && userMemory !== baseline.user
        ? userMemory.trim()
        : undefined;
    return { deltas, userDelta };
}
function buildMemoryUpdates(memory, baseline, turnCount, memoryContextCharsUsed) {
    const { memoryRecallEnabled, userMemoryEnabled, canonicalSnapshot } = memory;
    const { deltas, userDelta } = diffAgainstBaseline(memory, baseline);
    return limitMemoryUpdates({
        ...(memoryRecallEnabled ? deltas : {}),
        ...(memoryRecallEnabled && canonicalSnapshot?.summary.trim()
            ? { memorySummaryUpdate: canonicalSnapshot.summary.trim() }
            : {}),
        ...(userMemoryEnabled && userDelta ? { userMemoryUpdate: userDelta } : {}),
        ...(memoryRecallEnabled && turnCount <= 1 && canonicalSnapshot?.topics.length
            ? { memoryTopics: canonicalSnapshot.topics }
            : {}),
    }, MEMORY_CONTEXT_CAP_CHARS - (memoryContextCharsUsed ?? 0));
}
function resolveReminderAgentRole(session, detail) {
    if (detail)
        return detail.agentRole === 'orchestrator' ? 'orchestrator' : 'worker';
    return session.agentRole === AgentRole.Orchestrator ? 'orchestrator' : 'worker';
}
function agentProfileFields(identity, persona) {
    return {
        ...(identity ? { identity } : {}),
        ...(persona ? { personaMissing: persona.missing, personaPath: persona.personaPath } : {}),
    };
}
function memorySkillReminderFields(memory) {
    const { memoryWriteEnabled, canonicalSnapshot } = memory;
    return memoryWriteEnabled && canonicalSnapshot?.main.trim()
        ? {
            memorySkillReminder: {
                path: canonicalSnapshot.mainPath,
                lines: canonicalSnapshot.mainLines,
                sizeBytes: canonicalSnapshot.mainSizeBytes,
            },
        }
        : {};
}
function sessionMemoryFields(memory) {
    return {
        ...(memory?.executionTarget ? { memoryExecutionTarget: memory.executionTarget } : {}),
        ...(memory?.recallEnabled !== undefined ? { memoryRecallEnabled: memory.recallEnabled } : {}),
        ...(memory?.writeEnabled !== undefined ? { memoryWriteEnabled: memory.writeEnabled } : {}),
    };
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