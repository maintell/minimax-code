import { QuestionnaireRequestLifecycle } from './lifecycle/request-lifecycle.js';
import { QuestionnaireOwnedActionLifecycle } from './lifecycle/owned-action-lifecycle.js';
import { QuestionnaireGenericReplyLifecycle } from './lifecycle/generic-reply-lifecycle.js';
import { QuestionnaireV2Lifecycle } from './response-mode/v2-lifecycle.js';
export function initializeQuestionnaireLifecycles(deps, callbacks) {
    const requestLifecycle = new QuestionnaireRequestLifecycle(deps);
    const v2Lifecycle = new QuestionnaireV2Lifecycle(deps);
    const ownedActionLifecycle = new QuestionnaireOwnedActionLifecycle(deps, callbacks.injectReply);
    const genericReplyLifecycle = new QuestionnaireGenericReplyLifecycle(deps, ownedActionLifecycle, callbacks.wakeQueueAfterDuplicateResume);
    return { requestLifecycle, v2Lifecycle, ownedActionLifecycle, genericReplyLifecycle };
}
//# sourceMappingURL=initialize.js.map