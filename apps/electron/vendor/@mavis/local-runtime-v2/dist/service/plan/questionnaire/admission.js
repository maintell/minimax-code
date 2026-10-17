import { QUESTIONNAIRE_TTL_MS } from '@mavis/shared/questionnaire';
import { PLAN_ADMISSION_POLICY_REJECTIONS, planEntryPreparationPolicyRejection, } from '../contracts.js';
export function composeQueuedItemClassifier(options) {
    if (!options.existing && !options.lifecycleFence && !options.entryEnabled)
        return undefined;
    return async (item) => {
        const existing = (await options.existing?.(item)) ?? 'ready';
        if (existing === 'cancel')
            return 'cancel';
        if (item.message?.clientIntent === 'plan-entry' && options.entryEnabled?.() === false) {
            return 'cancel';
        }
        if (existing === 'defer')
            return 'defer';
        if (await options.lifecycleFence?.blocks({
            sessionId: item.sessionId,
        })) {
            return 'defer';
        }
        return existing;
    };
}
/**
 * Mirrors the v1 questionnaire v21/v22 table in read-only SQL. The table is
 * migrated by v1 before this capability is consumed; v2 must never write it.
 */
export function createPlanLifecycleAdmissionFence(options) {
    const nowMs = options.nowMs ?? Date.now;
    const ttlMs = options.ttlMs ?? QUESTIONNAIRE_TTL_MS;
    const blocksInTransaction = (db, candidate) => options.readModel.hasIncompletePlanLifecycleInTransaction(db, {
        sessionId: candidate.sessionId,
        createdAtCutoff: nowMs() - ttlMs,
        ...(candidate.excludeRequestId ? { excludeRequestId: candidate.excludeRequestId } : {}),
    });
    return {
        blocksInTransaction,
        blocks: async (candidate) => blocksInTransaction(options.db, candidate),
    };
}
export function createPlanAdmissionPolicy(options) {
    const nowMs = options.nowMs ?? Date.now;
    const ttlMs = options.ttlMs ?? QUESTIONNAIRE_TTL_MS;
    return {
        applyInTransaction(db, input) {
            if (options.lifecycleFence.blocksInTransaction(db, lifecycleFenceCandidate(input))) {
                return PLAN_ADMISSION_POLICY_REJECTIONS.lifecycleActive;
            }
            if (input.clientIntent === 'plan-exit') {
                const transition = options.modes.transitionInTransaction(db, input.sessionId, 'plan', 'default');
                return transition === 'updated' || transition === 'already-default'
                    ? undefined
                    : PLAN_ADMISSION_POLICY_REJECTIONS.modeConflict;
            }
            if (input.clientIntent !== 'plan-entry')
                return undefined;
            if (options.entryEnabled?.() === false) {
                return PLAN_ADMISSION_POLICY_REJECTIONS.entryDisabled;
            }
            if (hasAnyPendingQuestionnaire(options.questionnaireReadModel, db, input.sessionId, nowMs() - ttlMs)) {
                return PLAN_ADMISSION_POLICY_REJECTIONS.questionnaireActive;
            }
            const transition = options.modes.transitionInTransaction(db, input.sessionId, 'default', 'plan');
            return transition === 'updated' || transition === 'already-plan'
                ? undefined
                : PLAN_ADMISSION_POLICY_REJECTIONS.modeConflict;
        },
    };
}
/**
 * A questionnaire resume is the continuation that completes its own reply: the
 * row stays answered-but-uninjected until this admission succeeds, so only the
 * exact request being resumed is excluded from the lifecycle fence.
 */
function lifecycleFenceCandidate(input) {
    return {
        sessionId: input.sessionId,
        ...(input.userInputResume?.kind === 'questionnaire'
            ? { excludeRequestId: input.userInputResume.requestId }
            : {}),
    };
}
export function hasAnyPendingQuestionnaire(readModel, db, sessionId, createdAtCutoff = Date.now() - QUESTIONNAIRE_TTL_MS) {
    return readModel.hasAnyPendingInTransaction(db, { sessionId, createdAtCutoff });
}
/**
 * Plan entry submission preparation split out of `services.ts` so the
 * composition root stays inside the local-runtime layout budget.
 */
export function createPlanEntrySubmissionPreparation(plan) {
    return {
        prepare: async (input) => {
            if (input.clientIntent !== 'plan-entry')
                return undefined;
            const planPreparation = await plan.application.preparePlanEntry(input.sessionId);
            if (planPreparation.status === 'rejected') {
                return {
                    status: 'rejected',
                    reason: planEntryPreparationPolicyRejection(planPreparation.reason),
                };
            }
            return {
                status: 'ready',
                commit: () => planPreparation.commit(),
                rollback: () => planPreparation.restore(),
                compensate: () => planPreparation.restore({ revertMode: true }),
            };
        },
    };
}
//# sourceMappingURL=admission.js.map