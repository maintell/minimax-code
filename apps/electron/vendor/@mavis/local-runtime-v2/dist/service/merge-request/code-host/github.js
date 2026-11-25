import { asBoolean, asNumber, asRecord, asString, branchKey, definedFields, emptyHostQueryResult, FAILED_JOBS_LIMIT, nextCursor, nodesOf, packByCost, parseTimeMs, probeCli, readApiLog, readAuthStatusHosts, runGraphql, someFields, } from './adapter.js';
import { CodeHostRequestError } from './cli-runner.js';
import { byFirstNote, GITHUB_AUTHOR_FIELDS, GITHUB_COMMENT_FIELDS, GITHUB_REVIEW_FIELDS, GITHUB_THREAD_FIELDS, gitHubActions, gitHubConversationComment, gitHubReviewSummary, gitHubState, gitHubThread, splitRepository, } from './github-actions.js';
import { deriveStatus, refusalBlockers } from './status.js';
import { mergeRequestKey, mergeRequestWebUrl, projectKey } from './urls.js';
/**
 * Checks read with the summary to list the failed ones. GitHub cannot filter or
 * order them by state, so failures past this many only show in the full list.
 */
const SUMMARY_CHECKS = 50;
const CONTEXT_FIELDS = '__typename ... on CheckRun { databaseId name status conclusion detailsUrl startedAt completedAt ' +
    'checkSuite { app { slug } workflowRun { workflow { name } } } } ' +
    '... on StatusContext { context state targetUrl createdAt }';
/**
 * The checks come with the counts so the failed ones can be listed: GitHub can
 * neither filter them by state nor puts failures first.
 */
const SUMMARY_FIELDS = 'id number title url state isDraft headRefName baseRefName headRefOid createdAt updatedAt ' +
    `${GITHUB_AUTHOR_FIELDS} additions deletions changedFiles viewerCanUpdate ` +
    'headRepository { nameWithOwner } mergeable mergeStateStatus reviewDecision ' +
    // Newest first: open threads gather at the end of a busy pull request.
    'reviewThreads(last: 100) { nodes { isResolved } } ' +
    `commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: ${String(SUMMARY_CHECKS)}) { ` +
    'checkRunCountsByState { state count } statusContextCountsByState { state count } ' +
    `nodes { ${CONTEXT_FIELDS} } } } } } }`;
const PAGED_LISTS = ['reviewThreads', 'comments', 'reviews'];
const PAGED_FIELDS = {
    reviewThreads: GITHUB_THREAD_FIELDS,
    comments: GITHUB_COMMENT_FIELDS,
    reviews: GITHUB_REVIEW_FIELDS,
};
function pagedConnection(list, after) {
    return (`${list}(first: 100${after ? `, after: ${JSON.stringify(after)}` : ''}) { ` +
        `pageInfo { hasNextPage endCursor } nodes { ${PAGED_FIELDS[list]} } }`);
}
const DETAIL_FIELDS = 'number body author { login } ' +
    'reviewRequests(first: 50) { nodes { requestedReviewer { __typename ' +
    '... on User { login name } ... on Team { combinedSlug name } ... on Bot { login } ... on Mannequin { login } } } } ' +
    `latestOpinionatedReviews(first: 50) { nodes { state ${GITHUB_AUTHOR_FIELDS} } } ` +
    `latestReviews(first: 50) { nodes { state ${GITHUB_AUTHOR_FIELDS} } } ` +
    'commitList: commits(last: 100) { nodes { commit { oid messageHeadline authoredDate url author { name } } } } ' +
    `commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { ${CONTEXT_FIELDS} } } } } } } ` +
    `${PAGED_LISTS.map((list) => pagedConnection(list)).join(' ')}`;
/**
 * Pull request lookups per request, by what each costs. GitHub gives a query
 * 10 seconds. On openai/codex, whose pull requests carry 50 checks, 15 summary
 * lookups took 5.8 to 8.2 s, one detail lookup 3.6 to 4.1 s and five of them
 * 9.2 to 10.4 s: a detail costs about five summaries.
 */
