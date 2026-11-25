import { settleInBackground } from '../../infra/async/settle.js';
import { mergeRequestKey, parseMergeRequestUrl, projectKey } from './code-host/urls.js';
import { MergeRequestError, } from './contracts.js';
import { COMMIT_LIST_LIMIT, fillFromCommits, toMergeRequestCommit, } from './local-git/branch-info.js';
import { toActionError } from './snapshots/fetch-errors.js';
/** A push moves the head and so the key; the window only spares re-reading one head. */
const CHANGES_TTL_MS = 120_000;
const REVIEWERS_TTL_MS = 5 * 60_000;
const PROJECT_DEFAULTS_TTL_MS = 10 * 60_000;
const SUGGESTIONS_TTL_MS = 2 * 60_000;
const SEARCH_TTL_MS = 60_000;
/** `group/project!12` or `owner/repo#12`. */
const PROJECT_REFERENCE = /^([^\s!#/]+(?:\/[^\s!#/]+)+)([!#])(\d+)$/u;
const REASON_ORDER = {
    exact: 0,
    mine_in_repository: 1,
    mine: 2,
    review_requested: 3,
    in_repository: 4,
    search: 5,
};
/** A merge request still waiting to merge keeps its worktree; the panel offers the cleanup later. */
function notMergedYet(message) {
    return { worktreeRemoved: false, branchDeleted: false, issues: [{ blocker: 'other', message }] };
}
/**
 * What the user does to a merge request from MCode: merge, edit, comment,
 * rerun jobs, create one, and remove the Session's worktree after a merge.
 * Every request runs as a user action through the gateway; a change then reads
 * the merge request again so every panel showing it catches up.
 */
export class MergeRequestActionsService {
    options;
    constructor(options) {
        this.options = options;
    }
    async changes(sessionId, ref) {
        await this.options.reads.requireVisible(sessionId, ref);
        const head = this.options.reads.snapshotOf(ref)?.headSha ?? 'unknown';
        return this.act(ref, `changes:${mergeRequestKey(ref)}@${head}`, (adapter, call) => adapter.changes(ref, call), { cacheTtlMs: CHANGES_TTL_MS });
    }
    async mergeOptions(sessionId, ref) {
        const session = await this.options.reads.requireVisible(sessionId, ref);
        const snapshot = await this.snapshot(ref);
        const [platform, prepared] = await Promise.all([
            this.act(ref, `merge-options:${mergeRequestKey(ref)}`, (adapter, call) => adapter.mergeOptions(ref, snapshot, call)),
            this.options.worktrees.prepare(cleanupTarget(sessionId, session, snapshot)),
        ]);
        return {
            ...platform,
            defaultMethod: this.defaultMethod(ref, platform),
            cleanup: prepared.plan,
        };
    }
    async merge(sessionId, ref, input) {
        const session = await this.options.reads.requireVisible(sessionId, ref);
        const snapshot = await this.snapshot(ref);
        const merge = {
            expectedHeadSha: input.expectedHeadSha,
            ...(input.method ? { method: input.method } : {}),
            ...(input.deleteSourceBranch !== undefined
                ? { deleteSourceBranch: input.deleteSourceBranch }
                : {}),
        };
        let outcome;
        try {
            outcome = await this.options.gateway.act(ref, `merge:${mergeRequestKey(ref)}`, (adapter, call) => adapter.merge(ref, merge, snapshot, call));
        }
        catch (error) {
            const failure = toActionError(error);
            // The card shows the new head before the client asks the user to confirm again.
            if (failure.code === 'MERGE_REQUEST_HEAD_CHANGED')
                await this.refreshQuietly(sessionId, ref);
            throw failure;
        }
        const view = await this.options.reads.refreshAfterChange(sessionId, ref);
        if (!input.cleanupWorktree)
            return { view, queued: outcome.queued };
        return {
            view,
            queued: outcome.queued,
            cleanup: await this.cleanupAfterMerge(sessionId, session, view, input.expectedHeadSha),
        };
    }
    async cleanupPlan(sessionId, ref) {
        const session = await this.options.reads.requireVisible(sessionId, ref);
        const snapshot = await this.snapshot(ref);
        return (await this.options.worktrees.prepare(cleanupTarget(sessionId, session, snapshot))).plan;
    }
    /** For a merge request merged elsewhere, such as on the web; the Session is kept. */
    async cleanup(sessionId, ref) {
        const session = await this.options.reads.requireVisible(sessionId, ref);
        const snapshot = await this.mergedSnapshot(sessionId, ref);
        const prepared = await this.options.worktrees.prepare(cleanupTarget(sessionId, session, snapshot));
        if (!prepared.plan.available) {
            throw new MergeRequestError('MERGE_REQUEST_CLEANUP_BLOCKED', describeIssues(prepared.plan.issues));
        }
        return this.options.worktrees.remove(prepared);
    }
    /** An empty list reruns every failed job of the head pipeline. */
    async retry(sessionId, ref, jobIds) {
        await this.options.reads.requireVisible(sessionId, ref);
        const snapshot = await this.snapshot(ref);
        await this.act(ref, `retry:${mergeRequestKey(ref)}`, (adapter, call) => adapter.retry(ref, jobIds, snapshot, call));
        return this.options.reads.refreshAfterChange(sessionId, ref, { details: true });
    }
    async reply(sessionId, ref, discussionId, body) {
        await this.options.reads.requireVisible(sessionId, ref);
        const discussion = await this.act(ref, `reply:${mergeRequestKey(ref)}`, (adapter, call) => adapter.reply(ref, discussionId, body, call));
        this.refreshInBackground(sessionId, ref);
        return discussion;
    }
    async resolve(sessionId, ref, discussionId, resolved) {
        await this.options.reads.requireVisible(sessionId, ref);
        const discussion = await this.act(ref, `resolve:${mergeRequestKey(ref)}`, (adapter, call) => adapter.resolve(ref, discussionId, resolved, call));
        this.refreshInBackground(sessionId, ref);
        return discussion;
    }
    async comment(sessionId, ref, body) {
        await this.options.reads.requireVisible(sessionId, ref);
        const discussion = await this.act(ref, `comment:${mergeRequestKey(ref)}`, (adapter, call) => adapter.comment(ref, body, call));
        this.refreshInBackground(sessionId, ref);
        return discussion;
    }
    async update(sessionId, ref, change) {
        await this.options.reads.requireVisible(sessionId, ref);
        const snapshot = await this.snapshot(ref);
        await this.act(ref, `update:${mergeRequestKey(ref)}`, (adapter, call) => adapter.update(ref, change, snapshot, call));
        return this.options.reads.refreshAfterChange(sessionId, ref, { details: true });
    }
    async searchReviewers(sessionId, ref, query) {
        await this.options.reads.requireVisible(sessionId, ref);
        const text = query.trim();
        return this.act(ref, `reviewers:${projectKey(ref.platform, ref.host, ref.projectPath)}:${text.toLowerCase()}`, (adapter, call) => adapter.searchReviewers(ref, text, call), { cacheTtlMs: REVIEWERS_TTL_MS });
    }
    async createDefaults(sessionId) {
        const { session, repo } = await this.options.reads.sessionRepo(sessionId);
        const { repository, branch } = requireBranch(repo);
        if (branch === repository.defaultBranch)
            throw onDefaultBranch();
        const project = await this.projectDefaultsIfNeeded(repository);
        const targetBranch = repository.defaultBranch ?? project?.defaultBranch;
        if (!targetBranch) {
            throw new MergeRequestError('MERGE_REQUEST_REQUEST_INVALID', "The repository's default branch is unknown");
        }
        if (branch === targetBranch)
            throw onDefaultBranch();
        const local = await this.options.branches.read(session.workspaceDir, branch, targetBranch);
        const filled = fillFromCommits(branch, local.commits);
        return {
            repo: repository,
            targetBranch,
            title: filled.title,
            ...(filled.description ? { description: filled.description } : {}),
            draft: this.options.preferences().createAsDraft,
            ...gitlabCreateSettings(repository, project),
            needsPush: local.needsPush,
            ...(local.commits.length > 0
                ? { commits: local.commits.slice(0, COMMIT_LIST_LIMIT).map(toMergeRequestCommit) }
                : {}),
        };
    }
    /** Pushes the branch first when the remote lacks some of it, then opens the merge request. */
    async create(sessionId, request) {
        const { session, repo } = await this.options.reads.sessionRepo(sessionId);
        const { repository, branch } = requireBranch(repo);
        if (branch === request.targetBranch) {
            throw new MergeRequestError('MERGE_REQUEST_REQUEST_INVALID', 'The source and target branches are the same');
        }
        if (await this.options.branches.needsPush(session.workspaceDir, branch)) {
            await this.options.branches.push(session.workspaceDir, branch);
        }
        const gitlab = repository.platform === 'gitlab';
        const input = {
            sourceBranch: branch,
            targetBranch: request.targetBranch,
            title: request.title,
            ...(request.description ? { description: request.description } : {}),
            draft: request.draft ?? this.options.preferences().createAsDraft,
            ...(gitlab && request.squash !== undefined ? { squash: request.squash } : {}),
            ...(gitlab && request.deleteSourceBranch !== undefined
                ? { deleteSourceBranch: request.deleteSourceBranch }
                : {}),
        };
        const created = await this.act(repository, `create:${projectKey(repository.platform, repository.host, repository.projectPath)}:${branch}`, (adapter, call) => adapter.create(repository.host, repository.projectPath, input, call));
        await this.options.reads.recordCreated(sessionId, created.ref);
        return this.options.reads.refreshAfterChange(sessionId, created.ref);
    }
    /**
     * Merge requests to offer in the link picker: suggestions for an empty query,
     * the one a number or link names, or title matches for words. Looks in the
     * Session's repository, else on the hosts of the merge requests it links.
     */
    async linkCandidates(sessionId, query) {
        const { repo } = await this.options.reads.sessionRepo(sessionId);
        const links = this.options.links.listActive([sessionId]);
        const areas = candidateAreas(repo, links);
        if (areas.length === 0)
            return [];
        const parsed = parseCandidateQuery(query.trim(), repo, areas);
        let found;
        if (parsed.kind === 'none')
            return [];
        if (parsed.kind === 'ref') {
            const snapshot = await this.options.reads.lookup(parsed.ref);
            found = snapshot ? [candidateOf(snapshot, 'exact')] : [];
        }
        else if (parsed.kind === 'words') {
            found = await this.collect(areas, (area) => this.search(area, parsed.words));
        }
        else {
            found = await this.collect(areas, (area) => this.suggestions(area));
        }
        const shown = new Set(links.map((link) => mergeRequestKey(link.ref)));
        return rank(found).map((candidate) => isShown(candidate, shown, repo) ? { ...candidate, linked: true } : candidate);
    }
    suggestions(area) {
        return this.act(area, `suggestions:${areaKey(area)}`, (adapter, call) => adapter.suggestions(adapterScope(area), call), { cacheTtlMs: SUGGESTIONS_TTL_MS });
    }
    search(area, words) {
        return this.act(area, `search:${areaKey(area)}:${words.toLowerCase()}`, (adapter, call) => adapter.search(adapterScope(area), words, call), { cacheTtlMs: SEARCH_TTL_MS });
    }
    /** One host answering is enough; only a search every host failed is an error. */
    async collect(areas, read) {
        const settled = await Promise.allSettled(areas.map(read));
        const found = settled.flatMap((outcome) => outcome.status === 'fulfilled' ? [...outcome.value] : []);
        const failure = settled.find((outcome) => outcome.status === 'rejected');
        if (failure && settled.every((outcome) => outcome.status === 'rejected')) {
            throw toActionError(failure.reason);
        }
        return found;
    }
    /** GitLab's create settings; GitHub needs the platform only when the clone never recorded the default branch. */
    async projectDefaultsIfNeeded(repo) {
        if (repo.platform === 'github' && repo.defaultBranch)
            return undefined;
        return this.projectDefaults(repo);
    }
    projectDefaults(repo) {
        return this.act(repo, `project-defaults:${projectKey(repo.platform, repo.host, repo.projectPath)}`, (adapter, call) => adapter.projectDefaults(repo.host, repo.projectPath, call), { cacheTtlMs: PROJECT_DEFAULTS_TTL_MS });
    }
    defaultMethod(ref, options) {
        if (ref.platform !== 'github')
            return options.defaultMethod;
        const preferred = this.options.preferences().githubMergeMethod;
        return options.methods.includes(preferred) ? preferred : options.defaultMethod;
    }
    /**
     * Removes the worktree only once the platform reports the merge request merged:
     * a queued or still-processing merge keeps it, so nothing goes before the merge does.
     */
    async cleanupAfterMerge(sessionId, session, view, mergedHead) {
        if (view.snapshot?.state !== 'merged') {
            return notMergedYet('The merge request has not merged yet; remove the worktree once it has merged');
        }
        return this.removeWorktree(cleanupTarget(sessionId, session, view.snapshot, mergedHead));
    }
    async removeWorktree(target) {
        const prepared = await this.options.worktrees.prepare(target);
        if (!prepared.plan.available) {
            return { worktreeRemoved: false, branchDeleted: false, issues: prepared.plan.issues };
        }
        return this.options.worktrees.remove(prepared);
    }
    /** The merge request as merged; a remembered open one is read again, as it may have merged on the web. */
    async mergedSnapshot(sessionId, ref) {
        const known = this.options.reads.snapshotOf(ref);
        if (known?.state === 'merged')
            return known;
        const view = await this.options.reads.refreshAfterChange(sessionId, ref);
        if (view.snapshot?.state === 'merged')
            return view.snapshot;
        if (view.error) {
            throw new MergeRequestError(view.error.code, view.error.message ?? 'The merge request could not be read');
        }
        throw new MergeRequestError('MERGE_REQUEST_CLEANUP_BLOCKED', 'The merge request is not merged yet');
    }
    /** The newest snapshot held for `ref`, read now when there is none. */
    async snapshot(ref) {
        const snapshot = this.options.reads.snapshotOf(ref) ?? (await this.options.reads.lookup(ref));
        if (!snapshot) {
            throw new MergeRequestError('MERGE_REQUEST_NOT_FOUND', 'The merge request does not exist or this account cannot see it');
        }
        return snapshot;
    }
    refreshInBackground(sessionId, ref) {
        settleInBackground(this.refreshQuietly(sessionId, ref, { details: true }));
    }
    async refreshQuietly(sessionId, ref, options = {}) {
        try {
            await this.options.reads.refreshAfterChange(sessionId, ref, options);
        }
        catch (error) {
            this.options.onBackgroundError(error, ref);
        }
    }
    async act(at, label, work, options) {
        try {
            return await this.options.gateway.act(at, label, work, options);
        }
        catch (error) {
            throw toActionError(error);
        }
    }
}
function cleanupTarget(sessionId, session, snapshot, headSha = snapshot.headSha) {
    return {
        sessionId,
        workspaceDir: session.workspaceDir,
        ...(snapshot.sourceBranch ? { branch: snapshot.sourceBranch } : {}),
        ...(headSha ? { headSha } : {}),
    };
}
function requireBranch(repo) {
    if (!repo) {
        throw new MergeRequestError('MERGE_REQUEST_REQUEST_INVALID', "The Session's workspace is not a GitLab or GitHub repository");
    }
    if (!repo.branch) {
        throw new MergeRequestError('MERGE_REQUEST_REQUEST_INVALID', 'Check out a branch to create a merge request from');
    }
    return { repository: repo, branch: repo.branch };
}
/** GitLab's squash and branch deletion defaults; GitHub picks both at merge time. */
function gitlabCreateSettings(repo, project) {
    if (repo.platform !== 'gitlab' || !project)
        return {};
    return {
        ...(project.squash !== undefined ? { squash: project.squash } : {}),
        ...(project.deleteSourceBranch !== undefined
            ? { deleteSourceBranch: project.deleteSourceBranch }
            : {}),
    };
}
function onDefaultBranch() {
    return new MergeRequestError('MERGE_REQUEST_REQUEST_INVALID', 'The current branch is the default branch; check out a feature branch first');
}
const ISSUE_TEXT = {
    uncommitted_changes: (count) => `${String(count)} uncommitted file(s)`,
    unpushed_commits: (count) => `${String(count)} commit(s) the merge request lacks`,
    other_sessions: (count) => `${String(count)} other Session(s) work in it`,
    session_running: () => 'the Session is running',
    main_checkout: () => 'it is the main checkout',
    branch_not_checked_out: () => "the merge request's branch is not checked out",
    other: () => 'git refused',
};
function describeIssues(issues) {
    const reasons = issues.map((issue) => issue.message ?? ISSUE_TEXT[issue.blocker](issue.count ?? 0));
    return `The worktree cannot be removed: ${reasons.join('; ')}`;
}
function candidateAreas(repo, links) {
    if (repo)
        return [{ platform: repo.platform, host: repo.host, projectPath: repo.projectPath }];
    const hosts = new Map();
    for (const link of links)
        hosts.set(link.ref.host, link.ref.platform);
    return [...hosts].map(([host, platform]) => ({ platform, host }));
}
/**
 * Nothing asks for suggestions; a number (123, !123, #123), a link,
 * `group/project!12` or `owner/repo#12` names one merge request; anything else
 * is words to match against titles.
 */
function parseCandidateQuery(text, repo, areas) {
    if (!text)
        return { kind: 'suggestions' };
    const number = /^[!#]?(\d+)$/u.exec(text);
    if (number)
        return numberQuery(Number(number[1]), repo);
    const linked = parseMergeRequestUrl(text);
    if (linked)
        return { kind: 'ref', ref: linked };
    const reference = PROJECT_REFERENCE.exec(text);
    return reference ? referenceQuery(reference, areas) : { kind: 'words', words: text };
}
/** A bare number names a merge request in the Session's repository. */
function numberQuery(value, repo) {
    if (!repo || !isPositiveNumber(value))
        return { kind: 'none' };
    return {
        kind: 'ref',
        ref: { platform: repo.platform, host: repo.host, projectPath: repo.projectPath, number: value },
    };
}
/** GitLab writes `group/project!12` and GitHub `owner/repo#12`; the host comes from where the Session looks. */
function referenceQuery(match, areas) {
    const platform = match[2] === '!' ? 'gitlab' : 'github';
    const host = areas.find((area) => area.platform === platform)?.host ??
        (platform === 'github' ? 'github.com' : undefined);
    const value = Number(match[3]);
    if (!host || !isPositiveNumber(value))
        return { kind: 'none' };
    return { kind: 'ref', ref: { platform, host, projectPath: match[1] ?? '', number: value } };
}
function isPositiveNumber(value) {
    return Number.isSafeInteger(value) && value > 0;
}
function areaKey(area) {
    return `${area.host}/${area.projectPath?.toLowerCase() ?? ''}`;
}
function adapterScope(area) {
    return { host: area.host, ...(area.projectPath ? { projectPath: area.projectPath } : {}) };
}
function candidateOf(snapshot, reason) {
    return {
        ref: snapshot.ref,
        webUrl: snapshot.webUrl,
        reason,
        title: snapshot.title,
        state: snapshot.state,
        draft: snapshot.draft,
        ...(snapshot.authorLogin ? { authorLogin: snapshot.authorLogin } : {}),
        ...(snapshot.sourceBranch ? { sourceBranch: snapshot.sourceBranch } : {}),
        ...(snapshot.targetBranch ? { targetBranch: snapshot.targetBranch } : {}),
        ...(snapshot.updatedAtMs !== undefined ? { updatedAtMs: snapshot.updatedAtMs } : {}),
    };
}
/** By reason, then most recently updated; a merge request found twice keeps its best reason. */
function rank(candidates) {
    const sorted = [...candidates].sort((a, b) => REASON_ORDER[a.reason] - REASON_ORDER[b.reason] ||
        (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0));
    const seen = new Set();
    return sorted.filter((candidate) => {
        const key = mergeRequestKey(candidate.ref);
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
/** Linked to the Session, or the current branch's open merge request, which the panel shows unlinked. */
function isShown(candidate, linked, repo) {
    if (linked.has(mergeRequestKey(candidate.ref)))
        return true;
    return (repo?.branch !== undefined &&
        candidate.state === 'open' &&
        candidate.sourceBranch === repo.branch &&
        projectKey(candidate.ref.platform, candidate.ref.host, candidate.ref.projectPath) ===
            projectKey(repo.platform, repo.host, repo.projectPath));
}
//# sourceMappingURL=merge-request-actions.service.js.map