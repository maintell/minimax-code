import { randomUUID } from 'node:crypto';
import { handleKey } from './tree-guard.js';
/**
 * Per-site bookkeeping on the main thread (two.md §5, §7): view leases, issued `renderSeq`s with
 * their handle sets, the `applied` / TTL hand-over of old handles, and `RenderEvaluation` reuse.
 */
export function siteKeyOf(sessionId, slot, key) {
    return `${sessionId}\u0000${slot}\u0000${key}`;
}
/**
 * Replaced renders remembered per site: a gesture aimed at one reaches the same control in the
 * current render. Only their handle maps are kept; the realm already let the callbacks go.
 */
const REPLACED_PER_SITE = 8;
export class RenderRegistry {
    ttlMs;
    clock;
    release;
    leases = new Map();
    holders = new Map();
    issued = new Map();
    replaced = new Map();
    sites = new Map();
    evaluations = new Map();
    seq = 0;
    constructor(ttlMs, clock, release) {
        this.ttlMs = ttlMs;
        this.clock = clock;
        this.release = release;
    }
    /**
     * Next `renderSeq`: a realm binds handles per `renderSeq` across sessions, so the numbers never
     * repeat.
     */
    nextSeq() {
        this.seq += 1;
        return this.seq;
    }
    issueLease(sessionId) {
        const lease = `lease_${randomUUID()}`;
        this.leases.set(lease, sessionId);
        return lease;
    }
    releaseLease(lease) {
        this.leases.delete(lease);
        for (const [siteKey, holder] of this.holders)
            if (holder === lease)
                this.holders.delete(siteKey);
    }
    /** One mount owner per site instance (two.md §7 绘制持有). */
    claim(siteKey, sessionId, lease) {
        if (this.leases.get(lease) !== sessionId)
            return 'invalid';
        const holder = this.holders.get(siteKey);
        if (holder !== undefined && holder !== lease)
            return 'held';
        this.holders.set(siteKey, lease);
        return 'ok';
    }
    lookup(renderSeq) {
        const record = this.issued.get(renderSeq);
        if (record)
            return { record, bound: true };
        const replaced = this.replaced.get(renderSeq);
        return replaced ? { record: replaced, bound: false } : undefined;
    }
    /**
     * The handle of `plugin`'s control in the site's current render that `handle` of a replaced
     * render was bound to: the same keyed control (element type, callback prop and key chain), found
     * exactly once and drawn by the same plugin revision.
     */
    sameControl(replaced, plugin, handle) {
        const control = replaced.handles.get(handleKey(plugin, handle))?.control;
        const renderSeq = this.sites.get(replaced.siteKey)?.current;
        const record = renderSeq === undefined ? undefined : this.issued.get(renderSeq);
        if (control === undefined || renderSeq === undefined || !record)
            return undefined;
        if (record.layers.get(plugin)?.realmKey !== replaced.layers.get(plugin)?.realmKey) {
            return undefined;
        }
        const matches = [...record.handles.values()].filter((site) => site.plugin === plugin && site.control === control);
        const [match] = matches;
        return matches.length === 1 && match ? { renderSeq, handle: match.handle, record } : undefined;
    }
    /** New handles go live; the previous render's stay valid until `applied` or the TTL. */
    publish(renderSeq, record) {
        this.issued.set(renderSeq, record);
        const site = this.siteSeqs(record.siteKey);
        if (site.current !== undefined) {
            const previous = site.current;
            site.superseded.set(previous, this.clock.setTimeout(() => this.expire(previous, true), this.ttlMs));
        }
        site.current = renderSeq;
    }
    applied(siteKey, renderSeq) {
        const record = this.issued.get(renderSeq);
        if (!record || record.siteKey !== siteKey)
            return;
        const site = this.sites.get(siteKey);
        for (const older of [...(site?.superseded.keys() ?? [])]) {
            if (older < renderSeq)
                this.expire(older, true);
        }
    }
    /**
     * Releases a render's handles. One a newer render replaced (`applied` or the TTL) stays known
     * as `replaced`; one dropped for any other reason (retired revision, lost Worker, deleted
     * session) is forgotten, so nothing finds a control for it.
     */
    expire(renderSeq, replaced = false) {
        const record = this.issued.get(renderSeq);
        if (!record)
            return;
        this.issued.delete(renderSeq);
        const site = this.sites.get(record.siteKey);
        if (site) {
            this.clock.clearTimeout(site.superseded.get(renderSeq));
            site.superseded.delete(renderSeq);
            if (site.current === renderSeq)
                site.current = undefined;
            if (replaced)
                this.rememberReplaced(site, renderSeq, record);
            if (site.current === undefined && site.superseded.size === 0) {
                for (const seq of site.replaced)
                    this.replaced.delete(seq);
                this.sites.delete(record.siteKey);
            }
        }
        this.release(record, renderSeq);
    }
    rememberReplaced(site, renderSeq, record) {
        this.replaced.set(renderSeq, record);
        site.replaced.push(renderSeq);
        while (site.replaced.length > REPLACED_PER_SITE) {
            const oldest = site.replaced.shift();
            if (oldest !== undefined)
                this.replaced.delete(oldest);
        }
    }
    expireWhere(match) {
        for (const [renderSeq, record] of [...this.issued])
            if (match(record))
                this.expire(renderSeq);
        for (const [renderSeq, record] of [...this.replaced]) {
            if (!match(record))
                continue;
            this.replaced.delete(renderSeq);
            const site = this.sites.get(record.siteKey);
            const index = site?.replaced.indexOf(renderSeq) ?? -1;
            if (index >= 0)
                site?.replaced.splice(index, 1);
        }
    }
    evaluation(siteKey) {
        return this.evaluations.get(siteKey);
    }
    remember(evaluation) {
        this.evaluations.set(evaluation.siteKey, evaluation);
    }
    /** Drops matching evaluations and returns them so callers can emit `invalidate`. */
    forget(match) {
        const dropped = [...this.evaluations.values()].filter(match);
        for (const evaluation of dropped)
            this.evaluations.delete(evaluation.siteKey);
        return dropped;
    }
    dropSession(sessionId) {
        this.expireWhere((record) => record.sessionId === sessionId);
        this.forget((evaluation) => evaluation.sessionId === sessionId);
        for (const [lease, owner] of [...this.leases])
            if (owner === sessionId)
                this.releaseLease(lease);
    }
    close() {
        this.expireWhere(() => true);
        this.evaluations.clear();
    }
    siteSeqs(siteKey) {
        let site = this.sites.get(siteKey);
        if (!site) {
            site = { superseded: new Map(), replaced: [] };
            this.sites.set(siteKey, site);
        }
        return site;
    }
}
/**
 * Gestures per `(sessionId, pluginId)` run in order and never drop silently: past the capacity the
 * caller gets `GESTURE_QUEUE_FULL` (two.md §7 配额与队列).
 */
