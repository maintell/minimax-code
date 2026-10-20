import { createSecretFreeTurnAssemblyContext } from '../assembly-context.js';
import { createCanonicalAgentHostUserInput } from '../canonical-user-input.js';
import { detectReferencedOfficialHostCapabilityPlugins } from '../assembly/local-turn-plugin-capabilities.js';
import { captureAgentHostSession } from './session-read.js';
import { copyCanonicalHistoryForPiCompatibility } from '../history/canonical-history-validation.js';
import { readSessionAgentExecutionSnapshot } from './session-agent-execution-snapshot.js';
import { continuationRunnerHistory } from '../history/continuation-history.js';
export class AgentExecutionSnapshotNotFoundError extends Error {
    agentName;
    name = 'AgentExecutionSnapshotNotFoundError';
    constructor(agentName) {
        super(`Agent execution snapshot not found: ${agentName}`);
        this.agentName = agentName;
    }
}
export class AgentEventAssociationError extends Error {
    field;
    expected;
    actual;
    name = 'AgentEventAssociationError';
    constructor(field, expected, actual) {
        super(`Agent event ${field} mismatch: expected "${expected}", received "${actual}".`);
        this.field = field;
        this.expected = expected;
        this.actual = actual;
    }
}
/**
 * Captures one immutable, secret-free execution scope before AgentRuntime
 * assembly. The Host remains the owner of assembly and the lifecycle sequence.
 */
