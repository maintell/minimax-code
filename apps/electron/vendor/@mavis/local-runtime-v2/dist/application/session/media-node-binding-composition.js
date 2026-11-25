import { settleInBackground } from '../../service/plugin-system/index.js';
import { SessionMediaNodeBinder, } from '../../service/session-system/index.js';
/**
 * Links a Session's delivered generated media to their Drive nodes whenever one of its
 * Turns ends, however it ended. Without cloud media identity nothing is subscribed.
 * Like the merge request Turn-end hook, the subscription lives as long as the event bus.
 */
export function bindSessionMediaNodeBinding(input) {
    const identity = input.applications.mediaIdentity;
    if (!identity)
        return;
    const binder = new SessionMediaNodeBinder({
        files: input.applications.files,
        sessions: input.sessions,
        identity,
        ...(input.logger ? { logger: input.logger } : {}),
    });
    input.events.subscribe({
        next: (event) => {
            if (event.type === 'session.finish' ||
                event.type === 'session.error' ||
                event.type === 'session.abort') {
                settleInBackground(binder.onTurnEnded(event.payload.sessionId));
            }
        },
    });
}
//# sourceMappingURL=media-node-binding-composition.js.map