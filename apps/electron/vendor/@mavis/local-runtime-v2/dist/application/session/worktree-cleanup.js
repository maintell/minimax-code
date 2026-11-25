import { randomUUID } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import { settleInBackground } from '../../service/plugin-system/index.js';
import { canonicalWorktreePath, clearWorktreeCleanupMarker, deleteWorktreeSnapshotRef, listCleanupRepositoryWorktrees, markWorktreeCleanup, releaseWorktreeSnapshot, removeWorktreeForCleanup, restoreCleanedWorktree, snapshotWorktreeForCleanup, WORKTREE_SNAPSHOT_MISSING_MESSAGE, worktreeCheckoutPresent, worktreeCreatedAtMs, worktreeMatchesSnapshot, } from '../../service/workspace/index.js';
/** Enabling cleanup never deletes anything during the first five days. */
const WORKTREE_CLEANUP_GRACE_MS = 5 * 24 * 60 * 60 * 1000;
/**
 * Worktrees created or used within the last hour are never cleaned.
 * @internal Exported only for focused tests.
 */
export const WORKTREE_CLEANUP_MIN_IDLE_MS = 60 * 60 * 1000;
const DEFAULT_STARTUP_DELAY_MS = 60_000;
/**
 * Snapshots hold uncommitted work under refs in the user's repository, so they
 * are dropped 30 days after cleanup; the Sessions then can no longer restore.
 * @internal Exported only for focused tests.
 */
export const WORKTREE_SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Chooses worktrees to clean. Locked worktrees and those owned by a running or
 * pinned Session are always kept. Worktrees whose every owner is archived are
 * cleaned without using the quota. Every worktree, archived or not, is
 * protected while created or used within the last hour, unless one of its
 * owners was archived just now (an explicit signal). The keepCount most
 * recently active unprotected ones are kept. During the grace period only the
 * worktrees of Sessions archived just now are cleaned.
 * @internal Exported only for focused tests.
 */
export function selectWorktreesToClean(candidates, policy) {
    const alwaysKept = (candidate) => candidate.locked ||
        candidate.createdAtMs === undefined ||
        candidate.owners.length === 0 ||
        candidate.owners.some((owner) => owner.busy || owner.pinned);
    const recentlyUsed = (candidate) => policy.nowMs - (candidate.createdAtMs ?? policy.nowMs) < WORKTREE_CLEANUP_MIN_IDLE_MS ||
        candidate.owners.some((owner) => policy.nowMs - owner.updatedAtMs < WORKTREE_CLEANUP_MIN_IDLE_MS);
    const archivedNow = (candidate) => candidate.owners.some((owner) => policy.archivedNow.has(owner.sessionId));
    const eligible = candidates.filter((candidate) => !alwaysKept(candidate));
    const archived = eligible.filter((candidate) => candidate.owners.every((owner) => owner.archived));
    const removable = eligible.filter((candidate) => !archived.includes(candidate) && !recentlyUsed(candidate));
    const selected = archived
        .filter((candidate) => policy.withinGrace
        ? archivedNow(candidate)
        : archivedNow(candidate) || !recentlyUsed(candidate))
        .map((candidate) => candidate.path);
    if (policy.withinGrace)
        return selected;
    const lastActivity = (candidate) => Math.max(...candidate.owners.map((owner) => owner.updatedAtMs));
    const active = [...removable].sort((left, right) => lastActivity(right) - lastActivity(left));
    return [...selected, ...active.slice(policy.keepCount).map((candidate) => candidate.path)];
}
/**
 * Automatic worktree cleanup. Every operation runs in one background queue:
 * failures are logged and never surface to a running Turn or request.
 */
