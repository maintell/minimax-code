/** Reservations cover queued and active opens before an EditEntry exists. */
export class PptEditOpenCoordinator {
    constructor() {
        this.flights = new Map();
        this.reservations = new Set();
        this.leases = new Map();
        this.active = 0;
        this.waiting = [];
        this.closed = false;
        this.cancellations = new Map();
    }
    pending(key) {
        return this.flights.get(key);
    }
    run(key, scope, owner, entryCount, open) {
        if (this.closed)
            return Promise.reject(new Error('source_not_found'));
        const existing = this.flights.get(key);
        if (existing)
            return existing;
        const lease = this.leases.get(scope);
        if (lease && lease.owner !== owner)
            return Promise.reject(new PptEditAdmissionError('session-conflict'));
        if (entryCount + this.reservations.size >= 8)
            return Promise.reject(new PptEditAdmissionError('session-limit'));
        this.reservations.add(key);
        this.leases.set(scope, { owner, count: (lease?.count ?? 0) + 1 });
        const release = () => {
            this.cancellations.delete(key);
            this.flights.delete(key);
            this.reservations.delete(key);
            const held = this.leases.get(scope);
            if (held && --held.count === 0)
                this.leases.delete(scope);
        };
        const result = new Promise((resolve, reject) => {
            let started = false;
            this.cancellations.set(key, (error) => {
                reject(error);
                // An active import still owns its reservation and source lease until
                // its asynchronous cleanup finishes, even after its caller has left.
                if (!started)
                    release();
            });
            const start = () => {
                started = true;
                this.active++;
                void Promise.resolve()
                    .then(() => open(() => this.reservations.delete(key)))
                    .then((value) => {
                    release();
                    resolve(value);
                }, (error) => {
                    release();
                    reject(error);
                })
                    .finally(() => {
                    this.active--;
                    this.waiting.shift()?.start();
                });
            };
            if (this.active < 2)
                start();
            else
                this.waiting.push({ key, start });
        });
        this.flights.set(key, result);
        return result;
    }
    cancel(key) {
        this.waiting = this.waiting.filter((pending) => pending.key !== key);
        this.cancellations.get(key)?.(new Error('cancelled'));
    }
    dispose() {
        this.closed = true;
        for (const pending of this.waiting.splice(0))
            this.cancellations.get(pending.key)?.(new Error('source_not_found'));
    }
}

/** Admission failures are distinct from importer and document resource failures. */
export class PptEditAdmissionError extends Error {
    constructor(reason) {
        super(reason === 'session-conflict' ? 'conflict' : 'resource_limit_exceeded');
        this.reason = reason;
        this.name = 'PptEditAdmissionError';
    }
}

