/**
 * Machine-class steering producer on purpose (kept out of the Turn system's
 * user-producer list). A machine message still pending when the Turn would
 * close holds the close for one more step, so it is answered inside the IM
 * Turn and the reply returns to IM.
 *
 * It is also teardown-durable, like an AskUser answer: if the Turn ends before
 * the model reads the follow-up (Stop, IM /stop, shutdown, lease loss, failure)
 * it falls into the conversation instead of being dropped, with no new Turn
 * and no IM reply. A Turn whose work closed hands it back to the queue with
 * its IM source and channel context, so that follow-up Turn still replies in
 * IM. Either way the IM sender was already told "received", and a replay of
 * the event stays a duplicate.
 *
 * The single definition lives in `@mavis/shared` because the Turn system
 * cannot import the Channel System. `application/channel/im-follow-up-host-ports.ts`
 * builds the durable steer receipt key from this same id to answer "was this
 * IM event merged"; it imports it through the Channel System index, so the
 * steer and the lookup cannot drift apart.
 */
export { CHANNEL_STEER_PRODUCER_ID } from '@mavis/shared';
export function describeFollowError(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=channel-follow-contracts.js.map