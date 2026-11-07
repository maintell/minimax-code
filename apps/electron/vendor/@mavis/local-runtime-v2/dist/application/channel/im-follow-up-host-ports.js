/**
 * IM follow-up host ports, late-bound onto the API host once the V2 Turn and
 * Channel owners exist. The Channel System's IM ingress (`enqueueMessage` in
 * `composition/host-input.ts`) reads them per message to choose between
 * queueing an IM follow-up and merging it into the running IM Turn. A host
 * without either owner leaves both unset, so IM follow-ups keep today's queue
 * path.
 */
import { CHANNEL_STEER_PRODUCER_ID, } from '../../service/channel-system/index.js';
import { steeringReceiptId } from '../../service/turn-system/index.js';
export function bindImFollowUpHostPorts(apiHost, owners) {
    const inspection = owners.turnSystem?.inspection;
    const receipts = owners.turnSystem?.receipts;
    // Partial graphs (CLI, test hosts) have no Channel or Turn owner to ask.
    if (!inspection || !receipts || !owners.channelSystem)
        return;
    apiHost.activeTurnChannelProbe = activeTurnChannelProbe(inspection, receipts, owners.channelSystem);
    apiHost.findMergedChannelEvent = mergedChannelEventLookup(receipts);
}
/**
 * The Session's active Turn (the same in-process view the steer path checks),
 * the IM chat that Turn replies to (the same routing as its terminal reply)
 * and, when asked, the Turn already bound to the message's client request id
 * (read-only receipt lookup, so a replayed IM event is not merged twice).
 */
function activeTurnChannelProbe(inspection, receipts, channelSystem) {
    return async (sessionId, clientRequestId) => {
        const turnId = inspection.activeTurnId(sessionId);
        if (!turnId)
            return undefined;
        const [channelContext, bindings] = await Promise.all([
            channelSystem.resolveTurnReplyChannel(sessionId, turnId),
            clientRequestId
                ? receipts.findClientRequestBindings({ sessionId, clientRequestIds: [clientRequestId] })
                : [],
        ]);
        const clientRequestTurnId = bindings[0]?.turnId;
        return {
            turnId,
            ...(channelContext ? { channelContext } : {}),
            ...(clientRequestTurnId ? { clientRequestTurnId } : {}),
        };
    };
}
/**
 * "Was this IM event merged into a Turn": the IM ingress steers with
 * `CHANNEL_STEER_PRODUCER_ID` (the same constant imported above) and the
 * event's client request id as idempotency key, and the Turn system keeps that
 * steer's durable receipt under `steeringReceiptId(...)`. Building the key
 * here leaves its format defined by the Turn system alone; the IM ingress only
 * passes the raw request id.
 */
function mergedChannelEventLookup(receipts) {
    return async (sessionId, clientRequestId) => {
        const receiptId = steeringReceiptId({
            producerId: CHANNEL_STEER_PRODUCER_ID,
            idempotencyKey: clientRequestId,
        });
        const [binding] = await receipts.findClientRequestBindings({
            sessionId,
            clientRequestIds: [receiptId],
        });
        return binding?.turnId;
    };
}
//# sourceMappingURL=im-follow-up-host-ports.js.map