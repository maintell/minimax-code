import { CodeHostCliState, CodeHostPlatform, MergeRequestBlocker, MergeRequestCandidateReason, MergeRequestCheckStatus, MergeRequestCleanupBlocker, MergeRequestFileChangeKind, MergeRequestLinkSource, MergeRequestMergeMethod, MergeRequestReviewState, MergeRequestState, MergeRequestStateEvent, MergeRequestStatus, } from '@mavis/thrift-gen/generated/desktop-service/types';
import { MergeRequestError, } from '../../service/merge-request/index.js';
import { AppError } from '../errors.js';
import { MergeRequestControllerBase } from '../generated/merge-request-controller-base.gen.js';
const PLATFORMS = { gitlab: CodeHostPlatform.GITLAB, github: CodeHostPlatform.GITHUB };
const PLATFORM_NAMES = new Map([
    [CodeHostPlatform.GITLAB, 'gitlab'],
    [CodeHostPlatform.GITHUB, 'github'],
]);
const LINK_SOURCES = {
    current_branch: MergeRequestLinkSource.CURRENT_BRANCH,
    branch: MergeRequestLinkSource.BRANCH,
    created: MergeRequestLinkSource.CREATED,
    manual: MergeRequestLinkSource.MANUAL,
};
const STATES = {
    open: MergeRequestState.OPEN,
    merged: MergeRequestState.MERGED,
    closed: MergeRequestState.CLOSED,
};
const STATUSES = {
    unknown: MergeRequestStatus.MERGE_REQUEST_STATUS_UNSPECIFIED,
    ready_to_merge: MergeRequestStatus.READY_TO_MERGE,
    pipeline_failed: MergeRequestStatus.PIPELINE_FAILED,
    conflict: MergeRequestStatus.CONFLICT,
    changes_requested: MergeRequestStatus.CHANGES_REQUESTED,
    unresolved_discussions: MergeRequestStatus.UNRESOLVED_DISCUSSIONS,
    pipeline_running: MergeRequestStatus.PIPELINE_RUNNING,
    waiting_for_approval: MergeRequestStatus.WAITING_FOR_APPROVAL,
    draft: MergeRequestStatus.DRAFT,
    blocked: MergeRequestStatus.BLOCKED,
    merged: MergeRequestStatus.MERGED,
    closed: MergeRequestStatus.CLOSED,
};
const BLOCKERS = {
    draft: MergeRequestBlocker.DRAFT,
    pipeline_failed: MergeRequestBlocker.PIPELINE_FAILED,
    pipeline_running: MergeRequestBlocker.PIPELINE_RUNNING,
    discussions_unresolved: MergeRequestBlocker.DISCUSSIONS_UNRESOLVED,
    approval_required: MergeRequestBlocker.APPROVAL_REQUIRED,
    changes_requested: MergeRequestBlocker.CHANGES_REQUESTED,
    conflict: MergeRequestBlocker.CONFLICT,
    need_rebase: MergeRequestBlocker.NEED_REBASE,
    checking: MergeRequestBlocker.CHECKING,
    other: MergeRequestBlocker.OTHER,
};
const CHECKS = {
    unknown: MergeRequestCheckStatus.MERGE_REQUEST_CHECK_STATUS_UNSPECIFIED,
    pending: MergeRequestCheckStatus.PENDING,
    running: MergeRequestCheckStatus.RUNNING,
    success: MergeRequestCheckStatus.SUCCESS,
    failed: MergeRequestCheckStatus.FAILED,
    canceled: MergeRequestCheckStatus.CANCELED,
    skipped: MergeRequestCheckStatus.SKIPPED,
    manual: MergeRequestCheckStatus.MANUAL,
};
const CLI_STATES = {
    ready: CodeHostCliState.READY,
    not_installed: CodeHostCliState.NOT_INSTALLED,
    not_authenticated: CodeHostCliState.NOT_AUTHENTICATED,
    unavailable: CodeHostCliState.UNAVAILABLE,
};
const REVIEW_STATES = {
    requested: MergeRequestReviewState.REQUESTED,
    approved: MergeRequestReviewState.APPROVED,
    changes_requested: MergeRequestReviewState.CHANGES_REQUESTED,
    commented: MergeRequestReviewState.COMMENTED,
};
const MERGE_METHODS = {
    merge: MergeRequestMergeMethod.MERGE,
    squash: MergeRequestMergeMethod.SQUASH,
    rebase: MergeRequestMergeMethod.REBASE,
    fast_forward: MergeRequestMergeMethod.FAST_FORWARD,
};
const MERGE_METHOD_NAMES = new Map(Object.entries(MERGE_METHODS).map(([name, value]) => [value, name]));
const STATE_EVENT_NAMES = new Map([
    [MergeRequestStateEvent.CLOSE, 'close'],
    [MergeRequestStateEvent.REOPEN, 'reopen'],
]);
const FILE_CHANGE_KINDS = {
    added: MergeRequestFileChangeKind.ADDED,
    modified: MergeRequestFileChangeKind.MODIFIED,
    deleted: MergeRequestFileChangeKind.DELETED,
    renamed: MergeRequestFileChangeKind.RENAMED,
};
const CLEANUP_BLOCKERS = {
    uncommitted_changes: MergeRequestCleanupBlocker.UNCOMMITTED_CHANGES,
    unpushed_commits: MergeRequestCleanupBlocker.UNPUSHED_COMMITS,
    other_sessions: MergeRequestCleanupBlocker.OTHER_SESSIONS,
    session_running: MergeRequestCleanupBlocker.SESSION_RUNNING,
    main_checkout: MergeRequestCleanupBlocker.MAIN_CHECKOUT,
    branch_not_checked_out: MergeRequestCleanupBlocker.BRANCH_NOT_CHECKED_OUT,
    other: MergeRequestCleanupBlocker.OTHER,
};
const CANDIDATE_REASONS = {
    exact: MergeRequestCandidateReason.EXACT,
    mine_in_repository: MergeRequestCandidateReason.MINE_IN_REPOSITORY,
    mine: MergeRequestCandidateReason.MINE,
    review_requested: MergeRequestCandidateReason.REVIEW_REQUESTED,
    in_repository: MergeRequestCandidateReason.IN_REPOSITORY,
    search: MergeRequestCandidateReason.SEARCH,
};
const ERROR_STATUS = {
    MERGE_REQUEST_SESSION_NOT_FOUND: 404,
    MERGE_REQUEST_URL_INVALID: 400,
    MERGE_REQUEST_NOT_LINKED: 404,
    MERGE_REQUEST_LINK_NOT_REMOVABLE: 409,
    MERGE_REQUEST_JOB_NOT_FOUND: 404,
    MERGE_REQUEST_NOT_FOUND: 404,
    MERGE_REQUEST_CLI_UNAVAILABLE: 424,
    MERGE_REQUEST_RATE_LIMITED: 429,
    MERGE_REQUEST_UPSTREAM_FAILED: 502,
    MERGE_REQUEST_REQUEST_INVALID: 400,
    MERGE_REQUEST_FORBIDDEN: 403,
    MERGE_REQUEST_HEAD_CHANGED: 409,
    MERGE_REQUEST_NOT_MERGEABLE: 409,
    MERGE_REQUEST_CANNOT_RETRY: 409,
    MERGE_REQUEST_CLEANUP_BLOCKED: 409,
    MERGE_REQUEST_ALREADY_EXISTS: 409,
    MERGE_REQUEST_PUSH_FAILED: 502,
};
const RETRYABLE = new Set([
    'MERGE_REQUEST_RATE_LIMITED',
    'MERGE_REQUEST_UPSTREAM_FAILED',
]);
/**
 * The longest text any platform takes: GitLab caps a description at 1 MB
 * (1,048,576 characters). A lower cap, such as GitHub's 65,536 characters for a
 * body, is the platform's to refuse in its own words.
 */
