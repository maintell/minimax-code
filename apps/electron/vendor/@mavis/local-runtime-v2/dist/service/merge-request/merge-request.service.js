import { observeMetric } from '@mavis/shared/local-runtime-logging/metrics';
import { ageMs } from './code-host/host-scheduler.js';
import { compareForDisplay } from './code-host/status.js';
import { mergeRequestKey, mergeRequestWebUrl, parseMergeRequestUrl } from './code-host/urls.js';
import { detectCreatedMergeRequest, detectPush } from './command-detect.js';
import { MergeRequestError, } from './contracts.js';
import { fetchError, toServiceError } from './snapshots/fetch-errors.js';
import { FetchRequest, hostsOf, panelRequest, sameProject } from './snapshots/fetch-request.js';
import { summaryOnly } from './snapshots/snapshot-cache.js';
import { MergeRequestMemory, trim } from './snapshots/snapshot-memory.js';
/** Panel rounds within this window reuse one platform answer. */
const PANEL_CACHE_TTL_MS = 30_000;
/** List icons skip merge requests the panel refreshed this recently. */
const BADGE_FRESH_MS = 60_000;
const BADGE_POLL_MS = 300_000;
/** A Turn end only asks the platform again when the branch answer is older than this. */
const TURN_END_CACHE_TTL_MS = 300_000;
const WORKSPACE_TTL_MS = 5_000;
/** List icons are not refreshed for Sessions idle longer than this. */
const INACTIVE_SESSION_MS = 7 * 24 * 3_600_000;
const MAX_BADGE_SESSIONS = 100;
/** How far up parentSessionId to look for the Session the sidebar shows. */
const MAX_PARENT_DEPTH = 8;
/** Status of Session merge requests on GitLab and GitHub, read through glab / gh. */
export class MergeRequestService {
    options;
    memory;
    workspaces = new Map();
    /**
     * Background refreshes in flight and when each last started, keyed by Session and
     * the cards it expanded: expanding another card is a new read, not a repeat.
     */
    refreshes = new Map();
    refreshStartedAtMs = new Map();
    badgeRefresh;
    badgeRefreshStartedAtMs;
    /** Settles once the cache file has been read; every read waits for it. */
    loaded;
    constructor(options) {
        this.options = options;
        this.memory = new MergeRequestMemory({
            nowMs: options.nowMs,
            gateway: options.gateway,
            ...(options.cache ? { cache: options.cache } : {}),
        });
        this.loaded = this.memory.restore();
        options.gateway.watchState(() => this.memory.scheduleSave());
    }
    async listSession(sessionId, input = {}) {
        const startedAtMs = this.options.nowMs();
        await this.loaded;
        const session = await this.requireSession(sessionId);
        const force = input.forceRefresh === true;
        const links = this.options.links.listActive([sessionId]);
        const repo = await this.resolveRepo(session.workspaceDir, force);
        const detailRefs = input.detailRefs ?? [];
        const detailKeys = new Set(detailRefs.map(mergeRequestKey));
        const request = panelRequest(links, repo, detailRefs);
        const hosts = hostsOf(links, repo);
        // CLI checks do not depend on the answer, so they run alongside it.
        const statuses = this.hostStatuses(hosts);
        const { served, refreshing } = await this.serve(sessionId, request, force);
        const answer = {
            mergeRequests: this.views(links, repo, detailKeys),
            hosts: await statuses,
            ...(repo ? { repo } : {}),
            pollAfterMs: this.options.gateway.pollAfterMs(hosts.keys(), this.refreshMs()),
            ...(refreshing ? { refreshing: true } : {}),
        };
        observeMetric(this.options.metrics, 'merge_request_list_ms', this.options.nowMs() - startedAtMs, {
            served,
        });
        return answer;
    }
    /**
     * Gets the request's data into memory as the read needs it. Nothing to show
     * yet, or a manual refresh: wait for the platform. Older than the cache window:
     * answer with what is held and read again behind it; merge_request.updated then
     * tells the panel to read once more.
     */
    async serve(sessionId, request, force) {
        if (force || !this.memory.covers(request)) {
            await this.fetch(request, {
                priority: force ? 'user' : 'background',
                cacheTtlMs: PANEL_CACHE_TTL_MS,
                ...(force ? { force } : {}),
            });
            return { served: 'fetched', refreshing: false };
        }
        if (!this.memory.needsRefresh(request, this.options.nowMs(), PANEL_CACHE_TTL_MS))
            return { served: 'fresh', refreshing: false };
        this.observeServedAge(request);
        return { served: 'stale', refreshing: this.refreshInBackground(sessionId, request) };
    }
    async badges(sessionIds) {
        await this.loaded;
        const now = this.options.nowMs();
        const targets = await this.badgeTargets(sessionIds, now);
        const request = this.staleRequest(targets, now);
        if (!request.isEmpty()) {
            // A list icon with nothing to show waits for the platform; one that has an
            // older answer shows it and is refreshed behind it.
            if (this.memory.covers(request))
                this.refreshBadgesInBackground(request, targets);
            else
                await this.fetch(request, { priority: 'background', cacheTtlMs: BADGE_FRESH_MS });
        }
        const hosts = new Map();
        const badges = [];
        for (const target of targets) {
            for (const [host, platform] of hostsOf(target.links, undefined))
                hosts.set(host, platform);
            const badge = this.badge(target);
            if (badge)
                badges.push(badge);
        }
        return { badges, pollAfterMs: this.options.gateway.pollAfterMs(hosts.keys(), BADGE_POLL_MS) };
    }
    async jobLog(sessionId, ref, jobId, options = {}) {
        const session = await this.requireSession(sessionId);
        await this.assertVisible(sessionId, session, ref);
        const key = mergeRequestKey(ref);
        const findJob = () => {
            const snapshot = this.memory.snapshot(key);
            // A failed job listed with the summary is found without asking for details.
            return [...(snapshot?.jobs ?? []), ...(snapshot?.pipeline?.failedJobs ?? [])].find((job) => job.id === jobId);
        };
        if (!findJob()) {
            const request = new FetchRequest();
            request.add(ref, true);
            await this.fetch(request, { priority: 'user', cacheTtlMs: PANEL_CACHE_TTL_MS });
        }
        const job = findJob();
        if (!job) {
            throw new MergeRequestError('MERGE_REQUEST_JOB_NOT_FOUND', "The job is not part of this merge request's head pipeline");
        }
        if (!job.logAvailable)
            throw new MergeRequestError('MERGE_REQUEST_JOB_NOT_FOUND', 'This job has no log to show');
        try {
            return await this.options.gateway.jobLog(ref, jobId, options);
        }
        catch (error) {
            throw toServiceError(error);
        }
    }
    // ---- Read port for actions that change a merge request (merge-request-actions.ts) ----
    /** The Session asking about `ref`; throws unless the ref is linked to it or in its repository. */
    async requireVisible(sessionId, ref) {
        await this.loaded;
        const session = await this.requireSession(sessionId);
        await this.assertVisible(sessionId, session, ref);
        return session;
    }
    /** The newest snapshot held for `ref`, with details when they were read. */
    snapshotOf(ref) {
        return this.memory.snapshot(mergeRequestKey(ref));
    }
    /**
     * Reads one merge request's summary as a user action, without linking it or
     * telling any panel. Undefined when the platform says it does not exist.
     */
    async lookup(ref) {
        await this.loaded;
        const request = new FetchRequest();
        request.add(ref, false);
        const fetched = await this.fetch(request, { priority: 'user', cacheTtlMs: PANEL_CACHE_TTL_MS });
        const error = fetchError(ref, fetched);
        if (error && error.code !== 'MERGE_REQUEST_NOT_FOUND')
            throw new MergeRequestError(error.code, error.message ?? 'The merge request could not be read');
        return error ? undefined : this.snapshotOf(ref);
    }
    /** The Session and its workspace repository, read fresh. */
    async sessionRepo(sessionId) {
        const session = await this.requireSession(sessionId);
        return { session, repo: await this.resolveRepo(session.workspaceDir, true) };
    }
    /**
     * After the user changed a merge request from MCode: reads it again now, with
     * details when asked, tells every Session showing it to refresh, and returns
     * the card as this Session shows it.
     */
    async refreshAfterChange(sessionId, ref, options = {}) {
        await this.loaded;
        const session = await this.requireSession(sessionId);
        const key = mergeRequestKey(ref);
        const request = new FetchRequest();
        request.add(ref, options.details === true);
        await this.fetch(request, { priority: 'user', cacheTtlMs: 0, force: true });
        for (const id of new Set([sessionId, ...this.options.links.sessionsLinking(ref)]))
            this.options.publish(id, 'changed');
        // Changing a merge request from this Session's panel ties it to the Session, as
        // pushing to it does. A link the user removed stays removed.
        this.options.links.record({
            sessionId,
            ref,
            webUrl: this.snapshotOf(ref)?.webUrl ?? mergeRequestWebUrl(ref),
            source: 'branch',
            linkedAtMs: this.options.nowMs(),
        });
        const repo = await this.resolveRepo(session.workspaceDir, false);
        const current = repo !== undefined && this.memory.currentBranchKey(repo) === key;
        const stored = this.options.links
            .listActive([sessionId])
            .find((link) => mergeRequestKey(link.ref) === key);
        return this.view({
            ref,
            webUrl: stored?.webUrl ?? this.snapshotOf(ref)?.webUrl ?? mergeRequestWebUrl(ref),
            linkSource: current ? 'current_branch' : (stored?.source ?? 'manual'),
            removable: !current,
            ...(stored ? { linkedAtMs: stored.linkedAtMs } : {}),
        }, options.details === true ? new Set([key]) : new Set());
    }
    async link(sessionId, url) {
        await this.requireSession(sessionId);
        const ref = parseMergeRequestUrl(url);
        if (!ref) {
            throw new MergeRequestError('MERGE_REQUEST_URL_INVALID', 'Paste a GitLab merge request or GitHub pull request URL');
        }
        const request = new FetchRequest();
        request.add(ref, false);
        const fetched = await this.fetch(request, { priority: 'user', cacheTtlMs: PANEL_CACHE_TTL_MS });
        const error = fetchError(ref, fetched);
        // A typo should not leave a dead card behind; a missing CLI or a rate limit should.
        if (error?.code === 'MERGE_REQUEST_NOT_FOUND') {
            throw new MergeRequestError('MERGE_REQUEST_NOT_FOUND', error.message ?? 'The merge request was not found');
        }
        const webUrl = this.memory.snapshot(mergeRequestKey(ref))?.webUrl ?? mergeRequestWebUrl(ref);
        const nowMs = this.options.nowMs();
        if (this.options.links.link({ sessionId, ref, webUrl, linkedAtMs: nowMs }))
            this.options.publish(sessionId, 'linked');
        const stored = this.options.links
            .listActive([sessionId])
            .find((link) => mergeRequestKey(link.ref) === mergeRequestKey(ref));
        return this.view({
            ref,
            webUrl,
            linkSource: stored?.source ?? 'manual',
            removable: true,
            linkedAtMs: stored?.linkedAtMs ?? nowMs,
        }, new Set());
    }
    async unlink(sessionId, ref) {
        const session = await this.requireSession(sessionId);
        const repo = await this.resolveRepo(session.workspaceDir, false);
        if (repo && this.memory.currentBranchKey(repo) === mergeRequestKey(ref)) {
            throw new MergeRequestError('MERGE_REQUEST_LINK_NOT_REMOVABLE', "The current branch's merge request cannot be removed");
        }
        if (!this.options.links.remove(sessionId, ref, this.options.nowMs())) {
            throw new MergeRequestError('MERGE_REQUEST_NOT_LINKED', 'The merge request is not linked to this session');
        }
        this.options.publish(sessionId, 'unlinked');
    }
    /**
     * The hosts the settings page lists: every host glab / gh is logged in to, and every host
     * a Session links to, logged in or not. github.com and the hosts the CLIs only remember
     * are probed as well but stay off the list until one of the two holds, so a host nobody
     * uses does not ask the user to log in. A refresh asks the CLIs again which hosts they
     * are logged in to, so a host the user just logged in to is read in the background from
     * the next round on.
     */
    async hostingStatus(refresh) {
        const hosts = new Map([['github.com', 'github']]);
        for (const [host, platform] of await this.options.gateway.configuredHosts(refresh))
            hosts.set(host, platform);
        const linked = new Set();
        for (const { host, platform } of this.options.links.listHosts()) {
            hosts.set(host, platform);
            linked.add(host);
        }
        const statuses = await Promise.all([...hosts].map(([host, platform]) => this.options.gateway.status(platform, host, refresh)));
        return statuses.filter((status) => status.cliState === 'ready' || linked.has(status.host));
    }
    /**
     * The PostToolUse hook saw an agent command finish. Links the merge request
     * the command created, judged by the URL the CLI printed, or the merge
     * requests of the branches a `git push` moved.
     */
    async recordCommand(sessionId, command, output) {
        const ref = detectCreatedMergeRequest(command, output);
        if (ref) {
            await this.recordCreated(sessionId, ref);
            return;
        }
        const push = detectPush(command, output);
        if (push)
            await this.recordPushed(sessionId, push);
    }
    /**
     * Links a merge request an agent created, then reads its status once so list
     * icons and the TUI status line show it before the next refresh round.
     */
    async recordCreated(sessionId, ref) {
        // A subagent runs in its own Session but shares the parent's workspace, and its
        // Session has no row in the list. Record the merge request where the user looks:
        // the root Session.
        const ownerId = await this.rootSessionId(sessionId);
        const recorded = this.options.links.record({
            sessionId: ownerId,
            ref,
            webUrl: mergeRequestWebUrl(ref),
            source: 'created',
            linkedAtMs: this.options.nowMs(),
        });
        if (!recorded)
            return;
        this.options.publish(ownerId, 'recorded');
        const request = new FetchRequest();
        request.add(ref, false);
        await this.fetch(request, { priority: 'background', cacheTtlMs: PANEL_CACHE_TTL_MS });
    }
    /** Walks parentSessionId to the Session the sidebar shows; an unknown Session owns itself. */
    async rootSessionId(sessionId) {
        let current = sessionId;
        // Bounded so a corrupt parent chain cannot loop forever.
        for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
            const session = await this.options.getSession(current);
            if (!session?.parentSessionId)
                return current;
            current = session.parentSessionId;
        }
        return current;
    }
    /**
     * The merge request of a workspace branch as earlier rounds left it, for the
     * TUI status line. Never asks the platform, so polling it spends no budget.
     */
    async peekBranch(workspaceDir, branch) {
        await this.loaded;
        const repo = await this.resolveRepo(workspaceDir, false);
        const snapshot = repo ? this.memory.branchSnapshot({ ...repo, branch }) : undefined;
        if (!snapshot)
            return undefined;
        return {
            platform: snapshot.ref.platform,
            webUrl: snapshot.webUrl,
            number: snapshot.ref.number,
            status: snapshot.status,
        };
    }
    /**
     * At the end of a Turn, reads the merge request of the branch the Session's
     * directory is on, so the TUI status line and the panel's current branch card
     * have it. It links nothing: several Sessions may share the directory, so its
     * branch is not this Session's own.
     */
    async readCurrentBranch(sessionId) {
        await this.loaded;
        const session = await this.options.getSession(sessionId);
        if (!session || session.parentSessionId)
            return;
        const repo = await this.resolveRepo(session.workspaceDir, true);
        if (!repo?.branch)
            return;
        const request = new FetchRequest();
        request.addBranch(repo);
        await this.fetch(request, { priority: 'background', cacheTtlMs: TURN_END_CACHE_TTL_MS });
    }
    /**
     * After an agent pushed: links the open merge request of every branch the push
     * moved, on the remote it went to, so the Session keeps it after the branch or
     * worktree is gone. GitLab names that merge request in its reply; the other
     * branches are looked up once.
     */
    async recordPushed(sessionId, push) {
        await this.loaded;
        const platform = await this.options.gateway.platformOf(push.host);
        if (!platform)
            return;
        const ownerId = await this.rootSessionId(sessionId);
        const repos = push.branches.map((branch) => ({
            platform,
            host: push.host,
            projectPath: push.projectPath,
            branch,
        }));
        const request = new FetchRequest();
        for (const repo of repos) {
            const named = push.mergeRequests.get(repo.branch);
            if (named)
                request.add(named, false);
            else
                request.addBranch(repo);
        }
        await this.fetch(request, { priority: 'background', cacheTtlMs: PANEL_CACHE_TTL_MS });
        const recorded = repos.map((repo) => this.recordPushedBranch(ownerId, repo, push.mergeRequests.get(repo.branch)));
        if (recorded.includes(true))
            this.options.publish(ownerId, 'recorded');
    }
    /** Links one pushed branch's merge request; the one the remote named counts even unread. */
    recordPushedBranch(ownerId, repo, named) {
        const key = named ? mergeRequestKey(named) : this.memory.currentBranchKey(repo);
        const snapshot = key ? this.memory.snapshot(key) : undefined;
        const ref = snapshot?.ref ?? named;
        if (!ref)
            return false;
        return this.options.links.record({
            sessionId: ownerId,
            ref,
            webUrl: snapshot?.webUrl ?? mergeRequestWebUrl(ref),
            source: 'branch',
            linkedAtMs: this.options.nowMs(),
        });
    }
    forgetSession(sessionId) {
        this.options.links.deleteSession(sessionId);
    }
    /** Recently active Sessions among the requested ones that have merge requests linked. */
    async badgeTargets(sessionIds, now) {
        const ids = [...new Set(sessionIds)].slice(0, MAX_BADGE_SESSIONS);
        const found = await Promise.all(ids.map(async (id) => ({ id, session: await this.findSession(id) })));
        const active = found.flatMap(({ id, session }) => session && isRecentlyActive(session, now) ? [id] : []);
        const links = groupBySession(this.options.links.listActive(active));
        return active.flatMap((id) => {
            const linked = links.get(id);
            return linked ? [{ sessionId: id, links: linked }] : [];
        });
    }
    /** What list icons still need: linked merge requests the panel has not refreshed lately. */
    staleRequest(targets, now) {
        const request = new FetchRequest();
        for (const target of targets) {
            for (const link of target.links) {
                if (!this.memory.isFresh(mergeRequestKey(link.ref), now, BADGE_FRESH_MS))
                    request.add(link.ref, false);
            }
        }
        return request;
    }
    badge(target) {
        // A merge request whose status could not be read stays off the list; the
        // panel shows its card and why it could not be read.
        const views = this.views(target.links, undefined, new Set()).filter((view) => view.status !== 'unknown');
        const first = views[0];
        if (!first)
            return undefined;
        return {
            sessionId: target.sessionId,
            status: first.status,
            items: views.map((view) => ({
                ref: view.ref,
                status: view.status,
                webUrl: view.webUrl,
                ...(view.snapshot?.title ? { title: view.snapshot.title } : {}),
            })),
        };
    }
    /** A Session that cannot be read gets no list icon instead of failing the whole batch. */
    async findSession(sessionId) {
        try {
            return await this.options.getSession(sessionId);
        }
        catch {
            return undefined;
        }
    }
    async fetch(request, options) {
        const outcomes = await Promise.all(request
            .entries()
            .map(async (entry) => [
            entry.host,
            await this.options.gateway.fetch(entry.platform, entry.host, entry.queries, options),
        ]));
        for (const [, outcome] of outcomes)
            this.memory.remember(outcome);
        const fetched = new Map(outcomes);
        this.memory.recordFailures(request, fetched);
        return fetched;
    }
    /** How old the oldest data is that an answer from memory shows until the refresh lands. */
    observeServedAge(request) {
        const oldestAtMs = this.memory.oldestAtMs(request);
        if (oldestAtMs === undefined)
            return;
        observeMetric(this.options.metrics, 'merge_request_served_age_ms', this.options.nowMs() - oldestAtMs, {});
    }
    /**
     * Reads a Session's merge requests again in the background and tells its
     * panel when done. One at a time per Session, and the next only after the
     * panel's cache window, so a failing host is not asked again on every read the
     * event itself causes. Returns whether a refresh is running.
     */
    refreshInBackground(sessionId, request) {
        const key = `${sessionId}|${request.detailRefs().map(mergeRequestKey).sort().join(',')}`;
        if (this.refreshes.has(key))
            return true;
        const startedAtMs = this.options.nowMs();
        const last = this.refreshStartedAtMs.get(key);
        if (last !== undefined && ageMs(last, startedAtMs) < PANEL_CACHE_TTL_MS)
            return false;
        this.refreshStartedAtMs.set(key, startedAtMs);
        trim(this.refreshStartedAtMs);
        this.refreshes.set(key, this.runRefresh(sessionId, key, request, startedAtMs));
        return true;
    }
    async runRefresh(sessionId, key, request, startedAtMs) {
        try {
            const fetched = await this.fetch(request, {
                priority: 'background',
                cacheTtlMs: PANEL_CACHE_TTL_MS,
            });
            const failed = [...fetched.values()].some((outcome) => outcome.error !== undefined);
            observeMetric(this.options.metrics, 'merge_request_refresh_ms', this.options.nowMs() - startedAtMs, {
                outcome: failed ? 'failed' : 'ok',
            });
            this.options.publish(sessionId, 'refreshed');
        }
        catch {
            // A read that could not even start leaves the old answer; the next poll asks again.
        }
        finally {
            this.refreshes.delete(key);
        }
    }
    /**
     * Refreshes stale list icons behind the answer and tells only the Sessions
     * whose icon changed, so one round does not wake every visible row.
     */
    refreshBadgesInBackground(request, targets) {
        if (this.badgeRefresh)
            return;
        const now = this.options.nowMs();
        if (this.badgeRefreshStartedAtMs !== undefined &&
            ageMs(this.badgeRefreshStartedAtMs, now) < BADGE_FRESH_MS)
            return;
        this.badgeRefreshStartedAtMs = now;
        const before = new Map(targets.map((target) => [target.sessionId, badgeSignature(this.badge(target))]));
        this.badgeRefresh = this.runBadgeRefresh(request, targets, before);
    }
    async runBadgeRefresh(request, targets, before) {
        try {
            await this.fetch(request, { priority: 'background', cacheTtlMs: BADGE_FRESH_MS });
            for (const target of targets) {
                if (badgeSignature(this.badge(target)) !== before.get(target.sessionId))
                    this.options.publish(target.sessionId, 'refreshed');
            }
        }
        catch {
            // The icons keep their old state until the next round.
        }
        finally {
            this.badgeRefresh = undefined;
        }
    }
    /** Writes the cache file now instead of after the usual delay. */
    async flushCache() {
        await this.memory.flush();
    }
    views(links, repo, detailKeys) {
        const views = new Map();
        const currentKey = repo ? this.memory.currentBranchKey(repo) : undefined;
        const current = currentKey ? this.memory.snapshot(currentKey) : undefined;
        if (currentKey && current) {
            views.set(currentKey, this.view({
                ref: current.ref,
                webUrl: current.webUrl,
                linkSource: 'current_branch',
                removable: false,
            }, detailKeys));
        }
        for (const link of links) {
            const key = mergeRequestKey(link.ref);
            const existing = views.get(key);
            views.set(key, existing
                ? { ...existing, linkedAtMs: link.linkedAtMs }
                : this.view({
                    ref: link.ref,
                    webUrl: link.webUrl,
                    linkSource: link.source,
                    removable: true,
                    linkedAtMs: link.linkedAtMs,
                }, detailKeys));
        }
        return [...views.values()].sort((a, b) => compareForDisplay({
            status: a.status,
            linkSource: a.linkSource,
            ...(a.linkedAtMs !== undefined ? { linkedAtMs: a.linkedAtMs } : {}),
            ...(a.snapshot?.updatedAtMs !== undefined ? { updatedAtMs: a.snapshot.updatedAtMs } : {}),
        }, {
            status: b.status,
            linkSource: b.linkSource,
            ...(b.linkedAtMs !== undefined ? { linkedAtMs: b.linkedAtMs } : {}),
            ...(b.snapshot?.updatedAtMs !== undefined ? { updatedAtMs: b.snapshot.updatedAtMs } : {}),
        }));
    }
    view(card, detailKeys) {
        const key = mergeRequestKey(card.ref);
        const remembered = this.memory.entry(key);
        const snapshot = cardSnapshot(remembered, detailKeys.has(key));
        const error = this.memory.failure(key);
        return {
            ref: snapshot?.ref ?? card.ref,
            webUrl: snapshot?.webUrl ?? card.webUrl,
            linkSource: card.linkSource,
            removable: card.removable,
            status: snapshot?.status ?? 'unknown',
            ...(card.linkedAtMs !== undefined ? { linkedAtMs: card.linkedAtMs } : {}),
            ...(remembered ? { fetchedAtMs: remembered.atMs } : {}),
            ...(error ? { error } : {}),
            ...(snapshot ? { snapshot } : {}),
        };
    }
    async assertVisible(sessionId, session, ref) {
        const key = mergeRequestKey(ref);
        if (this.options.links.listActive([sessionId]).some((link) => mergeRequestKey(link.ref) === key))
            return;
        const repo = await this.resolveRepo(session.workspaceDir, false);
        if (repo && sameProject(ref, repo))
            return;
        throw new MergeRequestError('MERGE_REQUEST_NOT_LINKED', 'The merge request is not linked to this session');
    }
    async hostStatuses(hosts) {
        return Promise.all([...hosts].map(([host, platform]) => this.options.gateway.status(platform, host)));
    }
    async requireSession(sessionId) {
        const session = await this.options.getSession(sessionId);
        if (!session)
            throw new MergeRequestError('MERGE_REQUEST_SESSION_NOT_FOUND', 'Session not found');
        return session;
    }
    resolveRepo(workspaceDir, fresh) {
        const now = this.options.nowMs();
        const cached = this.workspaces.get(workspaceDir);
        if (!fresh && cached && now - cached.atMs < WORKSPACE_TTL_MS)
            return cached.repo;
        const repo = this.readRepo(workspaceDir);
        this.workspaces.delete(workspaceDir);
        this.workspaces.set(workspaceDir, { atMs: now, repo });
        trim(this.workspaces);
        return repo;
    }
    async readRepo(workspaceDir) {
        let remote;
        try {
            remote = await this.options.readWorkspace(workspaceDir);
        }
        catch {
            return undefined;
        }
        if (!remote)
            return undefined;
        const platform = await this.options.gateway.platformOf(remote.host);
        if (!platform)
            return undefined;
        return {
            platform,
            host: remote.host,
            projectPath: remote.projectPath,
            ...(remote.branch ? { branch: remote.branch } : {}),
            ...(remote.headSha ? { headSha: remote.headSha } : {}),
            ...(remote.defaultBranch ? { defaultBranch: remote.defaultBranch } : {}),
        };
    }
    refreshMs() {
        return this.options.limits().refreshIntervalSec * 1_000;
    }
}
/** What a list icon shows, to tell whether a refresh changed it. */
function badgeSignature(badge) {
    if (!badge)
        return '';
    return [
        badge.status,
        ...badge.items.map((item) => `${mergeRequestKey(item.ref)}:${item.status}:${item.title ?? ''}`),
    ].join('|');
}
function groupBySession(links) {
    const grouped = new Map();
    for (const link of links) {
        const list = grouped.get(link.sessionId) ?? [];
        list.push(link);
        grouped.set(link.sessionId, list);
    }
    return grouped;
}
function isRecentlyActive(session, now) {
    return session.updatedAtMs === undefined || now - session.updatedAtMs < INACTIVE_SESSION_MS;
}
/** Jobs, threads and the rest of the details travel only with the cards the client expanded. */
function cardSnapshot(remembered, expanded) {
    if (!remembered)
        return undefined;
    return expanded ? remembered.snapshot : summaryOnly(remembered.snapshot);
}
//# sourceMappingURL=merge-request.service.js.map