const LOOKUP_COST = { number: 1, branch: 1, detail: 5 };
const LOOKUP_BUDGET = 16;
/** Pages of 100 read per list and pull request; later ones are left out. */
const LIST_PAGES_LIMIT = 5;
const WRITE_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);
const MERGE_METHOD = {
    MERGE: 'merge',
    SQUASH: 'squash',
    REBASE: 'rebase',
};
const REVIEW_STATES = {
    APPROVED: 'approved',
    CHANGES_REQUESTED: 'changes_requested',
    COMMENTED: 'commented',
    DISMISSED: 'commented',
};
/** CheckRunState and CheckConclusionState values; the two enums share these names. */
const CHECK_RUN_STATUS = {
    SUCCESS: 'success',
    NEUTRAL: 'success',
    FAILURE: 'failed',
    TIMED_OUT: 'failed',
    STARTUP_FAILURE: 'failed',
    CANCELLED: 'canceled',
    SKIPPED: 'skipped',
    STALE: 'skipped',
    ACTION_REQUIRED: 'manual',
    IN_PROGRESS: 'running',
    QUEUED: 'pending',
    PENDING: 'pending',
    WAITING: 'pending',
    REQUESTED: 'pending',
};
/** StatusState values of commit statuses that external CI posts. */
const STATUS_CONTEXT_STATUS = {
    SUCCESS: 'success',
    FAILURE: 'failed',
    ERROR: 'failed',
    PENDING: 'pending',
    EXPECTED: 'pending',
};
const MERGEABLE_STATES = new Set(['CLEAN', 'HAS_HOOKS', 'UNSTABLE']);
export function createGitHubAdapter(nowMs) {
    return {
        platform: 'github',
        cli: 'gh',
        plan: planGitHubQueries,
        execute: (host, plan, call) => executeGitHubPlan(host, plan, { call, nowMs }),
        jobLog: readGitHubJobLog,
        probe: probeGh,
        configuredHosts: async (call) => {
            const { result } = await call(['auth', 'status'], { raw: true });
            return readAuthStatusHosts(`${result.stdout}\n${result.stderr}`);
        },
        mergeOptions: (ref, _snapshot, call) => readMergeOptions(ref, { call, nowMs }),
        ...gitHubActions(nowMs),
    };
}
/** @internal Exported only for focused tests. */
export function planGitHubQueries(projects) {
    const lookups = projects.flatMap((project) => {
        const lookup = (kind) => (value) => ({
            projectPath: project.projectPath,
            kind,
            value,
        });
        return [
            ...project.numbers.map(lookup('number')),
            ...project.branches.map(lookup('branch')),
            ...project.detailNumbers.map(lookup('detail')),
        ];
    });
    return packByCost(lookups, (lookup) => LOOKUP_COST[lookup.kind], LOOKUP_BUDGET).map((group) => {
        const groupProjects = byProject(group);
        return { query: buildGitHubQuery(groupProjects), projects: groupProjects };
    });
}
/** One project query per repository, in the order the repositories first appear. */
function byProject(lookups) {
    const projects = new Map();
    for (const lookup of lookups) {
        const project = projects.get(lookup.projectPath) ?? {
            projectPath: lookup.projectPath,
            numbers: [],
            branches: [],
            detailNumbers: [],
        };
        if (lookup.kind === 'number')
            project.numbers.push(Number(lookup.value));
        if (lookup.kind === 'branch')
            project.branches.push(String(lookup.value));
        if (lookup.kind === 'detail')
            project.detailNumbers.push(Number(lookup.value));
        projects.set(lookup.projectPath, project);
    }
    return [...projects.values()];
}
function buildGitHubQuery(projects) {
    const parts = projects.map((project, index) => {
        const { owner, name } = splitRepository(project.projectPath);
        const fields = [
            // Whether the account may merge is a property of the repository, read once.
            'viewerPermission',
            ...project.numbers.map((number) => `n${String(number)}: pullRequest(number: ${String(number)}) { ${SUMMARY_FIELDS} }`),
            ...project.branches.map((branch, position) => `b${String(position)}: pullRequests(headRefName: ${JSON.stringify(branch)}, states: [OPEN], first: 10, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ${SUMMARY_FIELDS} } }`),
            ...project.detailNumbers.map((number) => `d${String(number)}: pullRequest(number: ${String(number)}) { ${DETAIL_FIELDS} }`),
        ];
        return `r${String(index)}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields.join(' ')} }`;
    });
    return `query { ${parts.join(' ')} }`;
}
async function executeGitHubPlan(host, plan, context) {
    const { data } = await runGraphql(context.call, host, plan.query, context.nowMs());
    const { result, details } = readPlanData(host, plan, data);
    for (const detail of details) {
        await readRemainingLists(host, detail, context);
        result.details.set(detail.key, toDetails(host, detail));
    }
    return result;
}
/**
 * The plan's answer with only the first page of each detail list.
 * @internal Exported only for focused tests.
 */