const MAX_TEXT_CHARS = 1_048_576;
/** Search boxes: a link is the longest thing anyone types there. */
const MAX_QUERY_LENGTH = 2_048;
const MAX_LIST_ITEMS = 100;
export class MergeRequestController extends MergeRequestControllerBase {
    service;
    actions;
    constructor(service, actions) {
        super();
        this.service = service;
        this.actions = actions;
    }
    async listSessionMergeRequests(_ctx, req) {
        const result = await invoke(() => this.service.listSession(requireText(req.sessionId, 'sessionId'), {
            ...(req.detailRefs ? { detailRefs: req.detailRefs.map(fromWireRef) } : {}),
            ...(req.forceRefresh ? { forceRefresh: true } : {}),
        }));
        return {
            mergeRequests: result.mergeRequests.map(toWireView),
            hosts: result.hosts.map(toWireHost),
            ...(result.repo ? { repo: toWireRepo(result.repo) } : {}),
            pollAfterMs: result.pollAfterMs,
            ...(result.refreshing ? { refreshing: true } : {}),
        };
    }
    async batchGetSessionMergeRequestBadges(_ctx, req) {
        if (!Array.isArray(req.sessionIds)) {
            throw new AppError(400, 'MERGE_REQUEST_REQUEST_INVALID', 'sessionIds must be a list');
        }
        const result = await invoke(() => this.service.badges(req.sessionIds.filter(isText)));
        return {
            badges: result.badges.map((badge) => ({
                sessionId: badge.sessionId,
                status: STATUSES[badge.status],
                items: badge.items.map((item) => ({
                    ref: toWireRef(item.ref),
                    status: STATUSES[item.status],
                    webUrl: item.webUrl,
                    ...(item.title ? { title: item.title } : {}),
                })),
            })),
            pollAfterMs: result.pollAfterMs,
        };
    }
    async getMergeRequestJobLog(_ctx, req) {
        const log = await invoke(() => this.service.jobLog(requireText(req.sessionId, 'sessionId'), fromWireRef(req.ref), requireText(req.jobId, 'jobId'), req.full === true ? { full: true } : {}));
        return {
            text: log.text,
            truncated: log.truncated,
            ...(log.webUrl ? { webUrl: log.webUrl } : {}),
        };
    }
    async linkSessionMergeRequest(_ctx, req) {
        const view = await invoke(() => this.service.link(requireText(req.sessionId, 'sessionId'), requireText(req.url, 'url')));
        return { mergeRequest: toWireView(view) };
    }
    async unlinkSessionMergeRequest(_ctx, req) {
        await invoke(() => this.service.unlink(requireText(req.sessionId, 'sessionId'), fromWireRef(req.ref)));
        return {};
    }
    async getCodeHostingStatus(_ctx, req) {
        const hosts = await invoke(() => this.service.hostingStatus(req.refresh === true));
        return { hosts: hosts.map(toWireHost) };
    }
    async getMergeRequestChanges(_ctx, req) {
        const sessionId = requireText(req.sessionId, 'sessionId');
        const ref = fromWireRef(req.ref);
        const changes = await invoke(() => this.actions.changes(sessionId, ref));
        return {
            files: changes.files.map(toWireFileChange),
            truncated: changes.truncated,
            ...(changes.headSha ? { headSha: changes.headSha } : {}),
        };
    }
    async getMergeRequestMergeOptions(_ctx, req) {
        const sessionId = requireText(req.sessionId, 'sessionId');
        const ref = fromWireRef(req.ref);
        const options = await invoke(() => this.actions.mergeOptions(sessionId, ref));
        return {
            headSha: options.headSha,
            methods: options.methods.map((method) => MERGE_METHODS[method]),
            defaultMethod: MERGE_METHODS[options.defaultMethod],
            methodLocked: options.methodLocked,
            deleteSourceBranch: options.deleteSourceBranch,
            deleteSourceBranchLocked: options.deleteSourceBranchLocked,
            mergeQueue: options.mergeQueue,
            cleanup: toWireCleanupPlan(options.cleanup),
            blockers: options.blockers.map((blocker) => BLOCKERS[blocker]),
        };
    }
    async mergeMergeRequest(_ctx, req) {
        const sessionId = requireText(req.sessionId, 'sessionId');
        const ref = fromWireRef(req.ref);
        const expectedHeadSha = requireText(req.expectedHeadSha, 'expectedHeadSha').trim();
        const method = fromWireMergeMethod(req.method);
        const deleteSourceBranch = optionalBoolean(req.deleteSourceBranch, 'deleteSourceBranch');
        const cleanupWorktree = optionalBoolean(req.cleanupWorktree, 'cleanupWorktree');
        const result = await invoke(() => this.actions.merge(sessionId, ref, {
            expectedHeadSha,
            ...(method ? { method } : {}),
            ...(deleteSourceBranch !== undefined ? { deleteSourceBranch } : {}),
            ...(cleanupWorktree ? { cleanupWorktree } : {}),
        }));
        return {
            mergeRequest: toWireView(result.view),
            queued: result.queued,
            ...(result.cleanup ? { cleanup: toWireCleanupResult(result.cleanup) } : {}),
        };
    }
    async getMergeRequestCleanupPlan(_ctx, req) {
        const sessionId = requireText(req.sessionId, 'sessionId');
        const ref = fromWireRef(req.ref);
        const plan = await invoke(() => this.actions.cleanupPlan(sessionId, ref));
        return { plan: toWireCleanupPlan(plan) };
    }
    async cleanupMergeRequestWorktree(_ctx, req) {
        const sessionId = requireText(req.sessionId, 'sessionId');
        const ref = fromWireRef(req.ref);
        const cleanup = await invoke(() => this.actions.cleanup(sessionId, ref));
        return { cleanup: toWireCleanupResult(cleanup) };
    }
    async retryMergeRequestPipeline(_ctx, req) {
        const sessionId = requireText(req.sessionId, 'sessionId');
        const ref = fromWireRef(req.ref);
        const jobIds = textList(req.jobIds, 'jobIds') ?? [];
        const view = await invoke(() => this.actions.retry(sessionId, ref, jobIds));
        return { mergeRequest: toWireView(view) };
    }
    async replyMergeRequestDiscussion(_ctx, req) {
        const sessionId = requireText(req.sessionId, 'sessionId');
        const ref = fromWireRef(req.ref);
        const discussionId = requireText(req.discussionId, 'discussionId');
        const body = requireBody(req.body, 'body');
        const discussion = await invoke(() => this.actions.reply(sessionId, ref, discussionId, body));
        return { discussion: toWireDiscussion(discussion) };
    }
    async resolveMergeRequestDiscussion(_ctx, req) {
        const sessionId = requireText(req.sessionId, 'sessionId');
        const ref = fromWireRef(req.ref);
        const discussionId = requireText(req.discussionId, 'discussionId');
        const resolved = optionalBoolean(req.resolved, 'resolved');
        if (resolved === undefined) {
            throw new AppError(400, 'MERGE_REQUEST_REQUEST_INVALID', 'resolved is required');
        }
        const discussion = await invoke(() => this.actions.resolve(sessionId, ref, discussionId, resolved));
        return { discussion: toWireDiscussion(discussion) };
    }
    async addMergeRequestComment(_ctx, req) {
        const sessionId = requireText(req.sessionId, 'sessionId');
        const ref = fromWireRef(req.ref);
        const body = requireBody(req.body, 'body');
        const discussion = await invoke(() => this.actions.comment(sessionId, ref, body));
        return { discussion: toWireDiscussion(discussion) };
    }
    async updateMergeRequest(_ctx, req) {
        const sessionId = requireText(req.sessionId, 'sessionId');
        const ref = fromWireRef(req.ref);
        const change = toMergeRequestUpdate(req);
        const view = await invoke(() => this.actions.update(sessionId, ref, change));
        return { mergeRequest: toWireView(view) };
    }
    async searchMergeRequestReviewers(_ctx, req) {
        const sessionId = requireText(req.sessionId, 'sessionId');
        const ref = fromWireRef(req.ref);
        const query = optionalQuery(req.query);
        const users = await invoke(() => this.actions.searchReviewers(sessionId, ref, query));
        return {
            users: users.map((user) => ({
                login: user.login,
                ...(user.name ? { name: user.name } : {}),
            })),
        };
    }
    async getMergeRequestCreateDefaults(_ctx, req) {
        const sessionId = requireText(req.sessionId, 'sessionId');
        const defaults = await invoke(() => this.actions.createDefaults(sessionId));
        return {
            repo: toWireRepo(defaults.repo),
            targetBranch: defaults.targetBranch,
            title: defaults.title,
            ...(defaults.description ? { description: defaults.description } : {}),
            draft: defaults.draft,
            ...(defaults.squash !== undefined ? { squash: defaults.squash } : {}),
            ...(defaults.deleteSourceBranch !== undefined
                ? { deleteSourceBranch: defaults.deleteSourceBranch }
                : {}),
            needsPush: defaults.needsPush,
            ...(defaults.commits ? { commits: defaults.commits.map(toWireCommit) } : {}),
        };
    }
    async createMergeRequest(_ctx, req) {
        const sessionId = requireText(req.sessionId, 'sessionId');
        const targetBranch = requireText(req.targetBranch, 'targetBranch').trim();
        const title = requireBody(req.title, 'title').trim();
        const description = optionalLimitedText(req.description, 'description');
        const draft = optionalBoolean(req.draft, 'draft');
        const squash = optionalBoolean(req.squash, 'squash');
        const deleteSourceBranch = optionalBoolean(req.deleteSourceBranch, 'deleteSourceBranch');
        const view = await invoke(() => this.actions.create(sessionId, {
            targetBranch,
            title,
            ...(description ? { description } : {}),
            ...(draft !== undefined ? { draft } : {}),
            ...(squash !== undefined ? { squash } : {}),
            ...(deleteSourceBranch !== undefined ? { deleteSourceBranch } : {}),
        }));
        return { mergeRequest: toWireView(view) };
    }
    async searchMergeRequestLinkCandidates(_ctx, req) {
        const sessionId = requireText(req.sessionId, 'sessionId');
        const query = optionalQuery(req.query);
        const candidates = await invoke(() => this.actions.linkCandidates(sessionId, query));
        return { candidates: candidates.map(toWireCandidate) };
    }
}
async function invoke(run) {
    try {
        return await run();
    }
    catch (error) {
        if (error instanceof MergeRequestError) {
            throw new AppError(ERROR_STATUS[error.code], error.code, error.message, RETRYABLE.has(error.code));
        }
        throw error;
    }
}
function invalid(message) {
    return new AppError(400, 'MERGE_REQUEST_REQUEST_INVALID', message);
}
function requireText(value, field) {
    if (!isText(value))
        throw invalid(`${field} is required`);
    return value;
}
function isText(value) {
    return typeof value === 'string' && value.trim().length > 0;
}
/** Text the user wrote that must not be blank, such as a comment or a title. */
function requireBody(value, field) {
    return limited(requireText(value, field), field);
}
/** Text that may be empty, such as a description being cleared. */
function optionalLimitedText(value, field) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'string')
        throw invalid(`${field} must be text`);
    return limited(value, field);
}
function limited(value, field) {
    if (value.length > MAX_TEXT_CHARS) {
        throw invalid(`${field} is longer than 1,048,576 characters`);
    }
    return value;
}
function optionalQuery(value) {
    if (value === undefined || value === null)
        return '';
    if (typeof value !== 'string')
        throw invalid('query must be text');
    if (value.length > MAX_QUERY_LENGTH)
        throw invalid('query is too long');
    return value.trim();
}
function optionalBoolean(value, field) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'boolean')
        throw invalid(`${field} must be true or false`);
    return value;
}
/** A list of ids or logins; an absent or empty list is undefined. */
function textList(value, field) {
    if (value === undefined || value === null)
        return undefined;
    if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS || !value.every(isText)) {
        throw invalid(`${field} must be a list of at most ${String(MAX_LIST_ITEMS)} non-blank values`);
    }
    const items = value.map((item) => item.trim());
    return items.length > 0 ? items : undefined;
}
function fromWireMergeMethod(value) {
    if (value === undefined || value === null)
        return undefined;
    if (value === MergeRequestMergeMethod.MERGE_REQUEST_MERGE_METHOD_UNSPECIFIED)
        return undefined;
    const method = typeof value === 'number' ? MERGE_METHOD_NAMES.get(value) : undefined;
    if (!method)
        throw invalid('method is not a merge method');
    return method;
}
function fromWireStateEvent(value) {
    if (value === undefined || value === null)
        return undefined;
    if (value === MergeRequestStateEvent.MERGE_REQUEST_STATE_EVENT_UNSPECIFIED)
        return undefined;
    const event = typeof value === 'number' ? STATE_EVENT_NAMES.get(value) : undefined;
    if (!event)
        throw invalid('stateEvent is not close or reopen');
    return event;
}
/** The fields of an update that are set; at least one has to be. */
function toMergeRequestUpdate(req) {
    const draft = optionalBoolean(req.draft, 'draft');
    const stateEvent = fromWireStateEvent(req.stateEvent);
    const title = req.title === undefined || req.title === null
        ? undefined
        : requireBody(req.title, 'title').trim();
    const description = optionalLimitedText(req.description, 'description');
    const addReviewers = textList(req.addReviewers, 'addReviewers');
    const change = {
        ...(draft !== undefined ? { draft } : {}),
        ...(stateEvent ? { stateEvent } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(addReviewers ? { addReviewers } : {}),
    };
    if (Object.keys(change).length === 0)
        throw invalid('Set at least one field to change');
    return change;
}
function fromWireRef(ref) {
    const platform = ref ? PLATFORM_NAMES.get(ref.platform) : undefined;
    if (!ref || !platform || !isText(ref.host) || !isText(ref.projectPath)) {
        throw invalid('ref is not a valid merge request reference');
    }
    if (!Number.isSafeInteger(ref.number) || ref.number <= 0) {
        throw invalid('ref.number must be a positive integer');
    }
    return {
        platform,
        host: ref.host.toLowerCase(),
        projectPath: ref.projectPath,
        number: ref.number,
    };
}
function toWireRef(ref) {
    return {
        platform: PLATFORMS[ref.platform],
        host: ref.host,
        projectPath: ref.projectPath,
        number: ref.number,
    };
}
function toWireRepo(repo) {
    return {
        platform: PLATFORMS[repo.platform],
        host: repo.host,
        projectPath: repo.projectPath,
        ...(repo.branch ? { branch: repo.branch } : {}),
        ...(repo.defaultBranch ? { defaultBranch: repo.defaultBranch } : {}),
    };
}
function toWireHost(host) {
    return {
        host: host.host,
        platform: PLATFORMS[host.platform],
        cli: host.cli,
        cliState: CLI_STATES[host.cliState],
        loginCommand: host.loginCommand,
        ...(host.cliVersion ? { cliVersion: host.cliVersion } : {}),
        ...(host.accountLogin ? { accountLogin: host.accountLogin } : {}),
        ...(host.message ? { message: host.message } : {}),
        ...(host.rateLimitedUntilMs !== undefined
            ? { rateLimitedUntilMs: host.rateLimitedUntilMs }
            : {}),
        ...(host.checkedAtMs !== undefined ? { checkedAtMs: host.checkedAtMs } : {}),
        requestsThisHour: host.requestsThisHour,
        requestBudgetPerHour: host.requestBudgetPerHour,
    };
}
function toWireView(view) {
    return {
        ref: toWireRef(view.ref),
        webUrl: view.webUrl,
        linkSource: LINK_SOURCES[view.linkSource],
        removable: view.removable,
        status: STATUSES[view.status],
        ...(view.linkedAtMs !== undefined ? { linkedAtMs: view.linkedAtMs } : {}),
        ...(view.fetchedAtMs !== undefined ? { fetchedAtMs: view.fetchedAtMs } : {}),
        ...(view.error ? { error: toWireError(view.error) } : {}),
        ...(view.snapshot ? toWireSnapshot(view.snapshot) : {}),
    };
}
function toWireError(error) {
    return { code: error.code, ...(error.message ? { message: error.message } : {}) };
}
/**
 * Platform data of a card; absent until the merge request was fetched once.
 * Platform ids used for writes stay inside the runtime.
 */
function toWireSnapshot(snapshot) {
    return {
        title: snapshot.title,
        state: STATES[snapshot.state],
        draft: snapshot.draft,
        ...(snapshot.sourceBranch ? { sourceBranch: snapshot.sourceBranch } : {}),
        ...(snapshot.targetBranch ? { targetBranch: snapshot.targetBranch } : {}),
        ...(snapshot.headSha ? { headSha: snapshot.headSha } : {}),
        ...(snapshot.authorLogin ? { authorLogin: snapshot.authorLogin } : {}),
        ...(snapshot.authorName ? { authorName: snapshot.authorName } : {}),
        ...(snapshot.createdAtMs !== undefined ? { createdAtMs: snapshot.createdAtMs } : {}),
        ...(snapshot.updatedAtMs !== undefined ? { updatedAtMs: snapshot.updatedAtMs } : {}),
        ...(snapshot.pipeline ? { pipeline: toWirePipeline(snapshot.pipeline) } : {}),
        review: { ...snapshot.review },
        mergeability: toWireMergeability(snapshot),
        ...toWireSize(snapshot),
        ...toWireDetails(snapshot),
    };
}
/** How big the change is, whether it needs a rebase, and what the account may do with it. */
function toWireSize(snapshot) {
    return {
        ...(snapshot.diffStats ? { diffStats: { ...snapshot.diffStats } } : {}),
        ...(snapshot.behindTarget !== undefined ? { behindTarget: snapshot.behindTarget } : {}),
        ...(snapshot.permissions ? { permissions: { ...snapshot.permissions } } : {}),
    };
}
/** Jobs, threads, description, reviewers and commits: only on cards the client expanded. */
function toWireDetails(snapshot) {
    return {
        ...(snapshot.jobs ? { jobs: snapshot.jobs.map(toWireJob) } : {}),
        ...(snapshot.discussions ? { discussions: snapshot.discussions.map(toWireDiscussion) } : {}),
        ...(snapshot.description !== undefined ? { description: snapshot.description } : {}),
        ...(snapshot.reviewers
            ? {
                reviewers: snapshot.reviewers.map((reviewer) => ({
                    login: reviewer.login,
                    ...(reviewer.name ? { name: reviewer.name } : {}),
                    state: REVIEW_STATES[reviewer.state],
                })),
            }
            : {}),
        ...(snapshot.commits ? { commits: snapshot.commits.map(toWireCommit) } : {}),
    };
}
function toWirePipeline(pipeline) {
    return {
        status: CHECKS[pipeline.status],
        ...(pipeline.webUrl ? { webUrl: pipeline.webUrl } : {}),
        ...(pipeline.failedCount !== undefined ? { failedCount: pipeline.failedCount } : {}),
        ...(pipeline.runningCount !== undefined ? { runningCount: pipeline.runningCount } : {}),
        ...(pipeline.passedCount !== undefined ? { passedCount: pipeline.passedCount } : {}),
        ...(pipeline.failedJobs ? { failedJobs: pipeline.failedJobs.map(toWireJob) } : {}),
    };
}
function toWireMergeability(snapshot) {
    return {
        blockers: snapshot.blockers.map((blocker) => BLOCKERS[blocker]),
        hasConflicts: snapshot.hasConflicts,
        mergeable: snapshot.mergeable,
        ...(snapshot.platformStatus ? { platformStatus: snapshot.platformStatus } : {}),
    };
}
function toWireJob(job) {
    return {
        id: job.id,
        name: job.name,
        status: CHECKS[job.status],
        logAvailable: job.logAvailable,
        ...(job.groupName ? { groupName: job.groupName } : {}),
        ...(job.webUrl ? { webUrl: job.webUrl } : {}),
        ...(job.allowFailure !== undefined ? { allowFailure: job.allowFailure } : {}),
        ...(job.startedAtMs !== undefined ? { startedAtMs: job.startedAtMs } : {}),
        ...(job.finishedAtMs !== undefined ? { finishedAtMs: job.finishedAtMs } : {}),
    };
}
function toWireDiscussion(discussion) {
    return {
        id: discussion.id,
        resolved: discussion.resolved,
        resolvable: discussion.resolvable,
        notes: discussion.notes.map((note) => ({ ...note })),
        ...(discussion.path ? { path: discussion.path } : {}),
        ...(discussion.newLine !== undefined ? { newLine: discussion.newLine } : {}),
        ...(discussion.oldLine !== undefined ? { oldLine: discussion.oldLine } : {}),
        ...(discussion.diffHunk ? { diffHunk: discussion.diffHunk } : {}),
        ...(discussion.outdated !== undefined ? { outdated: discussion.outdated } : {}),
        ...(discussion.webUrl ? { webUrl: discussion.webUrl } : {}),
        ...(discussion.canReply !== undefined ? { canReply: discussion.canReply } : {}),
        ...(discussion.canResolve !== undefined ? { canResolve: discussion.canResolve } : {}),
    };
}
function toWireCommit(commit) {
    return { ...commit };
}
function toWireFileChange(file) {
    return {
        path: file.path,
        kind: FILE_CHANGE_KINDS[file.kind],
        ...(file.oldPath ? { oldPath: file.oldPath } : {}),
        ...(file.additions !== undefined ? { additions: file.additions } : {}),
        ...(file.deletions !== undefined ? { deletions: file.deletions } : {}),
        ...(file.patch !== undefined ? { patch: file.patch } : {}),
        ...(file.binary !== undefined ? { binary: file.binary } : {}),
        ...(file.tooLarge !== undefined ? { tooLarge: file.tooLarge } : {}),
    };
}
function toWireCleanupIssue(issue) {
    return {
        blocker: CLEANUP_BLOCKERS[issue.blocker],
        ...(issue.count !== undefined ? { count: issue.count } : {}),
        ...(issue.message ? { message: issue.message } : {}),
    };
}
function toWireCleanupPlan(plan) {
    return {
        available: plan.available,
        ...(plan.worktreePath ? { worktreePath: plan.worktreePath } : {}),
        ...(plan.branch ? { branch: plan.branch } : {}),
        issues: plan.issues.map(toWireCleanupIssue),
        ...(plan.sizeBytes !== undefined ? { sizeBytes: plan.sizeBytes } : {}),
    };
}
function toWireCleanupResult(result) {
    return {
        worktreeRemoved: result.worktreeRemoved,
        branchDeleted: result.branchDeleted,
        ...(result.issues && result.issues.length > 0
            ? { issues: result.issues.map(toWireCleanupIssue) }
            : {}),
    };
}
function toWireCandidate(candidate) {
    return {
        ref: toWireRef(candidate.ref),
        webUrl: candidate.webUrl,
        reason: CANDIDATE_REASONS[candidate.reason],
        ...(candidate.title ? { title: candidate.title } : {}),
        ...(candidate.state ? { state: STATES[candidate.state] } : {}),
        ...(candidate.draft !== undefined ? { draft: candidate.draft } : {}),
        ...(candidate.authorLogin ? { authorLogin: candidate.authorLogin } : {}),
        ...(candidate.sourceBranch ? { sourceBranch: candidate.sourceBranch } : {}),
        ...(candidate.targetBranch ? { targetBranch: candidate.targetBranch } : {}),
        ...(candidate.updatedAtMs !== undefined ? { updatedAtMs: candidate.updatedAtMs } : {}),
        ...(candidate.linked ? { linked: true } : {}),
    };
}
//# sourceMappingURL=merge-request.controller.js.map