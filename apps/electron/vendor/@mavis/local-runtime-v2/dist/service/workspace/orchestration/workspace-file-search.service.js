import { settleInBackground } from '../../../infra/async/settle.js';
import { existingRoot, listWorkspaceSearchCandidates, WorkspaceFileError, } from '../operations/filesystem/files.js';
import { WorkspaceSearchIndex } from '../operations/filesystem/search-index.js';
const MAX_SESSIONS = 8;
const IDLE_TIMEOUT_MS = 30_000;
const REFRESH_INTERVAL_MS = 5_000;
const CACHE_IDLE_MS = 60_000;
const MAX_CACHED_ROOTS = 4;
const MAX_CACHED_PATHS = 100_000;
const UPDATE_INTERVAL_MS = 50;
/** Completed indexes can outlive a menu, but never their owning Runtime. */
export class WorkspaceFileSearchService {
    sessions = new Map();
    cache = new Map();
    async search(input, signal) {
        if (!/^[\w-]{1,128}$/u.test(input.searchId)) {
            throw new WorkspaceFileError('INVALID_REQUEST', 'Invalid search session ID');
        }
        signal?.throwIfAborted();
        if (!input.query.trim() || (input.limit !== undefined && input.limit <= 0)) {
            return (async function* emptyResults() {
                yield { searchId: input.searchId, query: input.query, paths: [], complete: true };
            })();
        }
        const root = await existingRoot(input.workspace);
        signal?.throwIfAborted();
        const session = this.getSession(input, root);
        clearTimeout(session.idleTimer);
        this.expireWhenIdle(input.searchId, session);
        return this.updates(input, session, signal);
    }
    getSession(input, root) {
        let session = this.sessions.get(input.searchId);
        const includeDirectories = input.includeDirectories ?? false;
        if (session && (session.root !== root || session.includeDirectories !== includeDirectories)) {
            throw new WorkspaceFileError('INVALID_REQUEST', 'Search session belongs to another workspace or mode');
        }
        if (!session)
            session = this.createSession(input.searchId, root, includeDirectories);
        if (session.complete &&
            (session.error || Date.now() - session.finishedAt >= REFRESH_INTERVAL_MS)) {
            settleInBackground(this.scan(session));
        }
        return session;
    }
    createSession(searchId, root, includeDirectories) {
        if (this.sessions.size >= MAX_SESSIONS) {
            throw new WorkspaceFileError('INVALID_REQUEST', 'Too many active file searches');
        }
        const cached = this.cache.get(JSON.stringify([root, includeDirectories]));
        const session = {
            root,
            includeDirectories,
            index: cached?.index ?? new WorkspaceSearchIndex(root, includeDirectories),
            complete: cached !== undefined,
            finishedAt: cached?.finishedAt ?? 0,
            scan: new AbortController(),
            listeners: new Set(),
        };
        this.sessions.set(searchId, session);
        if (cached)
            this.remember(session);
        else
            settleInBackground(this.scan(session));
        return session;
    }
    stop(searchId) {
        const session = this.sessions.get(searchId);
        if (!session)
            return;
        this.sessions.delete(searchId);
        clearTimeout(session.idleTimer);
        clearTimeout(session.updateTimer);
        session.scan.abort();
        for (const notify of session.listeners)
            notify();
    }
    close() {
        for (const searchId of this.sessions.keys())
            this.stop(searchId);
        for (const key of this.cache.keys())
            this.forget(key);
    }
    forget(key) {
        clearTimeout(this.cache.get(key)?.timer);
        this.cache.delete(key);
    }
    remember(session) {
        const key = JSON.stringify([session.root, session.includeDirectories]);
        this.forget(key);
        if (session.index.size > MAX_CACHED_PATHS)
            return;
        const timer = setTimeout(() => this.forget(key), CACHE_IDLE_MS);
        timer.unref();
        this.cache.set(key, { index: session.index, finishedAt: session.finishedAt, timer });
        let count = [...this.cache.values()].reduce((sum, entry) => sum + entry.index.size, 0);
        for (const [oldKey, entry] of this.cache) {
            if (this.cache.size <= MAX_CACHED_ROOTS && count <= MAX_CACHED_PATHS)
                break;
            count -= entry.index.size;
            this.forget(oldKey);
        }
    }
    expireWhenIdle(searchId, session) {
        if (session.listeners.size > 0 || session.scan.signal.aborted)
            return;
        clearTimeout(session.idleTimer);
        session.idleTimer = setTimeout(() => this.stop(searchId), IDLE_TIMEOUT_MS);
        session.idleTimer.unref();
    }
    async scan(session) {
        session.complete = false;
        session.error = undefined;
        const initial = session.finishedAt === 0;
        const index = new WorkspaceSearchIndex(session.root, session.includeDirectories);
        const notify = () => {
            session.updateTimer = undefined;
            for (const listener of session.listeners)
                listener();
        };
        try {
            const paths = await listWorkspaceSearchCandidates(session.root, session.includeDirectories, {
                signal: session.scan.signal,
                onBatch: (batch) => {
                    if (session.scan.signal.aborted)
                        return;
                    index.add(batch);
                    // Refreshes keep the previous complete index visible until the new scan finishes.
                    if (!initial)
                        return;
                    session.index = index;
                    if (!session.updateTimer)
                        session.updateTimer = setTimeout(notify, UPDATE_INTERVAL_MS);
                },
            });
            if (session.scan.signal.aborted)
                return;
            index.add(paths);
            session.index = index;
            session.finishedAt = Date.now();
            this.remember(session);
        }
        catch (error) {
            session.error = error;
        }
        finally {
            session.complete = true;
            clearTimeout(session.updateTimer);
            notify();
        }
    }
    async *updates(input, session, signal) {
        let wake;
        let dirty = true;
        const notify = () => {
            dirty = true;
            wake?.();
        };
        const waitForUpdate = () => new Promise((resolve) => {
            wake = resolve;
        });
        clearTimeout(session.idleTimer);
        session.listeners.add(notify);
        signal?.addEventListener('abort', notify, { once: true });
        try {
            while (!signal?.aborted && !session.scan.signal.aborted) {
                if (!dirty)
                    await waitForUpdate();
                wake = undefined;
                if (signal?.aborted || session.scan.signal.aborted)
                    return;
                dirty = false;
                if (session.error)
                    throw session.error;
                const complete = session.complete;
                yield {
                    searchId: input.searchId,
                    query: input.query,
                    paths: session.index.search(input.query, input.limit),
                    complete,
                };
                if (complete)
                    return;
            }
        }
        finally {
            session.listeners.delete(notify);
            signal?.removeEventListener('abort', notify);
            this.expireWhenIdle(input.searchId, session);
        }
    }
}
//# sourceMappingURL=workspace-file-search.service.js.map