export class WorktreeCleanupService {
    options;
    tail = Promise.resolve();
    pendingSweep;
    abort = new AbortController();
    startupTimer;
    unsubscribeConfig;
    closed = false;
    constructor(options) {
        this.options = options;
    }
    start() {
        if (this.closed || this.startupTimer)
            return;
        this.background(() => this.reconcile(), 'reconcile');
        this.unsubscribeConfig = this.options.subscribeConfigChanges?.(() => {
            // Applied at once rather than queued, so a sweep already waiting sees the new grace period.
            if (!this.closed)
                this.syncGracePeriod();
        });
        this.startupTimer = setTimeout(() => this.request(), this.options.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS);
        this.startupTimer.unref?.();
    }
    /** Session lifecycle facts that should trigger cleanup or drop its records. */
    observe(fact) {
        if (fact.kind === 'created' && fact.session.runLocation?.cleanedAt !== undefined) {
            const sessionId = fact.session.sessionId;
            this.background(async () => void (await this.adoptCleanedSession(sessionId)), 'adopt');
        }
        else if (fact.kind === 'created' && fact.session.runLocation?.mode === 'new-worktree') {
            this.request();
        }
        else if (fact.kind === 'archive-changed' && fact.archived) {
            this.request(fact.sessionId);
        }
        else if (fact.kind === 'deleted') {
            this.background(() => this.forgetSession(fact.sessionId), 'forget');
        }
    }
    /** Queues one sweep; requests arriving before it starts are merged into it. */
    request(archivedSessionId) {
        if (this.closed)
            return;
        if (this.pendingSweep) {
            if (archivedSessionId)
                this.pendingSweep.archivedNow.add(archivedSessionId);
            return;
        }
        const pending = { archivedNow: new Set(archivedSessionId ? [archivedSessionId] : []) };
        this.pendingSweep = pending;
        this.background(async () => {
            this.pendingSweep = undefined;
            await this.sweep(pending.archivedNow);
        }, 'sweep');
    }
    restore(sessionId) {
        return this.enqueue(() => this.restoreNow(sessionId));
    }
    async close() {
        this.closed = true;
        if (this.startupTimer)
            clearTimeout(this.startupTimer);
        this.unsubscribeConfig?.();
        this.abort.abort();
        await this.tail;
    }
    background(task, operation) {
        settleInBackground(this.runInBackground(task, operation));
    }
    async runInBackground(task, operation) {
        try {
            await this.enqueue(task);
        }
        catch (error) {
            if (this.abort.signal.aborted)
                return;
            this.options.logger?.warn({ operation, error: describe(error) }, 'worktree cleanup failed');
        }
    }
    enqueue(task) {
        const previous = this.tail;
        const run = (async () => {
            await previous;
            return task();
        })();
        this.tail = settled(run);
        return run;
    }
    /** Disabling clears the grace period; enabling starts it now rather than at the next sweep. */
    syncGracePeriod() {
        try {
            if (this.options.config().enabled)
                this.options.records.enabledAtMs(this.options.nowMs());
            else
                this.options.records.clearEnabledAt();
        }
        catch (error) {
            this.options.logger?.warn({ operation: 'config', error: describe(error) }, 'worktree cleanup failed');
        }
    }
    async sweep(archivedNow) {
        // Retention applies even while cleanup is turned off.
        await this.expireSnapshots();
        const config = this.options.config();
        if (!config.enabled) {
            this.options.records.clearEnabledAt();
            return;
        }
        const nowMs = this.options.nowMs();
        const withinGrace = nowMs - this.options.records.enabledAtMs(nowMs) < WORKTREE_CLEANUP_GRACE_MS;
        if (withinGrace && archivedNow.size === 0)
            return;
        const candidates = await this.collectCandidates();
        const selected = new Set(selectWorktreesToClean(candidates, {
            keepCount: config.keepCount,
            nowMs,
            withinGrace,
            archivedNow,
        }));
        for (const candidate of candidates) {
            if (this.abort.signal.aborted)
                return;
            if (!selected.has(candidate.path))
                continue;
            // Settings changed while earlier worktrees were removed: the selection no longer holds.
            const current = this.options.config();
            if (!current.enabled || current.keepCount > config.keepCount)
                return;
            await this.cleanWorktree(candidate);
        }
    }
    async collectCandidates() {
        const sessions = await this.options.sessions.list();
        const byId = new Map(sessions.map((session) => [session.sessionId, session]));
        const candidates = [];
        const usages = await collectWorktreeUsages(sessions);
        for (const usage of usages) {
            if (this.abort.signal.aborted)
                break;
            if (!usage.createdByMCode)
                continue;
            const repository = await listCleanupRepositoryWorktrees(usage.path);
            const entry = repository?.entries.find((candidate) => candidate.path === usage.path);
            if (!repository || !entry || entry.isMain)
                continue;
            if (usages.some((other) => isNestedPath(usage.path, other.path)))
                continue;
            if (nestsWorktree(usage.path, repository.entries, this.options.records.list()))
                continue;
            const owners = usage.ownerIds.flatMap((id) => {
                const session = byId.get(id);
                return session ? [this.owner(session)] : [];
            });
            candidates.push({
                path: usage.path,
                ownerDirs: usage.ownerDirs,
                mainRoot: repository.mainRoot,
                locked: entry.isLocked,
                createdAtMs: await worktreeCreatedAtMs(usage.path),
                owners: await Promise.all(owners),
            });
        }
        return candidates;
    }
    async owner(session) {
        const [pinned, pendingWork] = await Promise.all([
            this.options.isPinned(session.sessionId),
            this.hasPendingWork(session),
        ]);
        return {
            sessionId: session.sessionId,
            archived: session.archived === true,
            busy: session.status === 'started' ||
                this.options.hasActiveTurn(session.sessionId) ||
                pendingWork,
            pinned,
            updatedAtMs: session.updatedAtMs,
        };
    }
    async hasPendingWork(session) {
        if (!this.options.hasPendingWork)
            return false;
        const { sessionId } = session;
        try {
            return await this.options.hasPendingWork(session);
        }
        catch (error) {
            this.options.logger?.warn({ sessionId, error: describe(error) }, 'worktree cleanup could not read pending work; keeping the worktree');
            return true;
        }
    }
    async cleanWorktree(candidate) {
        if (!(await this.unprotectedOwners(candidate)))
            return;
        const id = randomUUID();
        try {
            await this.snapshotAndRemove(candidate, id);
        }
        finally {
            await releaseWorktreeSnapshot(id);
        }
    }
    async snapshotAndRemove(candidate, id) {
        const snapshot = await snapshotWorktreeForCleanup(candidate.path, id, this.abort.signal);
        if (snapshot.kind === 'skipped') {
            this.skipped(candidate, snapshot.reason);
            return;
        }
        // Owners may have been pinned or started a Turn while the snapshot was taken.
        const owners = await this.unprotectedOwners(candidate);
        const record = this.cleanupRecord(candidate, id, snapshot, owners ?? []);
        if (!owners) {
            await this.dropRecord(record);
            return;
        }
        if (!(await this.commitCleanup(candidate, record, owners)))
            return;
        // Owners are marked, so no new Turn starts here; anything written since the
        // snapshot (an editor, a terminal process) would be lost, so keep the worktree.
        if (!(await this.matchesSnapshot(record, snapshot))) {
            await this.abandonCleanup(record);
            this.skipped(candidate, 'changed_after_snapshot');
            return;
        }
        const removed = await removeWorktreeForCleanup(candidate.mainRoot, candidate.path);
        if (!removed.ok) {
            // Restore repairs a partially removed worktree in place from the snapshot.
            this.options.logger?.warn({ worktree: candidate.path, error: removed.error }, 'worktree cleanup could not remove the worktree');
            return;
        }
        this.options.logger?.info({ worktree: candidate.path }, 'worktree cleaned');
    }
    /**
     * Compares the worktree with its snapshot and re-checks for worktrees nested
     * in it since selection: ignored directories are not compared, and removal
     * would delete such a worktree with this one. Undoes the marks when the check
     * fails, including when Runtime shuts down.
     */
    async matchesSnapshot(record, snapshot) {
        try {
            if (!(await worktreeMatchesSnapshot(record.worktreeDir, record.id, snapshot, this.abort.signal))) {
                return false;
            }
            const repository = await listCleanupRepositoryWorktrees(record.worktreeDir);
            return (repository !== undefined &&
                !nestsWorktree(record.worktreeDir, repository.entries, this.options.records.list()));
        }
        catch (error) {
            await this.abandonCleanup(record);
            throw error;
        }
    }
    skipped(candidate, reason) {
        this.options.logger?.info({ worktree: candidate.path, reason }, 'worktree cleanup skipped');
    }
    cleanupRecord(candidate, id, snapshot, owners) {
        return {
            id,
            worktreeDir: candidate.path,
            ownerDirs: [...new Set([...candidate.ownerDirs, ...owners.flatMap(sessionDir)])],
            repoDir: candidate.mainRoot,
            head: snapshot.head,
            ...(snapshot.branch ? { branch: snapshot.branch } : {}),
            snapshotRef: snapshot.snapshotRef,
            sessionIds: owners.map((session) => session.sessionId),
            addedRunLocationSessionIds: owners
                .filter((session) => session.runLocation === undefined)
                .map((session) => session.sessionId),
            cleanedAtMs: this.options.nowMs(),
        };
    }
    /**
     * Every Session that depends on the worktree now: the candidate's owners,
     * the `marked` ones and any that started using it since it was selected.
     * Undefined once cleanup is disabled or any of them is protected.
     */
    async unprotectedOwners(candidate, marked = []) {
        if (!this.options.config().enabled)
            return undefined;
        const sessions = await this.options.sessions.list();
        // Sessions marked by this cleanup no longer count as live users, so keep them by id.
        const ids = new Set([...candidate.owners.map((owner) => owner.sessionId), ...marked]);
        for (const { session, path } of await locateLiveSessions(sessions)) {
            if (isWithin(candidate.path, path))
                ids.add(session.sessionId);
        }
        const owners = sessions.filter((session) => ids.has(session.sessionId));
        const current = await Promise.all(owners.map((session) => this.owner(session)));
        const selected = new Map(candidate.owners.map((owner) => [owner.sessionId, owner]));
        const nowMs = this.options.nowMs();
        // Selection judged recency and archiving from the owners as they were then.
        const usedSinceSelection = (owner) => {
            const before = selected.get(owner.sessionId);
            if (before)
                return owner.updatedAtMs > before.updatedAtMs || (before.archived && !owner.archived);
            return !owner.archived && nowMs - owner.updatedAtMs < WORKTREE_CLEANUP_MIN_IDLE_MS;
        };
        return current.some((owner) => owner.busy || owner.pinned || usedSinceSelection(owner))
            ? undefined
            : owners;
    }
    /**
     * Record, then the worktree marker, then every owner, and only then remove: a
     * crash at any point leaves a state that reconcile() settles or restore()
     * repairs (see reconcileRecord). Any failure on the way undoes all of it.
     */
    async commitCleanup(candidate, record, owners) {
        try {
            this.options.records.save(record);
            if (!(await markWorktreeCleanup(candidate.path, record.id))) {
                throw new Error('The worktree could not be marked for cleanup');
            }
            await this.markOwners(owners, record.cleanedAtMs);
        }
        catch (error) {
            await this.abandonCleanup(record);
            throw error;
        }
        // Admission rejects new Turns once marked; a Turn, pin or new Session that slipped in
        // first wins. Only the git call that removes the worktree runs after this check.
        const current = await this.unprotectedOwners(candidate, record.sessionIds);
        if (!current || current.some((session) => !record.sessionIds.includes(session.sessionId))) {
            await this.abandonCleanup(record);
            return false;
        }
        return true;
    }
    async abandonCleanup(record) {
        await this.unmarkOwners(record.sessionIds, record.addedRunLocationSessionIds);
        await clearWorktreeCleanupMarker(record.worktreeDir, record.id);
        await this.dropRecord(record);
    }
    /**
     * A Session that only has a workspace inside the worktree gets a `current`
     * run location so admission and the restore notice cover it too. It has no
     * `parentRepoDir`, so the Session stays in its project group. The record
     * lists these Sessions, and unmarking removes the location again.
     */
    async markOwners(owners, cleanedAt) {
        for (const owner of owners) {
            // Re-read so a stale record never overwrites a newer run location or update time.
            const session = await this.options.sessions.get(owner.sessionId);
            if (!session || session.runLocation?.cleanedAt !== undefined)
                continue;
            const location = session.runLocation ?? {
                mode: 'current',
                resolvedDir: session.workspaceDir,
                createdAt: session.createdAtMs,
            };
            await this.options.sessions.setRunLocation(session.sessionId, { ...location, cleanedAt }, session.updatedAtMs);
        }
    }
    /**
     * Without a record listing the added locations, every location is kept. The
     * Session that asked for a restore counts as used now, so the restored
     * worktree is protected like any other recently used one.
     */
    async unmarkOwners(sessionIds, addedRunLocationSessionIds = [], restoredBy) {
        for (const sessionId of sessionIds) {
            const session = await this.options.sessions.get(sessionId);
            if (session?.runLocation?.cleanedAt === undefined)
                continue;
            const { runLocation } = session;
            // A Session that got a real location between the owner check and marking keeps it.
            const added = addedRunLocationSessionIds.includes(sessionId) &&
                runLocation.mode === 'current' &&
                !runLocation.parentRepoDir &&
                !runLocation.resolvedBranch;
            await this.options.sessions.setRunLocation(sessionId, added ? undefined : withoutCleanup(runLocation), sessionId === restoredBy ? this.options.nowMs() : session.updatedAtMs);
        }
    }
    /** Hides the restore action once the snapshot is known to be gone. */
    async markUnrestorable(sessionIds) {
        for (const sessionId of sessionIds) {
            const session = await this.options.sessions.get(sessionId);
            const location = session?.runLocation;
            if (!session || location?.cleanedAt === undefined || location.restorable === false)
                continue;
            await this.options.sessions.setRunLocation(sessionId, { ...location, restorable: false }, session.updatedAtMs);
        }
    }
    async restoreNow(sessionId) {
        const session = await this.options.sessions.get(sessionId);
        if (session?.runLocation?.cleanedAt === undefined) {
            return { success: false, reason: 'not_cleaned', error: 'The worktree was not cleaned up' };
        }
        // A fork or side chat copied the run location; it shares the record of its source.
        const record = this.options.records.findBySession(sessionId) ??
            this.options.records.findByDir(session.runLocation.resolvedDir);
        if (!record)
            return this.restoreUnrecorded(session);
        const outcome = await restoreCleanedWorktree({
            repoDir: record.repoDir,
            worktreeDir: record.worktreeDir,
            head: record.head,
            ...(record.branch ? { branch: record.branch } : {}),
            ...(record.snapshotRef ? { snapshotRef: record.snapshotRef } : {}),
            cleanupId: record.id,
        });
        const sessionIds = [...new Set([...record.sessionIds, sessionId])];
        if (outcome.kind === 'failed') {
            if (outcome.reason === 'snapshot_missing')
                await this.markUnrestorable(sessionIds);
            return { success: false, reason: outcome.reason, error: outcome.error };
        }
        await this.unmarkOwners(sessionIds, record.addedRunLocationSessionIds, sessionId);
        await clearWorktreeCleanupMarker(record.worktreeDir, record.id);
        await this.dropRecord(record);
        return {
            success: true,
            worktreeDir: record.worktreeDir,
            detached: outcome.detached,
            ...(outcome.branch ? { branch: outcome.branch } : {}),
        };
    }
    /**
     * A marker without a record was left by a cleanup interrupted before it
     * recorded anything, so nothing was removed: an intact worktree is simply
     * handed back.
     */
    async restoreUnrecorded(session) {
        const location = session.runLocation;
        if (!location || !(await worktreeCheckoutPresent(location.resolvedDir))) {
            await this.markUnrestorable([session.sessionId]);
            return {
                success: false,
                reason: 'snapshot_missing',
                error: WORKTREE_SNAPSHOT_MISSING_MESSAGE,
            };
        }
        await this.unmarkOwners([session.sessionId], [], session.sessionId);
        return {
            success: true,
            worktreeDir: location.resolvedDir,
            detached: false,
            ...(location.resolvedBranch ? { branch: location.resolvedBranch } : {}),
        };
    }
    /**
     * A fork or side chat of a cleaned Session copies its run location. It joins
     * the cleanup record, so the snapshot outlives the source Session and
     * restoring either one clears both.
     */
    async adoptCleanedSession(sessionId) {
        const session = await this.options.sessions.get(sessionId);
        const location = session?.runLocation;
        if (!location || location.cleanedAt === undefined)
            return false;
        if (this.options.records.findBySession(sessionId))
            return true;
        const record = this.options.records.findByDir(location.resolvedDir);
        if (!record)
            return false;
        this.options.records.save({ ...record, sessionIds: [...record.sessionIds, sessionId] });
        return true;
    }
    /** Settles cleanups and restores that a crash or forced quit interrupted. */
    async reconcile() {
        // Most installs never clean a worktree; skip reading every Session for them.
        if (!this.options.records.everCleaned())
            return;
        await this.expireSnapshots();
        const sessions = await this.options.sessions.list();
        const byId = new Map(sessions.map((session) => [session.sessionId, session]));
        const recorded = new Set();
        for (const record of this.options.records.list()) {
            if (this.abort.signal.aborted)
                return;
            for (const sessionId of record.sessionIds)
                recorded.add(sessionId);
            await this.reconcileRecord(record, byId);
        }
        await this.reconcileUnrecorded(sessions, recorded);
    }
    /** Marked Sessions no record covers: adopted into one, or unmarked while their worktree is intact. */
    async reconcileUnrecorded(sessions, recorded) {
        for (const session of sessions) {
            if (this.abort.signal.aborted)
                return;
            const location = session.runLocation;
            if (location?.cleanedAt === undefined || recorded.has(session.sessionId))
                continue;
            if (await this.adoptCleanedSession(session.sessionId))
                continue;
            if (await worktreeCheckoutPresent(location.resolvedDir)) {
                await this.unmarkOwners([session.sessionId]);
            }
        }
    }
    /**
     * Removal starts only after every owner is marked. A record whose owners are
     * not all marked belongs to a cleanup that stopped before removing anything,
     * or to a restore that finished but did not drop it: while the worktree is in
     * place its markers and the record are dropped. When the worktree is gone
     * anyway, the snapshot is kept and the remaining owners are marked so they can
     * still restore it.
     */
    async reconcileRecord(record, byId) {
        const owners = record.sessionIds.flatMap((id) => {
            const session = byId.get(id);
            return session ? [session] : [];
        });
        if (owners.length === 0) {
            await this.abandonCleanup(record);
            return;
        }
        const unmarked = owners.filter((session) => session.runLocation?.cleanedAt === undefined);
        if (unmarked.length === 0)
            return;
        if (await worktreeCheckoutPresent(record.worktreeDir)) {
            await this.abandonCleanup(record);
            return;
        }
        await this.markOwners(unmarked, record.cleanedAtMs);
    }
    /** Drops snapshots past retention; their Sessions show the unrestorable notice. */
    async expireSnapshots() {
        const cutoff = this.options.nowMs() - WORKTREE_SNAPSHOT_RETENTION_MS;
        for (const record of this.options.records.list()) {
            if (this.abort.signal.aborted)
                return;
            if (record.cleanedAtMs > cutoff)
                continue;
            await this.markUnrestorable(record.sessionIds);
            await this.dropRecord(record);
        }
    }
    async forgetSession(sessionId) {
        for (const record of this.options.records.forgetSession(sessionId)) {
            await this.dropRecord(record);
        }
    }
    async dropRecord(record) {
        if (record.snapshotRef)
            await deleteWorktreeSnapshotRef(record.repoDir, record.snapshotRef);
        this.options.records.remove(record.id);
    }
}
/**
 * Live (not yet cleaned) Sessions with their canonical directory. A Session
 * without a run location depends on the directory of its workspace.
 */
