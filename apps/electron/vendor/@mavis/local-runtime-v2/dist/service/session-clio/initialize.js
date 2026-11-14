// Desktop Session Clio runtime composition.
import { sessionClioDeadlineMs } from '@mavis/shared/session-clio';
import { createSessionClioEligibilityPort, createSessionClioFinalAnswerPort, createSessionClioIdentityPort, DESKTOP_CLIO_CAPTURE_ORIGIN, } from './adapters.js';
import { createSessionClioCapture } from './capture.js';
import { DrizzleSessionClioStore } from './store.js';
import { createSessionClioTransport } from './transport.js';
import { buildLocalTrajectoryId } from './telemetry/payload.js';
const DEFAULT_TICK_INTERVAL_MS = 60_000;
/**
 * Composes Session Clio from the owner's inputs over the runtime's own ports;
 * undefined when the owner supplied none. Trajectories default to the local id.
 */
export function composeOwnerSessionClio(clio, runtime) {
    if (!clio)
        return undefined;
    return composeSessionClio({
        ...runtime,
        authContext: clio.authContext,
        gateway: clio.gateway,
        trajectoryId: clio.trajectoryId ?? buildLocalTrajectoryId,
        enabled: clio.enabled,
        ...(clio.bizId ? { bizId: clio.bizId } : {}),
        ...(clio.tickIntervalMs !== undefined ? { tickIntervalMs: clio.tickIntervalMs } : {}),
    });
}
/**
 * Composes the desktop Session Clio capture.
 *
 * The inactivity boundary is checked before every event, so ticks are a liveness
 * optimisation rather than a correctness requirement: they let a Session that
 * simply stopped being used seal on time instead of waiting for a next Query
 * that may never arrive.
 * @internal Exported only for focused tests.
 */
export function composeSessionClio(options) {
    const nowMs = options.overrides?.nowMs ?? options.nowMs;
    const capture = createSessionClioCapture({
        store: options.overrides?.store ??
            new DrizzleSessionClioStore({ db: options.db, deadlineMs: sessionClioDeadlineMs }),
        transport: options.overrides?.transport ?? createSessionClioTransport(options.gateway),
        identity: options.overrides?.identity ??
            createSessionClioIdentityPort({
                authContext: options.authContext,
                ...(options.bizId ? { bizId: options.bizId } : {}),
            }),
        eligibility: options.overrides?.eligibility ?? createSessionClioEligibilityPort(options.db),
        finalAnswer: options.overrides?.finalAnswer ??
            createSessionClioFinalAnswerPort({ messages: options.messages }),
        trajectoryId: options.trajectoryId,
        captureOrigin: DESKTOP_CLIO_CAPTURE_ORIGIN,
        enabled: options.enabled,
        nowMs,
        ...(options.reportFailure ? { reportFailure: options.reportFailure } : {}),
    });
    let timer;
    const detachedTicks = new WeakSet();
    return {
        capture,
        start: () => {
            detachedTicks.add(tick());
            if (options.overrides?.disableTimer || timer)
                return;
            timer = setInterval(() => {
                detachedTicks.add(tick());
            }, options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);
            timer.unref?.();
        },
        close: () => {
            if (!timer)
                return;
            clearInterval(timer);
            timer = undefined;
        },
    };
    async function tick() {
        try {
            await capture.tick();
        }
        catch (error) {
            reportTickFailure(error);
        }
    }
    function reportTickFailure(error) {
        try {
            const detail = error instanceof Error ? error.message : String(error);
            options.reportFailure?.('tick', `session_clio_capture_failed:${detail}`);
        }
        catch {
            // Diagnostics cannot break the detached capture timer.
        }
    }
}
//# sourceMappingURL=initialize.js.map