export function readGitHubResult(host, plan, data) {
    const { result, details } = readPlanData(host, plan, data);
    for (const detail of details)
        result.details.set(detail.key, toDetails(host, detail));
    return result;
}
function readPlanData(host, plan, data) {
    const result = emptyHostQueryResult();
    const details = [];
    plan.projects.forEach((project, index) => {
        const key = projectKey('github', host, project.projectPath);
        const repository = asRecord(data[`r${String(index)}`]);
        if (!repository) {
            result.missingProjects.add(key);
            return;
        }
        const scope = {
            host,
            projectPath: project.projectPath,
            ...definedFields({ viewerPermission: asString(repository['viewerPermission']) }),
        };
        for (const number of project.numbers) {
            const node = asRecord(repository[`n${String(number)}`]);
            const snapshot = node ? toSnapshot(scope, node) : undefined;
            if (snapshot)
                result.mergeRequests.set(mergeRequestKey(snapshot.ref), snapshot);
        }
        project.branches.forEach((branch, position) => {
            const matches = branchMatches(scope, nodesOf(repository[`b${String(position)}`]));
            for (const snapshot of matches)
                result.mergeRequests.set(mergeRequestKey(snapshot.ref), snapshot);
            result.branches.set(branchKey(key, branch), matches);
        });
        for (const number of project.detailNumbers) {
            const node = asRecord(repository[`d${String(number)}`]);
            if (node)
                details.push(toDetailRead(`${key}!${String(number)}`, scope, node));
        }
    });
    return { result, details };
}
/** A fork can push a branch with the same name; only this repository's own branch counts. */
function branchMatches(scope, nodes) {
    return nodes.flatMap((node) => {
        const headRepository = asString(asRecord(node['headRepository'])?.['nameWithOwner']);
        if (headRepository?.toLowerCase() !== scope.projectPath.toLowerCase())
            return [];
        const snapshot = toSnapshot(scope, node);
        return snapshot ? [snapshot] : [];
    });
}
function toDetailRead(key, scope, node) {
    const lists = { reviewThreads: [], comments: [], reviews: [] };
    const cursors = {};
    for (const list of PAGED_LISTS) {
        lists[list] = nodesOf(node[list]);
        const cursor = nextCursor(node[list]);
        if (cursor)
            cursors[list] = cursor;
    }
    return {
        key,
        projectPath: scope.projectPath,
        number: asNumber(node['number']) ?? 0,
        node,
        lists,
        cursors,
    };
}
/**
 * Reads the lists past their first page, all of one pull request's in one
 * request per round, up to LIST_PAGES_LIMIT pages each. A failed round ends the
 * reading with what was read; a rate limit still stops the whole read so the
 * host backs off.
 */
