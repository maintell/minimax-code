import { getConfig } from '@mavis/config';
import { createProcessLocalGoalApplication } from './process-local-goal-application.js';
import { ThreadGoalContractError, createGoalReqToCreateInput, goalStateToGoalState, patchGoalReqToPatchInput, toThreadGoalContractError, } from './goal-contract.js';
/** Goal HTTP errors keep the DesktopService error body clients already parse. */
class GoalHttpError extends Error {
    status;
    code;
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
        this.name = 'GoalHttpError';
    }
    getResponse() {
        return new Response(JSON.stringify({ error: this.message, ...(this.code ? { code: this.code } : {}) }), { status: this.status, headers: { 'Content-Type': 'application/json' } });
    }
}
/** Both Goal entry surfaces over the single Goal owner. */
export function createRuntimeGoalApplications(goals, isReadOnlyLegacySession) {
    return {
        http: createGoalHttpApplication({
            goals,
            isReadOnlyLegacySession,
            contractPolicy: goalContractPolicyFromConfig,
        }),
        processLocal: createProcessLocalGoalApplication(goals, isReadOnlyLegacySession),
    };
}
function goalContractPolicyFromConfig() {
    const objectiveMaxChars = getConfig().goal.objectiveMaxChars;
    return objectiveMaxChars === undefined ? {} : { objectiveMaxChars };
}
/** @internal HTTP Goal application seam exported only for focused integration tests. */
export function createGoalHttpApplication(deps) {
    const { goals } = deps;
    const requireGoals = () => {
        if (!goals.isEnabled())
            throw new GoalHttpError(403, 'Thread Goal is disabled', 'GOAL_DISABLED');
        return goals;
    };
    const assertSessionMutable = async (sessionId) => {
        if (await deps.isReadOnlyLegacySession(sessionId)) {
            throw new GoalHttpError(409, 'Legacy opencode sessions are read-only in clean local-runtime mode.', 'read_only_legacy_session');
        }
    };
    const goalNotFound = (sessionId) => new GoalHttpError(404, `Goal not found for session: ${sessionId}`, 'GOAL_NOT_FOUND');
    return {
        createGoal: (req) => mapGoalErrors(async () => {
            const owner = requireGoals();
            await assertSessionMutable(req.sessionId);
            const created = await owner.createGoal(createGoalReqToCreateInput(req, deps.contractPolicy()), { requireKickoffAdmission: true });
            return { goal: goalStateToGoalState(created) };
        }),
        getGoal: (req) => {
            const owner = requireGoals();
            return mapGoalErrors(async () => {
                const sessionId = requireSessionId(req.sessionId);
                // The owner projects a persisted row while the local Turn is live.
                const state = await owner.getGoalForResponse(sessionId);
                return state ? { goal: goalStateToGoalState(state) } : {};
            });
        },
        patchGoal: (req) => {
            const owner = requireGoals();
            return mapGoalErrors(async () => {
                const sessionId = requireSessionId(req.sessionId);
                const existing = await owner.store.getBySession(sessionId);
                if (!existing)
                    throw goalNotFound(sessionId);
                await assertSessionMutable(sessionId);
                const { patch, hasChange, isUserPause } = patchGoalReqToPatchInput(req, deps.contractPolicy());
                if (!hasChange) {
                    throw new ThreadGoalContractError(400, 'PATCH body must include status, objective, or token_budget.', 'VALIDATION_ERROR');
                }
                // Route on the caller's intent, not on the patch's field shape: an
                // explicit user pause is an atomic lifecycle transition, not a field
                // update that happens to set `status`.
                const goalForResponse = isUserPause
                    ? await owner.pauseGoalByUser(sessionId)
                    : await owner.patchGoal(sessionId, patch);
                if (!goalForResponse)
                    throw goalNotFound(sessionId);
                return { goal: goalStateToGoalState(goalForResponse) };
            });
        },
        deleteGoal: (req) => {
            const owner = requireGoals();
            return mapGoalErrors(async () => {
                const sessionId = requireSessionId(req.sessionId);
                const existing = await owner.store.getBySession(sessionId);
                if (!existing)
                    return { success: true };
                await assertSessionMutable(sessionId);
                await owner.deleteGoal(sessionId);
                return { success: true };
            });
        },
        dismissGoal: (req) => {
            const owner = requireGoals();
            return mapGoalErrors(async () => {
                const sessionId = requireSessionId(req.sessionId);
                const goalId = req.goalId?.trim();
                if (!goalId) {
                    throw new ThreadGoalContractError(400, 'goal_id is required.', 'VALIDATION_ERROR');
                }
                await assertSessionMutable(sessionId);
                return { goal: goalStateToGoalState(await owner.dismissGoal(sessionId, goalId)) };
            });
        },
    };
}
/**
 * Guard the `session_id` path binder. The generated type makes it a required
 * string, but an empty segment can still arrive; treat that as a 400 so Goal
 * methods never query the store with a blank key.
 */
function requireSessionId(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
        throw new ThreadGoalContractError(400, 'session_id is required', 'VALIDATION_ERROR');
    }
    return sessionId;
}
async function mapGoalErrors(fn) {
    try {
        return await fn();
    }
    catch (err) {
        if (err instanceof GoalHttpError)
            throw err;
        const mapped = toThreadGoalContractError(err);
        throw new GoalHttpError(mapped.status, mapped.message, mapped.code);
    }
}
//# sourceMappingURL=goal-application.js.map