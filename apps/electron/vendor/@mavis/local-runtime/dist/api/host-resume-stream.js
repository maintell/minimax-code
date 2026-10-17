import { sessionTurnFramesToRawSse } from './session-turn-sse.js';
export async function openLocalResumeStream(host, sessionId, resumeRequest) {
    const result = await resumeLocalSessionTurn(host, sessionId, resumeRequest);
    if (result.ok)
        return sessionTurnFramesToRawSse(result.frames);
    return new Response(JSON.stringify({
        error: result.error.message,
        ...(result.error.key ? { code: result.error.key } : {}),
    }), { status: result.error.status, headers: { 'Content-Type': 'application/json' } });
}
export async function resumeLocalSessionTurn(host, sessionId, resumeRequest) {
    const resumed = await host.sessionTurns.resume({
        sessionId,
        ...(resumeRequest.afterCursor ? { afterCursor: resumeRequest.afterCursor } : {}),
        ...(resumeRequest.msgId ? { afterMessageId: resumeRequest.msgId } : {}),
        ...(resumeRequest.turnId ? { subscriberKey: resumeRequest.turnId } : {}),
        ...(resumeRequest.drainQueued ? { waitForActiveTurn: true } : {}),
    });
    if (!resumed.ok) {
        return {
            ok: false,
            error: {
                status: 409,
                key: 'local_session_busy',
                message: 'Local Pi session already has an active turn in another runtime process; resume or abort it before sending another message.',
            },
        };
    }
    return { ok: true, frames: resumed.frames };
}
//# sourceMappingURL=host-resume-stream.js.map