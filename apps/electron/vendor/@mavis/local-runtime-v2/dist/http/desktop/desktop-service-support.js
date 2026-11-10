/**
 * Free-function helpers for the DesktopService implementation
 * (`http/server.ts`). Extracted so the service class file stays within the
 * local-runtime per-file line budget; these are stateless and shared across
 * the cron / goal / demo method groups.
 */
/** Build a JSON error Response body the generated router renders verbatim. */
export function jsonError(status, message, code, errorCode) {
    return new Response(JSON.stringify({
        error: message,
        ...(code ? { code } : {}),
        // Numeric business code used by the UI's `resolveSessionErrorCodeText`
        // to map to a localized `errors.codes.<n>` string. Optional because
        // most transport-level errors don't have a stable numeric identity;
        // set it when the caller wants a specific i18n mapping (e.g. cron
        // duplicate → 40903 → 定时任务已存在).
        ...(typeof errorCode === 'number' ? { errorCode } : {}),
    }), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
/** Map an internal session status onto the cron session-history label. */
export function toCronSessionStatusLabel(status) {
    if (status === 'started')
        return 'started';
    if (status === 'error')
        return 'error';
    if (status === 'aborted')
        return 'aborted';
    if (status === 'interrupted')
        return 'interrupted';
    return 'finished';
}
/** Demo StreamEcho frame source (IDL fixture surface). */
export async function* streamEchoFrames(message, repeatToken) {
    yield {
        event: 'message_delta',
        messageDelta: message,
    };
    if (repeatToken) {
        yield {
            event: 'repeat_token',
            messageDelta: repeatToken,
        };
    }
    yield {
        event: 'done',
        done: 'true',
    };
}
//# sourceMappingURL=desktop-service-support.js.map