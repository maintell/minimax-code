import { SessionKind as DesktopSessionKind, SessionInteractionModeView, SessionStatusView, SessionTypeView, } from '@mavis/thrift-gen/generated/desktop-service/types';
import { logger } from '@mavis/shared/local-runtime-logging';
import { CURRENT_SESSION_DATA_VERSION, effectiveSessionMemoryPolicy, isConversationMutationEligibleSession, } from '../../service/session-system/index.js';
import { advisorSelectionToView } from './model-provider-advisor.js';
const SESSION_KIND_TO_DESKTOP = {
    unknown: DesktopSessionKind.Unknown,
    conversation: DesktopSessionKind.Conversation,
    task: DesktopSessionKind.Task,
    peek: DesktopSessionKind.Peek,
    channel: DesktopSessionKind.Channel,
    cron: DesktopSessionKind.Cron,
};
/**
 * The task marks of Session views. A mark is decoration from the Bunny store:
 * a row that cannot be read loses only its own mark, read again one by one,
 * and never fails the list, tree, search or project view it belongs to.
 */
export async function readSessionAssignments(lookup, sessions) {
    const ids = sessions.flatMap((session) => (session ? [session.sessionId] : []));
    if (!lookup || !ids.length)
        return new Map();
    try {
        return await lookup.getMany(ids);
    }
    catch (error) {
        logger.warn({ sessions: ids.length, error: error instanceof Error ? error.message : String(error) }, 'Session task marks could not be read together; reading them one by one');
    }
    const read = new Map();
    if (!lookup.get)
        return read;
    for (const id of ids) {
        try {
            const assignment = await lookup.get(id);
            if (assignment)
                read.set(id, assignment);
        }
        catch (error) {
            logger.warn({ sessionId: id, error: error instanceof Error ? error.message : String(error) }, 'Skipped an unreadable session task mark');
        }
    }
    return read;
}
export function toAssignmentStateView({ session, assignment, ...status }) {
    const view = toSessionInfoView(session, undefined, assignment);
    if (view.assignment)
        view.assignment = { ...view.assignment, worklineId: status.worklineId };
    return { ...status, session: view };
}
export function toSessionInfoView(session, relation, assignment) {
    const model = toSessionModelInfoView(session);
    return {
        sessionId: session.sessionId,
        agentName: session.agentName,
        sessionType: session.sessionType === 'root' ? SessionTypeView.Root : SessionTypeView.Branch,
        ...(typeof session.title === 'string' ? { title: session.title } : {}),
        ...(typeof session.parentSessionId === 'string'
            ? { parentSessionId: session.parentSessionId }
            : {}),
        archived: session.archived,
        status: toSessionStatusInfoView(session),
        createdAt: session.createdAtMs,
        updatedAt: session.updatedAtMs,
        workspaceDir: session.workspaceDir,
        frameworkType: session.runtime,
        isDefaultWorkspace: session.isDefaultWorkspace === true,
        visibility: session.visibility ?? 'visible',
        sessionKind: SESSION_KIND_TO_DESKTOP[session.sessionKind],
        ...conversationCapabilities(session),
        ...(session.purpose ? { purpose: session.purpose } : {}),
        ...optionalSessionModel(model),
        ...(typeof session.effectiveModel === 'string'
            ? { effectiveModel: session.effectiveModel }
            : {}),
        ...(typeof session.effectiveModelVariant === 'string'
            ? { effectiveModelVariant: session.effectiveModelVariant }
            : {}),
        ...(session.runLocation ? { runLocation: toRunLocationView(session.runLocation) } : {}),
        interactionMode: toSessionInteractionModeView(session.interactionMode),
        memoryPolicy: toSessionMemoryPolicyView(session),
        ...(relation
            ? { sideChat: { mainSessionId: relation.mainSessionId, createdAtMs: relation.createdAtMs } }
            : {}),
        sideChatOrigin: session.sideChatOrigin,
        ...optionalSessionAdvisor(session.advisor),
        assignment: toSessionAssignmentView(assignment),
    };
}
function toSessionAssignmentView(assignment) {
    if (!assignment)
        return undefined;
    return {
        completion: assignment.completion,
        assignerSessionId: assignment.assignerSessionId,
        assignerAgentName: assignment.assignerAgentName,
        reportBack: assignment.reportBack,
        assignedAt: assignment.assignedAt,
        via: assignment.via,
        depth: assignment.depth,
    };
}
/**
 * The stored selection as written, the same rule as the main model's `model` above: SessionInfo
 * reports what was saved, and ListModels(session_id) reports what a Turn would run, without the
 * settings the model no longer accepts.
 */
