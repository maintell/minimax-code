import { globalRequestAccounting, globalTokenUsage, globalUsageRecovery, } from '../../service/goal/index.js';
import { ThreadGoalContractError } from './goal-contract.js';
/** Process-local (TUI / CliService) facade over the single Goal owner. */
export function createProcessLocalGoalApplication(integration, isReadOnlyLegacySession) {
    const requireEnabled = () => {
        if (!integration.isEnabled())
            throw new Error('Thread Goal is disabled.');
    };
    const assertMutable = async (sessionId) => {
        if (await isReadOnlyLegacySession(sessionId)) {
            throw new Error('Legacy opencode sessions are read-only in clean local-runtime mode.');
        }
    };
    return {
        isEnabled: () => integration.isEnabled(),
        get: async (sessionId) => {
            requireEnabled();
            const state = await integration.getGoalForResponse(requireGoalSessionId(sessionId));
            return state ? toProcessLocalGoal(state) : undefined;
        },
        create: async ({ sessionId, objective: rawObjective, tokenBudget, kickoffAttachments }) => {
            requireEnabled();
            const normalizedSessionId = requireGoalSessionId(sessionId);
            await assertMutable(normalizedSessionId);
            const objective = requireGoalObjective(rawObjective);
            const input = {
                sessionId: normalizedSessionId,
                objective,
                ...(tokenBudget !== undefined ? { tokenBudget } : {}),
                ...(kickoffAttachments?.length ? { kickoffAttachments } : {}),
            };
            const created = await integration.createGoal(input, { requireKickoffAdmission: true });
            return toProcessLocalGoal(created);
        },
        patch: async (sessionId, patch) => {
            requireEnabled();
            const normalizedSessionId = requireGoalSessionId(sessionId);
            await assertMutable(normalizedSessionId);
            // Same intent split as the HTTP route: a bare `paused` is the user
            // leaving the Goal and must take the atomic lifecycle transition, not
            // the generic field patch.
            const updated = isBareUserPause(patch)
                ? await integration.pauseGoalByUser(normalizedSessionId)
                : await integration.patchGoal(normalizedSessionId, normalizeProcessLocalGoalPatch(patch));
            if (!updated)
                throw goalNotFound(normalizedSessionId);
            return toProcessLocalGoal(updated);
        },
        resume: async (sessionId) => {
            requireEnabled();
            const normalizedSessionId = requireGoalSessionId(sessionId);
            await assertMutable(normalizedSessionId);
            const result = await integration.patchGoalWithOutcome(normalizedSessionId, {
                status: 'active',
            });
            if (!result)
                throw goalNotFound(normalizedSessionId);
            return toProcessLocalGoalResume(result.goal, result.resume);
        },
        clear: async (sessionId) => {
            requireEnabled();
            const normalizedSessionId = requireGoalSessionId(sessionId);
            await assertMutable(normalizedSessionId);
            if (!(await integration.deleteGoal(normalizedSessionId))) {
                throw goalNotFound(normalizedSessionId);
            }
            return true;
        },
        runningTurnId: (sessionId) => integration.isEnabled()
            ? integration.runningGoalTurnId(requireGoalSessionId(sessionId))
            : undefined,
    };
}
function toProcessLocalGoalResume(goal, resume) {
    const projected = toProcessLocalGoal(goal);
    // A resume that changed nothing about a non-active Goal (for example a
    // `complete` one the store refused) has no outcome of its own.
    if (!resume)
        return { goal: projected, outcome: 'not_resumed' };
    return {
        goal: projected,
        outcome: resume.kind,
        ...(resume.kind === 'started' ? { turnId: resume.turnId } : {}),
    };
}
function goalNotFound(sessionId) {
    return new ThreadGoalContractError(404, `Goal not found for session: ${sessionId}`, 'GOAL_NOT_FOUND');
}
function normalizeGoalObjectivePatch(objective) {
    return objective === undefined ? undefined : requireGoalObjective(objective);
}
/**
 * A bare `status: 'paused'` carries the user's intent to leave the Goal.
 * Anything paired with an objective or budget edit stays a field patch.
 */
function isBareUserPause(patch) {
    return (patch.status === 'paused' && patch.objective === undefined && patch.tokenBudget === undefined);
}
function normalizeProcessLocalGoalPatch(patch) {
    const objective = normalizeGoalObjectivePatch(patch.objective);
    if (patch.status === undefined && objective === undefined && patch.tokenBudget === undefined) {
        throw new Error('Goal patch must include status, objective, or tokenBudget.');
    }
    return {
        ...(patch.status ? { status: patch.status } : {}),
        ...(objective !== undefined ? { objective } : {}),
        ...(patch.tokenBudget !== undefined ? { tokenBudget: patch.tokenBudget } : {}),
    };
}
function toProcessLocalGoal(state) {
    return {
        goalId: state.goalId,
        sessionId: state.sessionId,
        objective: state.objective,
        status: state.status,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        ...(state.dismissedAt !== undefined ? { dismissedAt: state.dismissedAt } : {}),
        tokensUsed: state.tokensUsed,
        turnsUsed: state.turnsUsed,
        timeUsedSeconds: state.timeUsedSeconds,
        tokenBudget: state.tokenBudget,
        statusReason: state.statusReason,
        executionWait: state.executionWait,
        ...(state.lastVerification !== undefined
            ? {
                lastVerification: {
                    backend: state.lastVerification.backend,
                    verdict: state.lastVerification.verdict,
                    reason: state.lastVerification.reason,
                    missing: [...state.lastVerification.missing],
                    notMetStreak: state.lastVerification.notMetStreak,
                    at: state.lastVerification.at,
                },
            }
            : {}),
        hasKickoffAttachments: state.kickoffAttachments.length > 0,
        ...globalRequestAccounting(state.accounting),
        ...globalTokenUsage(state.tokenUsage),
        ...globalUsageRecovery(state),
    };
}
function requireGoalSessionId(value) {
    const sessionId = value.trim();
    if (!sessionId)
        throw new Error('sessionId is required.');
    return sessionId;
}
function requireGoalObjective(value) {
    const objective = value.trim();
    if (!objective)
        throw new Error('goal objective must not be empty');
    return objective;
}
//# sourceMappingURL=process-local-goal-application.js.map