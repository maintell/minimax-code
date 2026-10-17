import { logger } from '../common/logger.js';
/** Live frontend-event source used by the v1 compatibility host. */
export function createGlobalEventSource() {
    const subscribers = new Set();
    let closed = false;
    return {
        publish(event) {
            if (closed)
                return;
            for (const subscriber of subscribers) {
                try {
                    subscriber.next(event);
                }
                catch (err) {
                    logger.warn({ err, type: event.type }, 'Global event subscriber failed');
                }
            }
        },
        subscribe(subscriber) {
            if (closed) {
                subscriber.complete?.();
                return () => undefined;
            }
            subscribers.add(subscriber);
            return () => subscribers.delete(subscriber);
        },
        close() {
            if (closed)
                return;
            closed = true;
            const active = [...subscribers];
            subscribers.clear();
            for (const subscriber of active) {
                try {
                    subscriber.complete?.();
                }
                catch (err) {
                    logger.warn({ err }, 'Global event subscriber cleanup failed');
                }
            }
        },
    };
}
//# sourceMappingURL=global-events.js.map