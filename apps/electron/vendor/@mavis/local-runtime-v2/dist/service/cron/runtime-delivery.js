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
    const result = await turns.steer({
        sessionId: request.sessionId,
        input: { text: request.text },
        producerId: `cron:${request.cronId}`,
        idempotencyKey: request.runId,
        ...(request.beforeDelivery ? { preDelivery: { accept: request.beforeDelivery } } : {}),
        provenance: {
            source: 'cron',
            routingFingerprint: `cron:${request.cronId}:${request.runId}`,
            sourceContext: { cronId: request.cronId, runId: request.runId },
        },
    });
    if (result.delivered)
        return { delivered: true };
    const errorCode = `CRON_DELIVERY_${result.reason.toUpperCase().replaceAll('-', '_')}`;
    reportFailure?.(request.sessionId, errorCode);
    return {
        delivered: false,
        errorCode,
        error: `Cron steer delivery was rejected: ${result.reason}`,
    };
}
//# sourceMappingURL=runtime-delivery.js.map