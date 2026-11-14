import { createCoordinatorRoster, } from '../../service/session-system/index.js';
/** Waits before each retry of a catalog that could not be listed: bounded, about 13 minutes in all. */
const COORDINATOR_ROSTER_RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000];
const scheduleUnref = (retry, delayMs) => {
    const timer = setTimeout(retry, delayMs);
    timer.unref?.();
    return () => clearTimeout(timer);
};
const errorMessage = (error) => (error instanceof Error ? error.message : String(error));
/**
 * Coordinators come from the bundled built-in catalog only, read once. A
 * catalog that cannot be listed leaves the roster empty and unavailable: no
 * Session is coordinator-owned, and startup goes on. The read is retried in the
 * background a bounded number of times, adding nothing to a Turn; the roster
 * applies from the retry that reads it. Closing the roster, as the runtime's
 * close and startup cleanup do through the Session System, ends the retries.
 */
export async function readCoordinatorRoster(agents, logger, retries = {}) {
    try {
        return createCoordinatorRoster(await agents.listBuiltinDefinitions());
    }
    catch (error) {
        logger.error({ error: errorMessage(error) }, 'Built-in coordinator Agents could not be read; every Session is ordinary');
        return recoveringRoster(agents, logger, {
            delaysMs: retries.delaysMs ?? COORDINATOR_ROSTER_RETRY_DELAYS_MS,
            schedule: retries.schedule ?? scheduleUnref,
        });
    }
}
function recoveringRoster(agents, logger, retries) {
    let read;
    let closed = false;
    let cancelPending;
    const attempt = async (index) => {
        cancelPending = undefined;
        if (closed)
            return;
        try {
            const definitions = await agents.listBuiltinDefinitions();
            if (closed)
                return;
            read = createCoordinatorRoster(definitions);
            logger.info({ retry: index + 1 }, 'Built-in coordinator Agents were read on retry');
        }
        catch (error) {
            if (closed)
                return;
            if (index + 1 < retries.delaysMs.length) {
                later(index + 1);
                return;
            }
            logger.error({ error: errorMessage(error), retries: retries.delaysMs.length }, 'Built-in coordinator Agents could not be read after retries; every Session stays ordinary');
        }
    };
    const later = (index) => {
        cancelPending = retries.schedule(() => void attempt(index), retries.delaysMs[index] ?? 0);
    };
    if (retries.delaysMs.length > 0)
        later(0);
    return {
        coordinationOf: (agentName) => read?.coordinationOf(agentName),
        available: () => read !== undefined,
        close: () => {
            closed = true;
            cancelPending?.();
            cancelPending = undefined;
        },
    };
}
//# sourceMappingURL=coordinator-roster.js.map