async function readRemainingLists(host, detail, context) {
    const { owner, name } = splitRepository(detail.projectPath);
    for (let page = 1; page < LIST_PAGES_LIMIT; page += 1) {
        const pending = PAGED_LISTS.filter((list) => detail.cursors[list]);
        if (pending.length === 0)
            return;
        const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ` +
            `pullRequest(number: ${String(detail.number)}) { ` +
            `${pending.map((list) => pagedConnection(list, detail.cursors[list])).join(' ')} } } }`;
        let pullRequest;
        try {
            const { data } = await runGraphql(context.call, host, query, context.nowMs());
            pullRequest = asRecord(asRecord(data['repository'])?.['pullRequest']);
        }
        catch (error) {
            if (error instanceof CodeHostRequestError && error.kind === 'rate_limited')
                throw error;
            return;
        }
        for (const list of pending) {
            detail.lists[list].push(...nodesOf(pullRequest?.[list]));
            const cursor = nextCursor(pullRequest?.[list]);
            if (cursor)
                detail.cursors[list] = cursor;
            else
                delete detail.cursors[list];
        }
    }
}
function toSnapshot(scope, node) {
    const { host, projectPath } = scope;
    const number = asNumber(node['number']);
    if (number === undefined || number <= 0)
        return undefined;
    const ref = { platform: 'github', host, projectPath, number };
    const webUrl = asString(node['url']) ?? mergeRequestWebUrl(ref);
    const pipeline = readPipeline(host, projectPath, node, webUrl);
    const signals = readSignals(node, pipeline?.status);
    const decision = asString(node['reviewDecision']);
    return {
        ref,
        webUrl,
        title: asString(node['title']) ?? '',
        state: signals.state,
        draft: signals.draft,
        ...deriveStatus(signals),
        hasConflicts: signals.conflict,
        ...definedFields({
            platformStatus: asString(node['mergeStateStatus']),
            sourceBranch: asString(node['headRefName']),
            targetBranch: asString(node['baseRefName']),
            headSha: asString(node['headRefOid']),
            authorLogin: asString(asRecord(node['author'])?.['login']),
            updatedAtMs: parseTimeMs(node['updatedAt']),
            pipeline,
        }),
        ...summaryExtras(scope, node),
        review: {
            ...(decision ? { approved: decision === 'APPROVED' } : {}),
            changesRequested: signals.changesRequested,
            unresolvedDiscussionCount: signals.unresolvedDiscussions,
        },
    };
}
/** Summary fields shown on the card without a status signal of their own. */
function summaryExtras(scope, node) {
    const mergeState = asString(node['mergeStateStatus']);
    return definedFields({
        createdAtMs: parseTimeMs(node['createdAt']),
        authorName: asString(asRecord(node['author'])?.['name']),
        diffStats: someFields({
            fileCount: asNumber(node['changedFiles']),
            additions: asNumber(node['additions']),
            deletions: asNumber(node['deletions']),
        }),
        // UNKNOWN means GitHub has not worked it out yet.
        behindTarget: mergeState && mergeState !== 'UNKNOWN' ? mergeState === 'BEHIND' : undefined,
        permissions: someFields({
            canMerge: scope.viewerPermission ? WRITE_PERMISSIONS.has(scope.viewerPermission) : undefined,
            canUpdate: asBoolean(node['viewerCanUpdate']),
        }),
        platformIds: someFields({
            nodeId: asString(node['id']),
            headRepository: asString(asRecord(node['headRepository'])?.['nameWithOwner']),
        }),
    });
}
function readSignals(node, pipeline) {
    const mergeable = asString(node['mergeable']);
    const mergeState = asString(node['mergeStateStatus']);
    const decision = asString(node['reviewDecision']);
    return {
        state: gitHubState(asString(node['state'])),
        draft: node['isDraft'] === true,
        conflict: mergeable === 'CONFLICTING' || mergeState === 'DIRTY',
        ...(pipeline ? { pipeline } : {}),
        changesRequested: decision === 'CHANGES_REQUESTED',
        unresolvedDiscussions: nodesOf(node['reviewThreads']).filter((thread) => thread['isResolved'] !== true).length,
        approvalRequired: decision === 'REVIEW_REQUIRED',
        needRebase: mergeState === 'BEHIND',
        checking: mergeable === 'UNKNOWN' || mergeState === 'UNKNOWN',
        platformMergeable: mergeable === 'MERGEABLE' && mergeState !== undefined && MERGEABLE_STATES.has(mergeState),
    };
}
function readPipeline(host, projectPath, node, webUrl) {
    const rollup = rollupOf(node);
    if (!rollup)
        return undefined;
    const contexts = asRecord(rollup['contexts']);
    const counts = readCounts(contexts);
    const failedJobs = jobsOf(host, projectPath, contexts)
        .filter((job) => job.status === 'failed')
        .slice(0, FAILED_JOBS_LIMIT);
    return {
        status: rollupStatus(asString(rollup['state']), counts),
        webUrl: `${webUrl}/checks`,
        failedCount: counts.failed,
        runningCount: counts.running,
        passedCount: counts.passed,
        ...(failedJobs.length > 0 ? { failedJobs } : {}),
    };
}
function rollupOf(node) {
    const commit = asRecord(nodesOf(node['commits'])[0]?.['commit']);
    return asRecord(commit?.['statusCheckRollup']);
}
/** The count a check in this state adds to; canceled, skipped and manual checks add to none. */
const COUNTED_AS = {
    failed: 'failed',
    pending: 'running',
    running: 'running',
    success: 'passed',
};
function readCounts(contexts) {
    const counts = { failed: 0, running: 0, passed: 0 };
    addCounts(counts, contexts?.['checkRunCountsByState'], CHECK_RUN_STATUS);
    addCounts(counts, contexts?.['statusContextCountsByState'], STATUS_CONTEXT_STATUS);
    return counts;
}
function addCounts(counts, list, statuses) {
    for (const item of nodesFromList(list)) {
        const status = statuses[asString(item['state']) ?? ''];
        const bucket = status ? COUNTED_AS[status] : undefined;
        if (bucket)
            counts[bucket] += asNumber(item['count']) ?? 0;
    }
}
function nodesFromList(value) {
    return Array.isArray(value)
        ? value.flatMap((item) => (asRecord(item) ? [asRecord(item)] : []))
        : [];
}
function rollupStatus(state, counts) {
    if (state === 'SUCCESS')
        return 'success';
    if (state === 'FAILURE' || state === 'ERROR')
        return 'failed';
    if (state === 'PENDING')
        return counts.running > 0 ? 'running' : 'pending';
    if (state === 'EXPECTED')
        return 'pending';
    return 'unknown';
}
function toDetails(host, detail) {
    const { node, lists } = detail;
    const discussions = [
        ...lists.reviewThreads.flatMap((thread) => gitHubThread(thread) ?? []),
        ...lists.comments.flatMap((comment) => gitHubConversationComment(comment) ?? []),
        ...lists.reviews.flatMap((review) => gitHubReviewSummary(review) ?? []),
    ].sort(byFirstNote);
    return {
        jobs: jobsOf(host, detail.projectPath, rollupOf(node)?.['contexts']),
        discussions,
        // Whole: an edit saves what the panel shows. GitHub itself caps a body at 65,536 characters.
        ...definedFields({ description: asString(node['body']) }),
        reviewers: toReviewers(node),
        commits: nodesOf(node['commitList']).flatMap(toCommit),
    };
}
/**
 * Each reviewer once: the latest review, an approval or change request over a
 * later comment, and a pending request over both, the way GitHub's sidebar
 * shows them. The author's own reviews are replies, not reviews.
 */
function toReviewers(node) {
    const author = asString(asRecord(node['author'])?.['login']);
    const reviewers = new Map();
    const reviews = [...nodesOf(node['latestReviews']), ...nodesOf(node['latestOpinionatedReviews'])];
    for (const review of reviews) {
        const state = REVIEW_STATES[asString(review['state']) ?? ''];
        if (state)
            addReviewer(reviewers, asRecord(review['author']), state);
    }
    for (const request of nodesOf(node['reviewRequests']))
        addReviewer(reviewers, asRecord(request['requestedReviewer']), 'requested');
    if (author)
        reviewers.delete(author);
    return [...reviewers.values()];
}
function addReviewer(reviewers, actor, state) {
    const login = asString(actor?.['login']) ?? asString(actor?.['combinedSlug']);
    if (login)
        reviewers.set(login, { login, ...definedFields({ name: asString(actor?.['name']) }), state });
}
function toCommit(node) {
    const commit = asRecord(node['commit']);
    const sha = asString(commit?.['oid']);
    if (!commit || !sha)
        return [];
    return [
        {
            sha,
            ...definedFields({
                title: asString(commit['messageHeadline']),
                authorName: asString(asRecord(commit['author'])?.['name']),
                authoredAtMs: parseTimeMs(commit['authoredDate']),
                webUrl: asString(commit['url']),
            }),
        },
    ];
}
/** The check runs and commit statuses of a rollup's `contexts` connection. */
function jobsOf(host, projectPath, contexts) {
    return nodesOf(contexts).flatMap((context) => {
        const job = toJob(host, projectPath, context);
        return job ? [job] : [];
    });
}
function toJob(host, projectPath, node) {
    return node['__typename'] === 'StatusContext'
        ? toStatusContextJob(node)
        : toCheckRunJob(host, projectPath, node);
}
/** A commit status posted by external CI; its log lives there, not on GitHub. */
function toStatusContextJob(node) {
    const name = asString(node['context']);
    if (!name)
        return undefined;
    return {
        id: `status:${name}`,
        name,
        status: STATUS_CONTEXT_STATUS[asString(node['state']) ?? ''] ?? 'unknown',
        ...definedFields({ webUrl: asString(node['targetUrl']) }),
        logAvailable: false,
    };
}
function toCheckRunJob(host, projectPath, node) {
    const databaseId = asNumber(node['databaseId']);
    const name = asString(node['name']);
    if (databaseId === undefined || !name)
        return undefined;
    const suite = asRecord(node['checkSuite']);
    const startedAtMs = parseTimeMs(node['startedAt']);
    const fromActions = asString(asRecord(suite?.['app'])?.['slug']) === 'github-actions';
    return {
        id: String(databaseId),
        name,
        status: checkRunStatus(asString(node['status']), asString(node['conclusion'])),
        webUrl: asString(node['detailsUrl']) ?? `https://${host}/${projectPath}/runs/${String(databaseId)}`,
        ...definedFields({
            groupName: asString(asRecord(asRecord(suite?.['workflowRun'])?.['workflow'])?.['name']),
            startedAtMs,
            finishedAtMs: parseTimeMs(node['completedAt']),
        }),
        logAvailable: fromActions && startedAtMs !== undefined,
    };
}
function checkRunStatus(status, conclusion) {
    if (status === 'IN_PROGRESS')
        return 'running';
    if (status !== 'COMPLETED')
        return 'pending';
    return CHECK_RUN_STATUS[conclusion ?? ''] ?? 'unknown';
}
/**
 * The methods the repository allows, read fresh with the blockers, and whether
 * the base branch merges through a queue.
 */
