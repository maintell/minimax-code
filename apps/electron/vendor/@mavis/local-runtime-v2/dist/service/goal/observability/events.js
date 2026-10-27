/**
 * Thread-goal mutation event — emitted whenever the store is written
 * (create / patch / delete) so the host can drive the orchestrator
 * pause/resume signal and the SSE projection that updates the UI banner
 * in real time.
 *
 * Lives in its own module (rather than the route handler) so both the
 * IDL-generated DesktopService goal methods (`http/server.ts`) and the
 * host integration / bus wiring can depend on the event shape without a
 * cycle through the (now retired) hand-rolled REST router.
 */
import { logger } from '../../../infra/logging/index.js';
const logThreadGoalRuntimeEvent = (event) => {
    logger.info({ goalEvent: event }, 'Thread Goal runtime decision');
};
/**
 * Emit non-sensitive Goal decision telemetry. These events intentionally stay
 * out of the public Global Events catalog: frontends consume only committed
 * `thread_goal.updated` state, while this stream records internal decisions.
 */
export function emitThreadGoalRuntimeEvent(event, sink) {
    logThreadGoalRuntimeEvent(event);
    if (!sink)
        return;
    try {
        sink(event);
    }
    catch (error) {
        logger.warn({ eventType: event.type, error: error instanceof Error ? error.message : String(error) }, 'Thread Goal runtime observation failed open');
    }
}
//# sourceMappingURL=events.js.map