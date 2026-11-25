import { randomUUID } from "node:crypto";
import { getUserInfo } from "../../ipc/storage.ipc";
import { enqueueElectronObservabilityEvent } from "../observability/outbox";
/** Bind both events to the signed-in account that initiated this capture. */
export function startCaptureMeasurement(entry, windowKind) {
    try {
        const owner = getUserInfo().realUserID;
        if (!owner)
            return;
        const context = {
            capture_id: randomUUID(),
            owner_user_id: owner,
            entry: entry === 'shortcut' ? 'shortcut' : 'button',
            capture_window: windowKind,
        };
        enqueueElectronObservabilityEvent('screen_capture_start', context);
        let finished = false;
        return (result, mode) => {
            if (finished)
                return;
            finished = true;
            enqueueElectronObservabilityEvent('screen_capture_result', { ...context, mode, result });
        };
    }
    catch {
        // Analytics is optional, including when the account store is unavailable.
        return;
    }
}
