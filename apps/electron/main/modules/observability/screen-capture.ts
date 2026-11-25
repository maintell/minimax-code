import { isOutboxOwnerUserId } from "./owner";
/** Only bounded capture metadata may be persisted or replayed. */
export function sanitizeScreenCapturePayload(eventName, payload) {
    const { capture_id, owner_user_id, entry, capture_window, mode, result } = payload;
    if (typeof capture_id !== 'string' ||
        !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(capture_id) ||
        !isOutboxOwnerUserId(owner_user_id) ||
        typeof entry !== 'string' ||
        !['button', 'shortcut'].includes(entry) ||
        typeof capture_window !== 'string' ||
        !['main', 'mini_chat'].includes(capture_window))
        return {};
    const context = { capture_id, owner_user_id, entry, capture_window };
    if (eventName === 'screen_capture_start')
        return context;
    if (typeof mode !== 'string' ||
        !['unknown', 'image', 'scroll', 'record'].includes(mode) ||
        typeof result !== 'string' ||
        !['success', 'cancelled', 'denied', 'restricted', 'interrupted', 'error'].includes(result))
        return {};
    return { ...context, mode, result };
}
