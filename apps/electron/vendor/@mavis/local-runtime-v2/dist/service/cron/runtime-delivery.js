import { CronDeliveryDeferredError } from './errors.js';
import { decodeCronModel } from '@mavis/shared/cron-model';
function createRuntimeCronTurnDelivery(turns, reportFailure) {
    return {
        deliver: (request) => deliverRuntimeCron(turns, request, reportFailure),
    };
}
export function createOptionalRuntimeCronTurnDelivery(cronEnabled, override, turns, reportFailure) {
    return cronEnabled
        ? (override ?? createRuntimeCronTurnDelivery(turns, reportFailure))
        : undefined;
}
export async function deliverRuntimeCron(turns, request, reportFailure) {
    let result;
    try {
        result = await turns.steer({
            sessionId: request.sessionId,
            input: {
                text: request.text,
                ...(request.model ? { model: toModelSelection(request.model) } : {}),
            },
            producerId: `cron:${request.cronId}`,
            idempotencyKey: request.runId,
            // Every Cron run needs a durable receipt, including deliveries to an active Turn.
            preDelivery: {
                accept: async () => {
                    await request.beforeDelivery?.();
                },
            },
            provenance: {
                source: 'cron',
                routingFingerprint: `cron:${request.cronId}:${request.runId}`,
                sourceContext: { cronId: request.cronId, runId: request.runId },
            },
        });
    }
    catch (error) {
        if (error instanceof CronDeliveryDeferredError) {
            return { delivered: false, retryable: true, errorCode: error.code };
        }
        throw error;
    }
    if (result.delivered)
        return { delivered: true };
    const errorCode = deliveryErrorCode(result.reason);
    const retryable = TEMPORARY_REJECTIONS.has(result.reason);
    if (!retryable)
        reportFailure?.(request.sessionId, errorCode);
    return {
        delivered: false,
        errorCode,
        ...(retryable ? { retryable: true } : {}),
        error: `Cron steer delivery was rejected: ${result.reason}`,
    };
}
const TEMPORARY_REJECTIONS = new Set([
    'priority-blocked',
    'session-mutating',
    'active-turn',
    'compaction-active',
    'delivery-closed',
    'active-model-override-unsupported',
    'policy:runtime:auth-pending',
    'policy:runtime:draining',
]);
function deliveryErrorCode(reason) {
    // Admission policy reasons are structured identifiers, not persistable error codes.
    // Keep known recovery causes stable; never encode arbitrary policy names as codes.
    if (reason === 'policy:runtime:auth-pending')
        return 'CRON_DELIVERY_AUTH_PENDING';
    if (reason === 'policy:runtime:draining')
        return 'CRON_DELIVERY_RUNTIME_DRAINING';
    if (reason.startsWith('policy:'))
        return 'CRON_DELIVERY_POLICY_REJECTED';
    return `CRON_DELIVERY_${reason.toUpperCase().replaceAll('-', '_')}`;
}
function toModelSelection(model) {
    const { modelKey } = decodeCronModel(model);
    const slash = modelKey.indexOf('/');
    return slash > 0
        ? { providerId: modelKey.slice(0, slash), modelId: modelKey.slice(slash + 1) }
        : { modelId: modelKey };
}
//# sourceMappingURL=runtime-delivery.js.map