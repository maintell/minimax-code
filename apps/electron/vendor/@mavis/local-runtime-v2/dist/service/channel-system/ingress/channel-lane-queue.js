export class LocalChannelLaneQueue {
    tails = new Map();
    queued = new Map();
    active = new Map();
    async enqueue(lane, task) {
        const laneName = normalizeLane(lane);
        const previous = this.tails.get(laneName) ?? Promise.resolve();
        this.queued.set(laneName, (this.queued.get(laneName) ?? 0) + 1);
        let release;
        const current = new Promise((resolve) => {
            release = resolve;
        });
        // The lane tail chains onto `previous` with failures isolated, so one
        // rejected task never blocks the tasks queued after it.
        const tail = chainLaneTail(previous, current);
        this.tails.set(laneName, tail);
        await settleQuietly(previous);
        this.queued.set(laneName, Math.max(0, (this.queued.get(laneName) ?? 1) - 1));
        this.active.set(laneName, (this.active.get(laneName) ?? 0) + 1);
        try {
            return await task();
        }
        finally {
            this.active.set(laneName, Math.max(0, (this.active.get(laneName) ?? 1) - 1));
            release();
            if (this.tails.get(laneName) === tail)
                this.tails.delete(laneName);
        }
    }
    stats() {
        const lanes = new Set([...this.queued.keys(), ...this.active.keys(), ...this.tails.keys()]);
        const out = {};
        for (const lane of lanes) {
            out[lane] = {
                queued: this.queued.get(lane) ?? 0,
                active: this.active.get(lane) ?? 0,
            };
        }
        return out;
    }
}
function normalizeLane(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : 'interactive';
}
/** Await settlement, swallowing rejection: lane order only needs "finished". */
async function settleQuietly(previous) {
    try {
        await previous;
    }
    catch {
        // The failed task's rejection already surfaced to its own caller.
    }
}
/** New lane tail: previous settles (failure isolated), then `current` resolves. */
async function chainLaneTail(previous, current) {
    await settleQuietly(previous);
    await current;
}
//# sourceMappingURL=channel-lane-queue.js.map