async function readMergeOptions(ref, context) {
    const { owner, name } = splitRepository(ref.projectPath);
    const { data } = await runGraphql(context.call, ref.host, `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ` +
        'viewerPermission squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed viewerDefaultMergeMethod deleteBranchOnMerge ' +
        `pullRequest(number: ${String(ref.number)}) { ${SUMMARY_FIELDS} isMergeQueueEnabled } } }`, context.nowMs());
    const repository = asRecord(data['repository']);
    const node = asRecord(repository?.['pullRequest']);
    const scope = {
        host: ref.host,
        projectPath: ref.projectPath,
        ...definedFields({ viewerPermission: asString(repository?.['viewerPermission']) }),
    };
    const snapshot = node ? toSnapshot(scope, node) : undefined;
    if (!repository || !node || !snapshot)
        throw new CodeHostRequestError('not_found', 'GitHub has no such pull request');
    const methods = allowedMethods(repository);
    const preferred = MERGE_METHOD[asString(repository['viewerDefaultMergeMethod']) ?? ''];
    return {
        headSha: snapshot.headSha ?? '',
        methods,
        defaultMethod: preferred && methods.includes(preferred) ? preferred : (methods[0] ?? 'merge'),
        methodLocked: false,
        deleteSourceBranch: repository['deleteBranchOnMerge'] === true,
        deleteSourceBranchLocked: false,
        mergeQueue: node['isMergeQueueEnabled'] === true,
        blockers: refusalBlockers(snapshot),
    };
}
function allowedMethods(repository) {
    return [
        ...(repository['mergeCommitAllowed'] === true ? ['merge'] : []),
        ...(repository['squashMergeAllowed'] === true ? ['squash'] : []),
        ...(repository['rebaseMergeAllowed'] === true ? ['rebase'] : []),
    ];
}
async function readGitHubJobLog(ref, jobId, call, options) {
    if (!/^\d+$/u.test(jobId))
        throw new CodeHostRequestError('not_found', 'This check has no GitHub Actions log');
    return readApiLog(call, {
        host: ref.host,
        apiPath: `repos/${ref.projectPath}/actions/jobs/${jobId}/logs`,
        webUrl: `https://${ref.host}/${ref.projectPath}/runs/${jobId}`,
        ...(options?.full ? { full: true } : {}),
    });
}
function probeGh(host, call) {
    return probeCli('gh', /Logged in to \S+ (?:account|as) (\S+)/u, host, call);
}
//# sourceMappingURL=github.js.map