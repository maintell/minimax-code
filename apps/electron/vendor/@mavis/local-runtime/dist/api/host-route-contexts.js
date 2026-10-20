/**
 * Route context builders extracted from `host.ts` to keep that file under the
 * 2000-line hook ceiling. These build the per-route plumbing objects passed
 * into local service and route adapters.
 *
 * Each builder takes a tiny structural handle over the host class so this
 * file does not import `LocalRuntimeApiHost` directly (which would create a
 * cycle). The host calls every builder with `this`; the structural typing
 * keeps the contract explicit without ballooning the surface area.
 */
import { resolveLocalPermissionService } from '../permissions/service.js';
// preview_train read this from the v1 agent templates module, which the Agent
// cutover deletes. `resolveLocalRuntimeLocale` is the surviving byte-identical
// implementation.
import { resolveLocalRuntimeLocale } from '../runtime/locale.js';
const questionnaireOwnedActionBindings = new WeakMap();
const questionnaireRequestAdmissionBindings = new WeakMap();
export function createQuestionnaireOwnedActionBinder(host) {
    return (...[ownedActionHandler, onFailure]) => {
        questionnaireOwnedActionBindings.set(host, {
            ownedActionHandler,
            ...(onFailure ? { onFailure } : {}),
        });
    };
}
export function createQuestionnaireRequestAdmissionBinder(host) {
    return (...[requestAdmission]) => {
        questionnaireRequestAdmissionBindings.set(host, requestAdmission);
    };
}
export function buildPermissionRouteContext(host) {
    return {
        agentName: host.agentName,
        configGetter: host.configGetter,
        nowMs: host.nowMs,
        permissionRules: host.permissionRules,
        permissionService: resolveLocalPermissionService(host),
        approvalService: host.permissionApprovalService,
        publishGlobalEvent: (event) => host.publishGlobalEvent(event),
        channelPermissionOutbound: host.channelPermissionBridge,
        metricsClient: host.metricsClient,
    };
}
export function buildQuestionnaireServiceDeps(host) {
    const deps = {
        store: host.questionnaireStore,
        nowMs: host.nowMs,
        primaryAgentName: host.agentName,
        configGetter: host.configGetter,
        getSessionById: (sessionId) => host.getSessionById(sessionId),
        ...(host.runtimeConversation ? { conversation: host.runtimeConversation } : {}),
        emitBusEvent: (type, payload) => host.emitBusEvent(type, payload),
        publishGlobalEvent: (event) => host.publishGlobalEvent(event),
        resolveLocale: () => resolveLocalRuntimeLocale(),
        resolveGoal: async (sessionId) => {
            const goal = await host.threadGoal.store.getBySession(sessionId);
            return goal ? { goalId: goal.goalId, status: goal.status } : undefined;
        },
        autoReplyScheduler: host.questionnaireAutoReplyScheduler,
        hasPendingUserSteering: (sessionId) => host.hasPendingUserSteeringProbe?.(sessionId) ?? false,
        // Drives the queue drain after a questionnaire dismiss so messages the
        // user enqueued while the ask_user card was pending get promoted instead
        // of stalling in SQLite. Dismiss injects no synthetic turn by design
        // ("close is silent"), so nothing else kicks the queue. v1 fanned this out
        // through `host.notifySessionTurnFinished`, which died with the v1 Session
        // routes — kick the surviving owner's ingress directly, the same port
        // `thread-goal/kickoff-host.ts` uses. Left undefined for headless callers
        // with no conversation wired.
        ...(host.runtimeConversation
            ? {
                notifySessionTurnFinished: (sessionId) => {
                    void host.runtimeConversation?.ingress.dispatchQueue(sessionId).catch(() => {
                        // Best-effort drain: a failed kick must never fail the dismiss.
                    });
                },
            }
            : {}),
        ...(host.deliverQuestionnaireAskToChannel
            ? {
                onQuestionnaireAsk: (record) => host.deliverQuestionnaireAskToChannel(record),
            }
            : {}),
    };
    Object.defineProperty(deps, 'requestAdmission', {
        enumerable: true,
        get: () => questionnaireRequestAdmissionBindings.get(host),
    });
    // Long-lived facades (Electron/TUI/CLI/app-server peripheral questionnaires)
    // are assembled before Plan registers its owner. Resolve both the handler and
    // its recovery hook at use time so a live reply reaches the owning workflow
    // instead of waiting for startup reconciliation.
    Object.defineProperties(deps, {
        ownedActionHandler: {
            enumerable: true,
            get: () => questionnaireOwnedActionBindings.get(host)?.ownedActionHandler,
        },
        onOwnedActionFailure: {
            enumerable: true,
            get: () => questionnaireOwnedActionBindings.get(host)?.onFailure,
        },
    });
    return deps;
}
//# sourceMappingURL=host-route-contexts.js.map