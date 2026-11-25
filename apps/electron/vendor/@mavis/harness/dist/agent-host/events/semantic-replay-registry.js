class SemanticReplayResultUnavailableError extends Error {
    identity;
    name = 'SemanticReplayResultUnavailableError';
    constructor(identity) {
        super(`Semantic replay result is no longer retained: ${identity}.`);
        this.identity = identity;
    }
}
/**
 * Process-local delivery replay registry. Settled identities are count
 * bounded and their resolved results can additionally be byte bounded.
 * In-flight entries are never evicted and may temporarily exceed either
 * limit. When a heavy result is released, its fingerprint tombstone remains
 * so an exact retry fails closed instead of repeating a durable mutation.
 */
export class SemanticReplayRegistry {
    maximum;
    options;
    entries = new Map();
    settlements = new WeakSet();
    retainedSettledBytes = 0;
    constructor(maximum, options) {
        this.maximum = maximum;
        this.options = options;
        if (!Number.isSafeInteger(maximum) || maximum <= 0) {
            throw new RangeError('Semantic replay capacity must be a finite positive integer.');
        }
        if (options &&
            (!Number.isSafeInteger(options.maximumSettledBytes) || options.maximumSettledBytes <= 0)) {
            throw new RangeError('Semantic replay byte capacity must be a finite positive integer.');
        }
    }
    run(request) {
        const existing = this.entries.get(request.identity);
        if (existing) {
            if (existing.fingerprint === request.fingerprint) {
                return (existing.execution ??
                    Promise.reject(new SemanticReplayResultUnavailableError(request.identity)));
            }
            const conflict = request.conflict();
            return request.handleConflict ? request.handleConflict(conflict) : Promise.reject(conflict);
        }
        const execution = request.execute();
        const replay = {
            fingerprint: request.fingerprint,
            execution,
            settled: false,
            retainedBytes: 0,
        };
        this.entries.set(request.identity, replay);
        this.settlements.add(this.trackSettlement(request.identity, replay, execution));
        this.trim();
        return execution;
    }
    async trackSettlement(identity, replay, execution) {
        try {
            const value = await execution;
            replay.settled = true;
            replay.retainedBytes = this.measureSettledBytes(value);
            this.retainedSettledBytes += replay.retainedBytes;
        }
        catch {
            // The original execution preserves and reports its rejection to the caller.
            if (this.entries.get(identity) === replay)
                this.delete(identity, replay);
        }
        finally {
            this.trim();
        }
    }
    measureSettledBytes(value) {
        if (!this.options)
            return 0;
        try {
            const measured = this.options.measureSettledBytes(value);
            return Number.isSafeInteger(measured) && measured >= 0
                ? measured
                : this.options.maximumSettledBytes + 1;
        }
        catch {
            return this.options.maximumSettledBytes + 1;
        }
    }
    trim() {
        while (this.entries.size > this.maximum) {
            const settled = [...this.entries].find(([, replay]) => replay.settled);
            if (!settled)
                return;
            this.delete(...settled);
        }
        const maximumSettledBytes = this.options?.maximumSettledBytes;
        if (maximumSettledBytes === undefined)
            return;
        while (this.retainedSettledBytes > maximumSettledBytes) {
            const candidate = [...this.entries].find(([, replay]) => replay.settled && replay.execution && replay.retainedBytes > 0);
            if (!candidate)
                return;
            const [, replay] = candidate;
            this.retainedSettledBytes -= replay.retainedBytes;
            replay.retainedBytes = 0;
            replay.execution = undefined;
        }
    }
    delete(identity, replay) {
        if (this.entries.get(identity) !== replay)
            return;
        this.entries.delete(identity);
        this.retainedSettledBytes -= replay.retainedBytes;
    }
}
//# sourceMappingURL=semantic-replay-registry.js.map