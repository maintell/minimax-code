import { matchesObserveHook } from '../sdk/contracts/events.js';
import { breakerKeyOf, entryLabel } from './breaker.js';
import { GestureQueues } from './render/render-registry.js';
export class ObserveDispatch {
    deps;
    queues;
    constructor(deps) {
        this.deps = deps;
        this.queues = new GestureQueues(deps.capacity);
    }
    /** Admits every matching hook at once; resolves when they all settled, never rejects. */
    dispatch(request) {
        const queued = [];
        for (const record of this.deps.records(request.sessionId)) {
            if (request.pluginId !== undefined && record.input.pluginId !== request.pluginId)
                continue;
            const payload = request.spawner?.pluginId === record.input.pluginId
                ? { ...request.payload, ...request.spawner.fields }
                : request.payload;
            queued.push(...this.admit(record, request.event, request.match, () => payload));
        }
        return settleAll(queued);
    }
    /**
     * Admits `event` for this one activation, ahead of anything queued for it later, while it is
     * live. `payload` is read when the job's turn comes; a read that fails runs no hook.
     */
    dispatchTo(activation, event, payload) {
        if (!this.deps.records(activation.input.sessionId).includes(activation)) {
            return Promise.resolve();
        }
        return settleAll(this.admit(activation, event, {}, payload));
    }
    dropSession(sessionId) {
        this.queues.dropSession(sessionId);
    }
    /** Identical registrations resolve to the same realm hook; each runs once per event. */
    admit(activation, event, match, payload) {
        const queued = [];
        const seen = new Set();
        for (const hook of activation.input.artifact.hooks) {
            if (hook.slot !== event)
                continue;
            const claims = matchesObserveHook(hook, event, match);
            const entry = entryLabel(hook.matcher);
            if (!claims || seen.has(entry))
                continue;
            seen.add(entry);
            queued.push(this.queue({ activation, event, hook, entry, payload }));
        }
        return queued;
    }
    /** Admission into the plugin's queue happens before the first `await`, in arrival order. */
    async queue(job) {
        const { activation, event, hook, entry } = job;
        const { input } = activation;
        const breakerKey = breakerKeyOf({
            pluginId: input.pluginId,
            slot: event,
            entry,
            tier: input.tier,
            artifactDigest: input.artifact.digest,
            sessionId: input.sessionId,
        });
        if (this.deps.ledger.isHookDisabled(breakerKey))
            return;
        const where = { pluginId: input.pluginId, sessionId: input.sessionId, slot: event };
        try {
            const response = await this.queues.enqueue(input.sessionId, input.pluginId, async () => {
                let payload;
                try {
                    payload = await job.payload();
                }
                catch (error) {
                    this.deps.diagnose({
                        code: 'EXTENSION_OBSERVE_FAILED',
                        message: `${event} not delivered: ${error instanceof Error ? error.message : String(error)}`,
                        ...where,
                    });
                    return { ok: true };
                }
                return this.deps.run({
                    activation,
                    kind: 'event',
                    breakerKey,
                    target: { type: 'expected', hook },
                    site: { slot: event, key: entry },
                    event: payload,
                });
            });
            if (!('kind' in response) || response.code !== 'GESTURE_QUEUE_FULL')
                return;
            this.deps.diagnose({
                code: 'GESTURE_QUEUE_FULL',
                message: `${event} dropped: too many pending observe hooks`,
                ...where,
            });
        }
        catch {
            // `run` answers every failure itself; nothing here may reach the turn.
        }
    }
}
/** `queue` answers every failure itself, so this never rejects. */
async function settleAll(queued) {
    await Promise.allSettled(queued);
}
//# sourceMappingURL=observe.js.map