export class TurnPreflight {
    dependencies;
    constructor(dependencies) {
        this.dependencies = dependencies;
    }
    async prepare(input, desktopCapabilities) {
        const logContext = {
            sessionId: input.lease.sessionId,
            turnId: input.lease.turnId,
            executionMode: input.request.executionMode ?? 'activate',
        };
        const session = captureAgentHostSession(input.lease.sessionId, await observeAgentTurnSetupStage(this.dependencies.logger, logContext, 'session_read', () => this.dependencies.sessions.get(input.lease.sessionId)));
        const plan = session.interactionMode === 'plan'
            ? {
                active: true,
                canonicalPath: (await observeAgentTurnSetupStage(this.dependencies.logger, logContext, 'plan_document_resolution', () => requirePlanDocuments(this.dependencies).resolveAndEnsure(session.sessionId))).canonicalPath,
            }
            : undefined;
        // Storage owner and execution owner are captured exactly once. A concurrent
        // Agent roster refresh must not move an in-flight Turn back onto the legacy
        // owner, so nothing below re-resolves either name.
        const storageOwnerName = session.agentName;
        const snapshot = await observeAgentTurnSetupStage(this.dependencies.logger, logContext, 'agent_snapshot', () => readSessionAgentExecutionSnapshot(this.dependencies.agents, session));
        if (!snapshot)
            throw new AgentExecutionSnapshotNotFoundError(storageOwnerName);
        // Association keeps validating the storage owner so the ledger owner stays
        // unambiguous; the execution owner is a separate, behaviour-only field.
        validateAgentAssociation(storageOwnerName, snapshot);
        const turnRuntimeFacts = this.dependencies.turnRuntimeFacts?.snapshot();
        const referencedComputerUsePlugins = detectReferencedOfficialHostCapabilityPlugins({
            capabilities: desktopCapabilities,
            capability: 'computer-use',
            userInput: input.request.input,
        });
        const selected = await resolveTaskComputerUseSelection({
            capabilities: desktopCapabilities,
            request: input,
            referenced: referencedComputerUsePlugins.length > 0,
            runtimeFacts: this.dependencies.turnRuntimeFacts,
            session,
        });
        const agent = freezeTurnExecutionSnapshot(freezeExecutionOwner(snapshot), {
            runtimeFacts: turnRuntimeFacts,
            selected: selected.active,
        });
        const history = await observeAgentTurnSetupStage(this.dependencies.logger, logContext, 'history_read', () => this.dependencies.history.read(input.lease.sessionId));
        const runnerHistory = input.request.executionMode === 'continuation' ? continuationRunnerHistory(history) : history;
        const canonicalUserInput = createCanonicalAgentHostUserInput(input.request);
        const internalPromptRead = this.dependencies.internalTurnPromptReads?.take(input.lease.turnId);
        const prepared = await observeAgentTurnSetupStage(this.dependencies.logger, logContext, 'agent_preparation', () => this.dependencies.preparation.prepare({
            turnId: input.lease.turnId,
            request: input.request,
            session,
            agent,
            history: runnerHistory,
            ...(desktopCapabilities ? { desktopCapabilities } : {}),
            ...(internalPromptRead ? { promptRead: internalPromptRead } : {}),
        }));
        const preparation = selected.unavailable
            ? {
                ...prepared,
                agentConfig: { ...prepared.agentConfig, computerUseDefaultUnavailable: true },
            }
            : prepared;
        const effectiveUserInput = replaceRetryContinuationPrompt(canonicalUserInput, preparation);
        const assemblyContext = createSecretFreeTurnAssemblyContext({
            input,
            session,
            agent,
            preparation,
            history: copyCanonicalHistoryForPiCompatibility(runnerHistory.messages),
            canonicalUserInput: effectiveUserInput,
            ...(plan ? { plan } : {}),
            ...(preparation.promptRead ? { promptRead: preparation.promptRead } : {}),
        });
        return {
            session,
            agent,
            preparation,
            history,
            runnerHistory,
            assemblyContext,
            canonicalUserInput: effectiveUserInput,
        };
    }
}
function replaceRetryContinuationPrompt(input, preparation) {
    const prompt = preparation.retryContinuationPrompt;
    if (!prompt || input.messages.length !== 1)
        return input;
    const first = input.messages[0];
    if (!first)
        return input;
    return Object.freeze({
        text: prompt,
        messages: Object.freeze([Object.freeze({ ...first, text: prompt })]),
    });
}
/** Best-effort timing around one pre-LLM setup stage. */
export async function observeAgentTurnSetupStage(logger, context, stage, operation) {
    const startedAtMs = Date.now();
    logSetupEvent(logger, 'info', setupFields(context, stage, 'started'), '[local-runtime-v2] agent turn setup stage started');
    try {
        const result = await operation();
        logSetupEvent(logger, 'info', {
            ...setupFields(context, stage, 'completed'),
            duration_ms: Math.max(0, Date.now() - startedAtMs),
        }, '[local-runtime-v2] agent turn setup stage completed');
        return result;
    }
    catch (error) {
        logSetupEvent(logger, 'error', {
            ...setupFields(context, stage, 'failed'),
            duration_ms: Math.max(0, Date.now() - startedAtMs),
            error_type: error instanceof Error ? error.name : typeof error,
        }, '[local-runtime-v2] agent turn setup stage failed');
        throw error;
    }
}
function setupFields(context, stage, status) {
    return {
        event: `agent_turn_setup_stage_${status}`,
        session_id: context.sessionId,
        turn_id: context.turnId,
        execution_mode: context.executionMode ?? 'activate',
        setup_stage: stage,
    };
}
function logSetupEvent(logger, level, fields, message) {
    try {
        if (level === 'info')
            logger?.info?.(fields, message);
        else
            logger?.error?.(fields, message);
    }
    catch {
        // Diagnostics must never change Turn preparation behavior.
    }
}
function requirePlanDocuments(dependencies) {
    if (!dependencies.planDocuments) {
        throw new Error('Plan document resolver is unavailable for an accepted Plan Turn');
    }
    return dependencies.planDocuments;
}
function validateAgentAssociation(expectedAgentName, agent) {
    if (agent.agentName !== expectedAgentName) {
        throw new AgentEventAssociationError('agentName', expectedAgentName, agent.agentName);
    }
}
async function resolveTaskComputerUseSelection(input) {
    const trustedEnabled = input.capabilities?.plugins.some((plugin) => plugin.name === 'computer-use' &&
        plugin.source === 'official' &&
        plugin.hostCapabilities?.includes('computer-use') === true) === true;
    if (!trustedEnabled)
        return { active: false };
    const requestSelection = input.request.request.input.computerUse?.enable;
    const explicitSelection = requestSelection === true && input.referenced;
    if (!input.runtimeFacts?.resolveComputerUseSelection)
        return { active: explicitSelection };
    const selection = requestSelection === false || explicitSelection ? { selection: explicitSelection } : {};
    const selected = await input.runtimeFacts.resolveComputerUseSelection({
        sessionId: input.request.lease.sessionId,
        ...selection,
    });
    if (selected || requestSelection === false)
        return { active: selected };
    if (!isComputerUseDefaultEligible(input.session, input.request.request) ||
        !input.runtimeFacts.snapshot().computerUseGloballyEnabled) {
        return { active: false };
    }
    const defaultSelection = await input.runtimeFacts.resolveComputerUseDefault?.();
    return {
        active: defaultSelection === 'enabled',
        unavailable: defaultSelection === 'unavailable',
    };
}
// Positive admission only: background producers can target ordinary sessions too.
function isComputerUseDefaultEligible(session, request) {
    return (session.sessionKind === 'conversation' &&
        !session.originCronId &&
        session.visibility !== 'hidden' &&
        !session.archived &&
        (request.executionMode === 'continuation'
            ? request.provenance.source === 'turn-continuation'
            : request.provenance.source === 'api') &&
        !request.input.channelContext &&
        !request.input.origin &&
        !request.input.queuedMessages?.some((message) => message.channelContext || message.origin));
}
/** Materializes the behaviour owner so every later stage reads one frozen value. */
function freezeExecutionOwner(agent) {
    return agent.executionOwnerName ? agent : { ...agent, executionOwnerName: agent.agentName };
}
function freezeTurnExecutionSnapshot(agent, input) {
    const computerUseActive = input.runtimeFacts?.computerUseGloballyEnabled === true && input.selected;
    return { ...agent, computerUseActive };
}
//# sourceMappingURL=turn-preflight.js.map