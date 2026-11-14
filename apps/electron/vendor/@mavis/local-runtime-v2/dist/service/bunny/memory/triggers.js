import { BUNNY_AGENT_NAME } from '../contracts.js';
const HANDLER = 'bunny.memory.idle';
const IDLE_MS = 30 * 60_000;
/** The Scheduler rejects past one-shot times; keep a margin past its own clock read. */
const MIN_DELAY_MS = 5_000;
/** Scheduler callbacks admit work synchronously; this owner drains it on close. */
export function bindBunnyMemoryTriggers(options) {
    const { service, scheduler } = options;
    const nowMs = options.nowMs ?? Date.now;
    const enabled = options.enabled ?? (() => true);
    let timer;
    let closed = false;
    let ready = false;
    let pending = Promise.resolve();
    const enqueue = (run) => {
        if (closed)
            return;
        const previous = pending;
        pending = (async () => {
            try {
                await previous;
                if (!closed)
                    await run();
            }
            catch (error) {
                options.warn(error);
            }
        })();
    };
    const lastUserAt = () => service.source
        .candidates()
        .filter((row) => !row.archived && row.sessionType === 'root' && row.agentName === BUNNY_AGENT_NAME)
        .map((row) => service.source.latestUser(row.sessionId)?.atMs ?? 0)
        .sort((a, b) => b - a)[0] ?? 0;
    const arm = () => {
        if (!ready || closed || !scheduler || !enabled())
            return;
        const schedule = {
            kind: 'once',
            runAtMs: Math.max(nowMs() + MIN_DELAY_MS, lastUserAt() + IDLE_MS),
        };
        // Memory upkeep is background work: a timer failure must not abort runtime startup.
        try {
            if (timer && scheduler.get(timer))
                scheduler.reschedule(timer, schedule);
            else {
                timer = scheduler.schedule(HANDLER, schedule);
                const id = timer;
                enqueue(() => service.store.withLock(() => service.store.setIdleJobId(id)));
            }
        }
        catch (error) {
            options.warn(error);
        }
    };
    scheduler?.registerHandler(HANDLER, () => {
        enqueue(async () => {
            // Turned off since this timer was armed: stay idle until a Bunny event re-arms.
            if (!enabled())
                return;
            // A queued timer can become stale while a new user message is being committed.
            if (lastUserAt() + IDLE_MS > nowMs()) {
                arm();
                return;
            }
            // Once a day: lint first drains all unprocessed main and task messages, then consolidates.
            try {
                await service.lint();
            }
            catch {
                // The memory service reported the failure and backs off before its next run.
            }
            // After memory, so the two never run models at once; it reports its own failures.
            await options.afterLint?.run();
        });
    });
    /** Activity in Bunny's main conversation re-arms the idle timer. */
    function onActivity(sessionId) {
        try {
            service.source.requireMain(sessionId);
        }
        catch {
            /* Other conversations are not a Bunny idle boundary. */
            return;
        }
        // The first main conversation of a run that started without one prepares memory here.
        if (ready)
            arm();
        else
            enqueue(async () => {
                await prepare();
                arm();
            });
    }
    const unsubscribe = options.events.subscribe((event) => {
        // An archived main conversation stays a capture source: the next daily upkeep reads it.
        if (enabled() &&
            (event.type === 'session.start' ||
                event.type === 'session.queue.updated' ||
                event.type === 'questionnaire.state')) {
            onActivity(event.payload.sessionId);
        }
    });
    let preparing;
    const prepare = () => {
        preparing ??= (async () => {
            // Memory is a degradable Bunny capability: invalid or unreadable memory files must not
            // fail runtime startup. Rendering, saves and background upkeep retry on their next use.
            try {
                await service.store.withLock(() => service.store.reconcile());
                timer = await service.store.idleJobId();
            }
            catch (error) {
                options.warn(error);
            }
            ready = true;
        })();
        return preparing;
    };
    return {
        /** Reconciles memory and reads the armed idle timer; runs once. */
        ready: prepare,
        start: () => {
            arm();
        },
        close: async () => {
            closed = true;
            unsubscribe();
            service.stop();
            options.afterLint?.stop();
            await pending;
            await service.store.withLock(async () => undefined);
        },
        /** Developer replay entry: no UI-visible cron definition is created. */
        run: (kind, sessionId) => kind === 'capture' ? service.capture(sessionId) : service.lint(true),
    };
}
//# sourceMappingURL=triggers.js.map