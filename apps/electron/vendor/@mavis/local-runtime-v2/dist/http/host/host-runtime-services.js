/**
 * Owner-scoped Runtime services assembled by `host.ts`, extracted so that file
 * stays inside the layout line budget.
 *
 * Every handle below is read off the host's public surface only, so
 * `LocalRuntimeApiHost` keeps its private fields private and passes `this`.
 * The one exception is `resolveHostImmediateTaskAdmission`, which is a pure
 * function over the two values it needs.
 */
import { LocalPermissionApprovalService, readLocalPermissionMode, } from '../../service/permission/index.js';
import { isCliRestrictedRuntime } from '../../service/session-handoff/index.js';
import { initializeWebFetchRouter } from '../../service/web-fetch/index.js';
import { deliverQuestionnaireAskToChannel } from './interaction/host-questionnaire-delivery.js';
/**
 * One router per Runtime: its backoff, breaker, learned intranet hosts and
 * daily counts must outlive a Turn.
 */
export function buildHostWebFetchRouter(host) {
    const metricsClient = host.metricsClient;
    return initializeWebFetchRouter({
        dataDir: () => host.configGetter().dataDir,
        ...(metricsClient
            ? {
                histogram: (name, value, labels) => metricsClient.histogram(name, value, labels),
            }
            : {}),
        ...(host.fetchImpl ? { fetchImpl: host.fetchImpl } : {}),
        ...(host.authContextGetter ? { authContextGetter: host.authContextGetter } : {}),
        ...(host.authContextInvalidator ? { authContextInvalidator: host.authContextInvalidator } : {}),
        ...(host.routingContextGetter ? { routingContextGetter: host.routingContextGetter } : {}),
        ...(host.metrics ? { metrics: host.metrics } : {}),
        ...(host.matrixLogger ? { matrixLogger: host.matrixLogger } : {}),
    });
}
/** Owns the local permission ask lifecycle for this Runtime. */
export function createHostPermissionApprovalService(host) {
    return new LocalPermissionApprovalService({
        agentName: host.agentName,
        nowMs: host.nowMs,
        permissionRules: host.permissionRules,
        publishGlobalEvent: (event) => host.publishGlobalEvent(event),
        channelPermissionOutbound: {
            onPermissionAsk: (event) => host.requireChannelPort('permission ask fan-out').permissionOutbound.onPermissionAsk(event),
        },
        metricsClient: host.metricsClient,
        permissionModeGetter: () => readLocalPermissionMode(host.configGetter().permissionMode),
    });
}
/** Immediate task admission follows the owner kind and the host capability profile. */
export function resolveHostImmediateTaskAdmission(lockOwner, capabilities) {
    const { ownerKind } = lockOwner;
    return ((ownerKind === 'electron' && capabilities.electronHost === true) ||
        isCliRestrictedRuntime(ownerKind, capabilities.cliEmbedded) ||
        (ownerKind === 'app-server' && capabilities.cliEmbedded === true));
}
/** Delivers a questionnaire ask to the IM channel it originated from. */
export function deliverHostQuestionnaireAskToChannel(host, record) {
    return deliverQuestionnaireAskToChannel({
        sendQuestionnaireMessage: (input) => host.requireChannelPort('questionnaire ask delivery').sendQuestionnaireMessage(input),
        emitBusEvent: (type, payload) => host.emitBusEvent(type, payload),
        ...(host.metrics ? { metrics: host.metrics } : {}),
    }, record);
}
//# sourceMappingURL=host-runtime-services.js.map