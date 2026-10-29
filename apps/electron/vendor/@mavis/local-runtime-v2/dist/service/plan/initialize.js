import { planModeExtension } from '@mavis/agent-extension';
import { QUESTIONNAIRE_TTL_MS } from '@mavis/shared/questionnaire';
import { createPlanAdmissionPolicy, createPlanLifecycleAdmissionFence, hasAnyPendingQuestionnaire, } from './questionnaire/admission.js';
import { createPlanApplication } from './application.js';
import { createPlanLifecycleReconciler } from './lifecycle-reconciler.js';
import { recoverPlanImplementationQueue, recoverPlanLifecycleAndImplementationQueue, } from './implementation-queue-recovery.js';
import { createPlanQuestionnaireActionHandler } from './questionnaire/questionnaire-action-handler.js';
import { createPlanQuestionnaireAdmissionReadModel } from './questionnaire/questionnaire-admission-read-model.js';
import { createPlanPolicyGuard } from './tool-guard.js';
export function initializePlanService(options) {
    const nowMs = options.nowMs ?? Date.now;
    const questionnaireReadModel = createPlanQuestionnaireAdmissionReadModel();
    const lifecycleFence = createPlanLifecycleAdmissionFence({
        db: options.db,
        readModel: questionnaireReadModel,
        nowMs,
    });
    const application = createPlanApplication({
        entryEnabled: options.entryEnabled,
        agentEntryEnabled: options.agentEntryEnabled,
        modes: options.modes,
        lifecycleFence,
        pendingQuestionnaires: {
            hasAny: async (sessionId) => hasAnyPendingQuestionnaire(questionnaireReadModel, options.db, sessionId, nowMs() - QUESTIONNAIRE_TTL_MS),
        },
        documents: options.documents,
        questionnaires: options.questionnaires,
        queue: options.queue,
        receipts: options.receipts,
    });
    let questionnaireService;
    const lifecycleReconciler = createPlanLifecycleReconciler({
        recover: async (dispatch, signal) => {
            const service = (questionnaireService ??= options.questionnaires.createService());
            return recoverPlanLifecycleAndImplementationQueue({
                dispatch,
                ...(signal ? { signal } : {}),
                recoverLifecycle: () => service.reconcileOwnedActions(dispatch),
                recoverImplementationQueue: () => recoverPlanImplementationQueue({
                    queue: options.queue,
                    dispatchQueue: options.dispatchQueue,
                    entryEnabled: options.entryEnabled,
                    ...(signal ? { signal } : {}),
                }),
            });
        },
        dispatchQueue: options.dispatchQueue,
        reportFailure: options.reportFailure,
    });
    const questionnaireActionHandler = createPlanQuestionnaireActionHandler({
        application,
        dispatchQueue: options.dispatchQueue,
        onDispatchFailure: (sessionId) => lifecycleReconciler.scheduleQueueWake(sessionId),
    });
    options.questionnaires.bindOwnedAction(questionnaireActionHandler, (requestId) => lifecycleReconciler.schedule(requestId));
    return {
        toolGuard: createPlanPolicyGuard(),
        lifecycleFence,
        admission: createPlanAdmissionPolicy({
            lifecycleFence,
            modes: options.modes,
            questionnaireReadModel,
            nowMs,
            entryEnabled: options.entryEnabled,
        }),
        application,
        extension: planModeExtension({
            actions: {
                enter: (input) => application.enterFromAgent(input),
                exit: (input) => application.exitFromAgent(input),
            },
            agentEntryEnabled: options.agentEntryEnabled,
            onReviewFallbackFailed: options.reportReviewFallbackFailure ?? options.reportFailure,
        }),
        questionnaireActionHandler,
        lifecycleReconciler,
    };
}
//# sourceMappingURL=initialize.js.map