function optionalSessionAdvisor(advisor) {
    return advisor ? { advisor: advisorSelectionToView(advisor) } : {};
}
function toSessionMemoryPolicyView(session) {
    const policy = effectiveSessionMemoryPolicy(session.memoryPolicy);
    return {
        recallEnabled: policy.recallEnabled,
        writeEnabled: policy.writeEnabled,
        recallLocked: policy.recallLocked,
        ...(policy.recallLockedAtMs === undefined ? {} : { recallLockedAtMs: policy.recallLockedAtMs }),
    };
}
function toSessionInteractionModeView(mode) {
    if (mode === 'plan')
        return SessionInteractionModeView.Plan;
    if (mode === 'goal')
        return SessionInteractionModeView.Goal;
    return SessionInteractionModeView.Default;
}
function optionalSessionModel(model) {
    return model ? { model } : {};
}
function toSessionModelInfoView(session) {
    const model = parseEffectiveModel(session.effectiveModel);
    if (!model)
        return undefined;
    return {
        ...model,
        ...(session.effectiveModelContextWindow != null
            ? { contextLimit: session.effectiveModelContextWindow }
            : {}),
        ...(typeof session.effectiveModelVariant === 'string'
            ? { variant: session.effectiveModelVariant }
            : {}),
        ...(typeof session.effectiveModelThinking?.effort === 'string' &&
            session.effectiveModelThinking.effort.trim()
            ? { reasoning: true }
            : {}),
        ...(session.effectiveModelThinking
            ? { thinking: toModelThinkingInput(session.effectiveModelThinking) }
            : {}),
    };
}
function parseEffectiveModel(effectiveModel) {
    if (typeof effectiveModel !== 'string')
        return undefined;
    const separator = effectiveModel.indexOf('/');
    if (separator <= 0 || separator === effectiveModel.length - 1)
        return undefined;
    return {
        providerId: effectiveModel.slice(0, separator),
        modelId: effectiveModel.slice(separator + 1),
    };
}
function toModelThinkingInput(thinking) {
    return {
        ...(typeof thinking.effort === 'string' ? { effort: thinking.effort } : {}),
        ...(typeof thinking.off_behavior === 'string' ? { offBehavior: thinking.off_behavior } : {}),
        ...(thinking.budgets ? { budgets: toModelThinkingBudgetsInput(thinking.budgets) } : {}),
    };
}
function toModelThinkingBudgetsInput(budgets) {
    const minimal = toThinkingBudget(budgets.minimal);
    const low = toThinkingBudget(budgets.low);
    const medium = toThinkingBudget(budgets.medium);
    const high = toThinkingBudget(budgets.high);
    return {
        ...(minimal !== undefined ? { minimal } : {}),
        ...(low !== undefined ? { low } : {}),
        ...(medium !== undefined ? { medium } : {}),
        ...(high !== undefined ? { high } : {}),
    };
}
function toThinkingBudget(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value !== 'string' || value.trim().length === 0)
        return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function conversationCapabilities(session) {
    if (!isConversationMutationEligibleSession(session, CURRENT_SESSION_DATA_VERSION)) {
        return {};
    }
    if (session.interactionMode === 'plan') {
        return { conversationCapabilities: { fork: true, rewind: false } };
    }
    return { conversationCapabilities: { fork: true, rewind: true } };
}
export function toSessionTreeChildView(session) {
    return {
        sessionId: session.sessionId,
        agentName: session.agentName,
        frameworkType: session.runtime,
        ...(typeof session.title === 'string' ? { title: session.title } : {}),
        createdAt: session.createdAtMs,
        updatedAt: session.updatedAtMs,
        archived: session.archived,
        compressed: session.archived,
        status: toSessionStatusInfoView(session),
        sessionKind: SESSION_KIND_TO_DESKTOP[session.sessionKind],
        ...(session.purpose ? { purpose: session.purpose } : {}),
    };
}
function toSessionStatusInfoView(session) {
    return {
        statusType: toSessionStatusType(session.status),
        ...(session.errorMessage ? { message: session.errorMessage } : {}),
        ...(typeof session.errorCode === 'number' ? { errorCode: session.errorCode } : {}),
        ...(session.errorSource ? { errorSource: session.errorSource } : {}),
        ...(session.errorDetail ? { errorDetail: session.errorDetail } : {}),
        ...(session.errorProviderId ? { errorProviderId: session.errorProviderId } : {}),
    };
}
function toSessionStatusType(status) {
    switch (status) {
        case 'started':
            return SessionStatusView.Started;
        case 'error':
            return SessionStatusView.Error;
        case 'aborted':
        case 'interrupted':
            return SessionStatusView.Abort;
        case 'idle':
            return SessionStatusView.Idle;
    }
}
function toRunLocationView(location) {
    return {
        mode: location.mode,
        resolvedDir: location.resolvedDir,
        ...(location.resolvedBranch ? { resolvedBranch: location.resolvedBranch } : {}),
        ...(location.parentRepoDir ? { parentRepoDir: location.parentRepoDir } : {}),
        createdAt: location.createdAt,
    };
}
//# sourceMappingURL=wire.js.map