export class GestureQueues {
    capacity;
    queues = new Map();
    jobs = new WeakSet();
    constructor(capacity) {
        this.capacity = capacity;
    }
    enqueue(sessionId, pluginId, task) {
        const key = `${sessionId}\u0000${pluginId}`;
        let queue = this.queues.get(key);
        if (!queue) {
            queue = { running: false, waiting: [] };
            this.queues.set(key, queue);
        }
        if (queue.waiting.length + (queue.running ? 1 : 0) >= this.capacity) {
            return Promise.resolve({
                kind: 'error',
                code: 'GESTURE_QUEUE_FULL',
                message: 'Too many pending gestures for this plugin; try again shortly',
            });
        }
        const target = queue;
        return new Promise((resolve, reject) => {
            target.waiting.push(async () => {
                try {
                    resolve(await task());
                }
                catch (error) {
                    reject(error);
                }
            });
            this.pump(key, target);
        });
    }
    dropSession(sessionId) {
        for (const key of [...this.queues.keys()]) {
            if (key.startsWith(`${sessionId}\u0000`))
                this.queues.delete(key);
        }
    }
    pump(key, queue) {
        if (queue.running)
            return;
        const job = queue.waiting.shift();
        if (!job) {
            if (this.queues.get(key) === queue)
                this.queues.delete(key);
            return;
        }
        queue.running = true;
        this.jobs.add(this.run(key, queue, job));
    }
    async run(key, queue, job) {
        try {
            await job();
        }
        finally {
            queue.running = false;
            this.pump(key, queue);
        }
    }
}
//# sourceMappingURL=render-registry.js.map