async function locateLiveSessions(sessions) {
    const live = sessions.flatMap((session) => {
        if (session.runLocation?.cleanedAt !== undefined)
            return [];
        const dir = session.runLocation?.resolvedDir ?? session.workspaceDir;
        return dir ? [{ session, mode: session.runLocation?.mode ?? 'current', dir }] : [];
    });
    const canonical = new Map();
    for (const dir of new Set(live.map((entry) => entry.dir))) {
        canonical.set(dir, await canonicalWorktreePath(dir));
    }
    return live.map((entry) => ({ ...entry, path: canonical.get(entry.dir) ?? entry.dir }));
}
/** Groups live Sessions by the worktree they run in. */
async function collectWorktreeUsages(sessions) {
    const located = await locateLiveSessions(sessions);
    const usages = new Map();
    const addOwner = (usage, sessionId, dir) => {
        if (!usage.ownerIds.includes(sessionId))
            usage.ownerIds.push(sessionId);
        if (!usage.ownerDirs.includes(dir))
            usage.ownerDirs.push(dir);
    };
    for (const { session, mode, dir, path } of located) {
        if (mode === 'current')
            continue;
        const usage = usages.get(path) ?? { path, ownerDirs: [], ownerIds: [], createdByMCode: false };
        addOwner(usage, session.sessionId, dir);
        if (mode === 'new-worktree')
            usage.createdByMCode = true;
        usages.set(path, usage);
    }
    // A Session that runs anywhere inside a worktree, including in a worktree
    // nested in it, also depends on it.
    for (const { session, dir, path } of located) {
        for (const usage of usages.values()) {
            if (isWithin(usage.path, path))
                addOwner(usage, session.sessionId, dir);
        }
    }
    return [...usages.values()];
}
function sessionDir(session) {
    const dir = session.runLocation?.resolvedDir ?? session.workspaceDir;
    return dir ? [dir] : [];
}
function withoutCleanup(location) {
    const next = {
        ...location,
    };
    delete next.cleanedAt;
    delete next.restorable;
    return next;
}
function isNestedPath(root, candidate) {
    return candidate !== root && isWithin(root, candidate);
}
/**
 * Removing a worktree also deletes every registered worktree nested inside it,
 * and restoring a cleaned inner worktree needs the outer one to stay in place.
 */
function nestsWorktree(path, entries, records) {
    return (entries.some((entry) => isNestedPath(path, entry.path)) ||
        records.some((record) => isNestedPath(path, record.worktreeDir)));
}
function isWithin(root, candidate) {
    const rel = relative(root, candidate);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
async function settled(promise) {
    try {
        await promise;
    }
    catch {
        // The caller of the queued task observes its failure.
    }
}
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=worktree-cleanup.js.map