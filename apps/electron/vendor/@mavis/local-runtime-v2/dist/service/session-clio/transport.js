/**
 * Bridges the durable outbox to the desktop gateway.
 *
 * A missing or unconfigured gateway is `skipped`, never a failure: records stay
 * in the outbox at their original sequences and upload once the desktop owner
 * reports its receiving capabilities ready.
 */
export function createSessionClioTransport(gateway) {
    return {
        ready: () => {
            try {
                const port = gateway();
                return Boolean(port?.reportClioSteps && port.canReportClio?.() !== false);
            }
            catch {
                return false;
            }
        },
        send: async (input) => {
            const port = gateway();
            const report = port?.reportClioSteps;
            if (!report)
                return { status: 'skipped', reason: 'gateway-unavailable' };
            const outcome = await report.call(port, {
                trajectoryId: input.trajectoryId,
                captureOrigin: input.captureOrigin,
                sessionId: input.sessionId,
                steps: input.records.map((record) => ({
                    seq: record.seq,
                    stepType: record.stepType,
                    clientProducedTs: record.clientProducedTs,
                    payloadJson: record.payloadJson,
                })),
            });
            if (outcome.status === 'reported')
                return { status: 'sent' };
            if (outcome.status === 'skipped')
                return { status: 'skipped', reason: outcome.reason };
            return { status: 'failed', retryable: outcome.retryable, reason: outcome.reason };
        },
    };
}
//# sourceMappingURL=transport.js.map