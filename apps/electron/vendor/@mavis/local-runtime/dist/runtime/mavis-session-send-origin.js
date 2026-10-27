import { sideChatSendOrigin } from '@mavis/shared/sidechat-send-origin';
import { logger } from '../common/logger.js';
/**
 * A SideChat handing a message back to its own main Session is the one send the
 * user expects to see in that Session, so it carries a SideChat origin the
 * desktop chat labels. Every other send carries the peer Session origin from
 * {@link peerSessionSendOrigin} instead. The
 * relation is read at send time and frozen into the message, so promoting or
 * deleting the SideChat later never changes how history renders. The lookup is
 * fail-soft: the label is presentation only and must never fail a delivery.
 */
export async function resolveSessionSendOrigin(deps, req) {
    if (req.callerSessionId === req.sessionId)
        return undefined;
    try {
        const caller = await deps.conversation.query.getSession(req.callerSessionId);
        return caller?.sideChat?.mainSessionId === req.sessionId
            ? sideChatSendOrigin(req.callerSessionId)
            : undefined;
    }
    catch (error) {
        logger.warn({
            callerSessionId: req.callerSessionId,
            sessionId: req.sessionId,
            error: error instanceof Error ? error.message : String(error),
        }, 'Session send could not read the caller SideChat relation; sending without the SideChat origin');
        return undefined;
    }
}
/**
 * The desktop bubble and the model-facing envelope both read this structured
 * origin, never the message text, so the caller identity is frozen here from the
 * caller Session record. The envelope is built later, while assembling model
 * input, so the stored text stays the original message. A missing caller
 * record still names the caller by the runtime-supplied id.
 */
export async function peerSessionSendOrigin(deps, req) {
    const caller = await readCallerSession(deps, req);
    const title = caller?.title?.trim();
    return {
        fromSession: req.callerSessionId,
        command: 'session send',
        ...(caller?.agentName ? { fromAgent: caller.agentName } : {}),
        ...(title ? { fromTitle: title } : {}),
    };
}
async function readCallerSession(deps, req) {
    try {
        return await deps.conversation.query.getSession(req.callerSessionId);
    }
    catch (error) {
        logger.warn({
            callerSessionId: req.callerSessionId,
            sessionId: req.sessionId,
            error: error instanceof Error ? error.message : String(error),
        }, 'Session send could not read the caller Session; sending the source label without it');
        return undefined;
    }
}
//# sourceMappingURL=mavis-session-send-origin.js.map