import { branchKey, definedFields, } from '../code-host/adapter.js';
import { ageMs } from '../code-host/host-scheduler.js';
import { mergeRequestKey, projectKey } from '../code-host/urls.js';
import { settleInBackground } from '../../../infra/async/settle.js';
import { fetchError, toFetchError } from './fetch-errors.js';
import { sameProject } from './fetch-request.js';
import { summaryOnly } from './snapshot-cache.js';
/** Entries kept per map; the least recently stored go first. */
const MAX_REMEMBERED = 2_000;
/** Changes are written to the cache file at most this often. */
const SAVE_DELAY_MS = 2_000;
/** Snapshots and branch answers kept on disk, the most recently read ones. */
const MAX_PERSISTED = 300;
/**
 * What the runtime last learned from GitLab and GitHub: merge request
 * snapshots, the merge requests of each branch, when details were read, and
 * why a read brought nothing. Held in memory, written to the cache file behind
 * changes, and read back at start.
 */
export class MergeRequestMemory {
    options;
    remembered = new Map();
    branchMatches = new Map();
    /** When each merge request's jobs and threads were last read. */
    detailAtMs = new Map();
    /** Why the latest read of a merge request brought no data; cleared by the next good read. */
    failures = new Map();
    saveTimer;
    constructor(options) {
        this.options = options;
    }
    entry(key) {
        return this.remembered.get(key);
    }
    snapshot(key) {
        return this.remembered.get(key)?.snapshot;
    }
    failure(key) {
        return this.failures.get(key);
    }
    /**
     * Takes what a read brought where memory holds nothing newer. A read sent
     * before a change the user made from MCode can land after the read that
     * followed the change; the older answer must not bring back the old state.
     */
    remember(outcome) {
        const { result } = outcome;
        const now = this.options.nowMs();
        const atMs = result.fetchedAtMs ?? now;
        // A time ahead of the clock is not newer, so a clock set back cannot freeze a card.
        const isNewer = (heldAtMs) => heldAtMs === undefined || heldAtMs > now || atMs >= heldAtMs;
        const details = new Map([...result.details].filter(([key]) => isNewer(this.detailAtMs.get(key))));
        for (const key of details.keys())
            this.detailAtMs.set(key, atMs);
        trim(this.detailAtMs);
        if (result.mergeRequests.size > 0 || result.branches.size > 0)
            this.scheduleSave();
        for (const [key, snapshot] of result.mergeRequests) {
            const held = this.remembered.get(key);
            if (isNewer(held?.atMs))
                this.store(key, { snapshot: joinDetails(snapshot, details.get(key), held), atMs });
        }
        this.rememberLooseDetails(result, details, atMs);
        for (const [key, matches] of result.branches) {
            if (!isNewer(this.branchMatches.get(key)?.atMs))
                continue;
            this.branchMatches.set(key, {
                refKeys: matches.map((snapshot) => mergeRequestKey(snapshot.ref)),
                atMs,
            });
        }
        trim(this.branchMatches);
    }
    /** Remembers why this round brought no data for a merge request, or forgets an old reason. */
    recordFailures(request, fetched) {
        for (const ref of request.refs()) {
            const key = mergeRequestKey(ref);
            const error = fetchError(ref, fetched);
            if (error)
                this.failures.set(key, error);
            else
                this.failures.delete(key);
        }
        // A branch's merge request is found by the branch, not asked for by number. Only
        // a failed host marks it: a branch that no longer has it open is not a failure.
        for (const key of request.branchKeys()) {
            for (const refKey of this.branchMatches.get(key)?.refKeys ?? []) {
                const ref = this.remembered.get(refKey)?.snapshot.ref;
                const outcome = ref ? fetched.get(ref.host) : undefined;
                if (!outcome)
                    continue;
                if (outcome.error && !outcome.result.mergeRequests.has(refKey))
                    this.failures.set(refKey, toFetchError(outcome.error));
                else
                    this.failures.delete(refKey);
            }
        }
        trim(this.failures);
    }
    /**
     * Whether memory holds data for every merge request and branch the request asks
     * about. A merge request that only ever failed is not covered: showing the old
     * failure would hide that the user may just have logged in, and asking again is
     * cheap while the CLI is still logged out, since no request leaves the machine.
     */
    covers(request) {
        return (request.refs().every((ref) => this.remembered.has(mergeRequestKey(ref))) &&
            request.branchKeys().every((key) => this.branchMatches.has(key)));
    }
    /** Whether any part of the answer, details included, was read `windowMs` or longer ago. */
    needsRefresh(request, now, windowMs) {
        const old = (atMs) => atMs === undefined || ageMs(atMs, now) >= windowMs;
        return (request.refs().some((ref) => old(this.remembered.get(mergeRequestKey(ref))?.atMs)) ||
            request.branchKeys().some((key) => old(this.branchMatches.get(key)?.atMs)) ||
            request.detailRefs().some((ref) => old(this.detailAtMs.get(mergeRequestKey(ref)))));
    }
    /** When the oldest data an answer from memory shows was read. */
    oldestAtMs(request) {
        const times = [
            ...request.refs().map((ref) => this.remembered.get(mergeRequestKey(ref))?.atMs),
            ...request.branchKeys().map((key) => this.branchMatches.get(key)?.atMs),
        ].filter((atMs) => atMs !== undefined);
        return times.length > 0 ? Math.min(...times) : undefined;
    }
    isFresh(key, now, windowMs) {
        const remembered = this.remembered.get(key);
        return remembered !== undefined && ageMs(remembered.atMs, now) < windowMs;
    }
    /**
     * The branch's open merge request. Branch queries ask for open ones only; a merged
     * one stays on the panel through the branch record taken while it was open.
     */
    currentBranchKey(repo) {
        if (!repo.branch)
            return undefined;
        const match = this.branchMatches.get(branchKey(projectKey(repo.platform, repo.host, repo.projectPath), repo.branch));
        const chosen = match?.refKeys
            .map((key) => this.remembered.get(key)?.snapshot)
            .find((snapshot) => snapshot?.state === 'open');
        return chosen ? mergeRequestKey(chosen.ref) : undefined;
    }
    /**
     * The branch's merge request from the last branch query; failing that, the
     * newest open one learned another way, such as one an agent just created.
     */
    branchSnapshot(repo) {
        const key = this.currentBranchKey(repo);
        if (key)
            return this.remembered.get(key)?.snapshot;
        let newest;
        for (const { snapshot } of this.remembered.values()) {
            if (!isOpenOnBranch(snapshot, repo))
                continue;
            if (!newest || (snapshot.updatedAtMs ?? 0) > (newest.updatedAtMs ?? 0))
                newest = snapshot;
        }
        return newest;
    }
    /** Reads what an earlier run kept; anything already learned in this run wins. */
    async restore() {
        let data;
        try {
            data = await this.options.cache?.load();
        }
        catch {
            // An unreadable cache only costs the first read its head start.
            return;
        }
        if (!data)
            return;
        for (const { key, atMs, snapshot } of data.snapshots) {
            if (!this.remembered.has(key))
                this.remembered.set(key, { snapshot, atMs });
        }
        for (const { key, atMs, refKeys } of data.branches) {
            if (!this.branchMatches.has(key))
                this.branchMatches.set(key, { refKeys, atMs });
        }
        this.options.gateway.importState(data.gateway);
    }
    scheduleSave() {
        if (!this.options.cache || this.saveTimer)
            return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            settleInBackground(this.saveQuietly());
        }, SAVE_DELAY_MS);
        this.saveTimer.unref?.();
    }
    /** Writes the cache file now instead of after the usual delay. */
    async flush() {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }
        await this.save();
    }
    async saveQuietly() {
        try {
            await this.save();
        }
        catch {
            // The next change tries again; memory still answers this run.
        }
    }
    async save() {
        await this.options.cache?.save({
            snapshots: [...this.remembered].slice(-MAX_PERSISTED).map(([key, entry]) => ({
                key,
                atMs: entry.atMs,
                snapshot: summaryOnly(entry.snapshot),
            })),
            branches: [...this.branchMatches].slice(-MAX_PERSISTED).map(([key, match]) => ({
                key,
                atMs: match.atMs,
                refKeys: match.refKeys,
            })),
            gateway: this.options.gateway.exportState(),
        });
    }
    /** Details whose own summary was not taken this round join the summary already held. */
    rememberLooseDetails(result, details, atMs) {
        for (const [key, detail] of details) {
            const held = this.remembered.get(key);
            if (!held || (result.mergeRequests.has(key) && held.atMs === atMs))
                continue;
            this.store(key, { snapshot: withDetails(held.snapshot, detail), atMs: held.atMs });
        }
    }
    store(key, value) {
        this.remembered.delete(key);
        this.remembered.set(key, value);
        trim(this.remembered);
    }
}
function isOpenOnBranch(snapshot, repo) {
    return (snapshot.state === 'open' &&
        snapshot.sourceBranch === repo.branch &&
        sameProject(snapshot.ref, repo));
}
/**
 * A summary with details: the ones read with it, or else those an expanded card
 * read earlier, whose own time decides when they are read again.
 */
function joinDetails(snapshot, details, held) {
    return details
        ? withDetails(snapshot, details)
        : { ...snapshot, ...detailFieldsOf(held?.snapshot) };
}
function withDetails(snapshot, details) {
    return {
        ...snapshot,
        jobs: details.jobs,
        discussions: details.discussions,
        ...definedFields({
            description: details.description,
            reviewers: details.reviewers,
            commits: details.commits,
        }),
    };
}
function detailFieldsOf(snapshot) {
    if (!snapshot)
        return {};
    return definedFields({
        jobs: snapshot.jobs,
        discussions: snapshot.discussions,
        description: snapshot.description,
        reviewers: snapshot.reviewers,
        commits: snapshot.commits,
    });
}
/** Keeps a Map used as an LRU within bounds by dropping its oldest entries. */
export function trim(map) {
    while (map.size > MAX_REMEMBERED) {
        const oldest = map.keys().next().value;
        if (oldest === undefined)
            return;
        map.delete(oldest);
    }
}
//# sourceMappingURL=snapshot-memory.js.map