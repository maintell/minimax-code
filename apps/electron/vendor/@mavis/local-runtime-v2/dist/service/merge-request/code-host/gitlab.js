import { asBoolean, asNumber, asRecord, asString, branchKey, chunk, definedFields, emptyHostQueryResult, FAILED_JOBS_LIMIT, gqlStringList, nextCursor, nodesOf, packByCost, parseTimeMs, probeCli, readApiLog, readAuthStatusHosts, runGraphql, someFields, } from './adapter.js';
import { CodeHostRequestError } from './cli-runner.js';
import { GITLAB_NOTE_FIELDS, gitLabActions, gitLabState, gitLabThreads, lastSegment, readProjectSettings, } from './gitlab-actions.js';
import { deriveStatus, refusalBlockers } from './status.js';
import { mergeRequestKey, mergeRequestWebUrl, projectKey } from './urls.js';
const PENDING_JOB_STATUSES = '[RUNNING, PENDING, CREATED, PREPARING, WAITING_FOR_RESOURCE, WAITING_FOR_CALLBACK, SCHEDULED]';
const JOB_FIELDS = 'id name status allowFailure startedAt finishedAt webPath stage { name }';
/**
 * The count-only connections ask for no nodes: GitLab scores a connection without
 * `first` as a full page, and with the failed jobs added four branch blocks would
 * then score 248 of the 250 allowed.
 */
const SUMMARY_FIELDS = `iid state draft title webUrl sourceBranch targetBranch diffHeadSha createdAt updatedAt ` +
    `author { username name } detailedMergeStatus conflicts approved approvalsRequired approvalsLeft ` +
    `divergedFromTargetBranch diffStatsSummary { additions deletions fileCount } ` +
    `userPermissions { canMerge updateMergeRequest } ` +
    // Newest first: open threads gather at the end of a busy merge request. Same score as `first`.
    `discussions(last: 100) { nodes { resolvable resolved } } ` +
    `headPipeline { id status path ` +
    `failed: jobs(statuses: [FAILED], retried: false, first: ${String(FAILED_JOBS_LIMIT)}) { count nodes { ${JOB_FIELDS} } } ` +
    `running: jobs(statuses: ${PENDING_JOB_STATUSES}, retried: false, first: 0) { count } ` +
    `passed: jobs(statuses: [SUCCESS], retried: false, first: 0) { count } }`;
/**
 * Comments only, oldest first, each with its thread: read through the
 * discussions connection, system notes took 63 of the first 100 threads of a
 * busy merge request.
 */
function notesConnection(after) {
    return (`notes(filter: ONLY_COMMENTS, first: 100${after ? `, after: ${JSON.stringify(after)}` : ''}) { ` +
        `pageInfo { hasNextPage endCursor } nodes { ${GITLAB_NOTE_FIELDS} discussion { id resolved resolvable } } }`);
}
const DETAIL_FIELDS = 'iid description ' +
    'reviewers(first: 50) { nodes { username name mergeRequestInteraction { approved reviewState } } } ' +
    'approvedBy(first: 50) { nodes { username name } } ' +
    'commits(first: 100) { nodes { sha title authorName authoredDate webUrl } } ' +
    `headPipeline { jobs(first: 100, retried: false) { nodes { ${JOB_FIELDS} } } } ${notesConnection()}`;
/**
 * GitLab rejects queries scoring over 250. Measured with queryComplexity on
 * gitlab.xaminim.com (17.1.8), a block scores the same however many merge
 * requests it returns, and the scores of a query's blocks add up.
 */
const BLOCK_SCORE = { summary: 62, branch: 74, detail: 99 };
const COMPLEXITY_LIMIT = 250;
const NUMBERS_PER_BLOCK = 50;
/**
 * A detail block carries every comment: the busiest merge request measured
 * answered 450 KB in 1.9 s, so a few per block keep a response small.
 */
const DETAILS_PER_BLOCK = 5;
/** Pages of 100 comments read per merge request; later ones are left out. */
const NOTE_PAGES_LIMIT = 10;
const CHECK_STATUS = {
    SUCCESS: 'success',
    FAILED: 'failed',
    RUNNING: 'running',
    CANCELED: 'canceled',
    CANCELING: 'canceled',
    SKIPPED: 'skipped',
    MANUAL: 'manual',
    PENDING: 'pending',
    CREATED: 'pending',
    PREPARING: 'pending',
    WAITING_FOR_RESOURCE: 'pending',
    WAITING_FOR_CALLBACK: 'pending',
    SCHEDULED: 'pending',
};
const CHECKING_STATUSES = new Set(['CHECKING', 'UNCHECKED', 'PREPARING', 'APPROVALS_SYNCING']);
const REVIEW_STATES = {
    APPROVED: 'approved',
    REQUESTED_CHANGES: 'changes_requested',
    REVIEWED: 'commented',
    UNAPPROVED: 'commented',
};
export function createGitLabAdapter(nowMs) {
    return {
        platform: 'gitlab',
        cli: 'glab',
        plan: planGitLabQueries,
        execute: (host, plan, call) => executeGitLabPlan(host, plan, { call, nowMs }),
        jobLog: readGitLabJobLog,
        probe: probeGlab,
        configuredHosts: async (call) => {
            const { result } = await call(['auth', 'status'], { raw: true });
            return readAuthStatusHosts(`${result.stdout}\n${result.stderr}`);
        },
        mergeOptions: (ref, _snapshot, call) => readMergeOptions(ref, { call, nowMs }),
        ...gitLabActions(nowMs),
    };
}
/** @internal Exported only for focused tests. */
export function planGitLabQueries(projects) {
    const blocks = [];
    for (const project of projects) {
        const base = { projectPath: project.projectPath, numbers: [], detailNumbers: [], branches: [] };
        for (const numbers of chunk(project.numbers, NUMBERS_PER_BLOCK))
            blocks.push({ project: { ...base, numbers }, kind: 'summary' });
        if (project.branches.length > 0)
            blocks.push({ project: { ...base, branches: project.branches }, kind: 'branch' });
        for (const detailNumbers of chunk(project.detailNumbers, DETAILS_PER_BLOCK))
            blocks.push({ project: { ...base, detailNumbers }, kind: 'detail' });
    }
    return packByCost(blocks, (block) => BLOCK_SCORE[block.kind], COMPLEXITY_LIMIT).map((group) => {
        const groupProjects = group.map((block) => block.project);
        return { query: buildGitLabQuery(groupProjects), projects: groupProjects };
    });
}
function buildGitLabQuery(projects) {
    const parts = projects.map((project, index) => {
        const fields = [];
        if (project.numbers.length > 0) {
            fields.push(`mrs: mergeRequests(iids: ${gqlStringList(project.numbers.map(String))}, first: 100) { nodes { ${SUMMARY_FIELDS} } }`);
        }
        if (project.branches.length > 0) {
            // Open ones only: a long-lived branch such as main or a release train has
            // hundreds of merged merge requests, and counting their pipeline jobs took
            // longer than the request timeout.
            fields.push(`branches: mergeRequests(sourceBranches: ${gqlStringList(project.branches)}, state: opened, first: 20, sort: CREATED_DESC) { nodes { ${SUMMARY_FIELDS} } }`);
        }
        if (project.detailNumbers.length > 0) {
            fields.push(`details: mergeRequests(iids: ${gqlStringList(project.detailNumbers.map(String))}, first: 100) { nodes { ${DETAIL_FIELDS} } }`);
        }
        return `p${String(index)}: project(fullPath: ${JSON.stringify(project.projectPath)}) { ${fields.join(' ')} }`;
    });
    return `query { ${parts.join(' ')} }`;
}
async function executeGitLabPlan(host, plan, context) {
    const { data } = await runGraphql(context.call, host, plan.query, context.nowMs());
    const { result, details } = readGitLabResult(host, plan, data);
    for (const detail of details) {
        await readRemainingNotes(host, detail, context);
        result.details.set(detail.key, toDetails(host, detail));
    }
    return result;
}
function readGitLabResult(host, plan, data) {
    const result = emptyHostQueryResult();
    const details = [];
    plan.projects.forEach((project, index) => {
        const key = projectKey('gitlab', host, project.projectPath);
        const node = asRecord(data[`p${String(index)}`]);
        if (!node) {
            result.missingProjects.add(key);
            return;
        }
        for (const item of nodesOf(node['mrs'])) {
            const snapshot = toSnapshot(host, project.projectPath, item);
            if (snapshot)
                result.mergeRequests.set(mergeRequestKey(snapshot.ref), snapshot);
        }
        for (const branch of project.branches)
            result.branches.set(branchKey(key, branch), []);
        for (const item of nodesOf(node['branches'])) {
            const snapshot = toSnapshot(host, project.projectPath, item);
            if (!snapshot?.sourceBranch)
                continue;
            result.branches.get(branchKey(key, snapshot.sourceBranch))?.push(snapshot);
            result.mergeRequests.set(mergeRequestKey(snapshot.ref), snapshot);
        }
        for (const item of nodesOf(node['details'])) {
            const detail = toDetailRead(key, project.projectPath, item);
            if (detail)
                details.push(detail);
        }
    });
    return { result, details };
}
function toDetailRead(key, projectPath, node) {
    const number = Number(asString(node['iid']));
    if (!Number.isSafeInteger(number))
        return undefined;
    const notes = asRecord(node['notes']);
    return {
        key: `${key}!${String(number)}`,
        projectPath,
        number,
        node,
        notes: nodesOf(notes),
        cursor: nextCursor(notes),
    };
}
/**
 * Reads the comments past the first page, one page per request, up to
 * NOTE_PAGES_LIMIT pages. A page that fails ends the reading with the comments
 * read so far, so one long history does not cost the panel its other data; a
 * rate limit still stops the whole read so the host backs off.
 */
async function readRemainingNotes(host, detail, context) {
    for (let page = 1; detail.cursor && page < NOTE_PAGES_LIMIT; page += 1) {
        const query = `query { project(fullPath: ${JSON.stringify(detail.projectPath)}) { ` +
            `mergeRequest(iid: "${String(detail.number)}") { ${notesConnection(detail.cursor)} } } }`;
        let notes;
        try {
            const { data } = await runGraphql(context.call, host, query, context.nowMs());
            notes = asRecord(asRecord(asRecord(data['project'])?.['mergeRequest'])?.['notes']);
        }
        catch (error) {
            if (error instanceof CodeHostRequestError && error.kind === 'rate_limited')
                throw error;
            return;
        }
        detail.notes.push(...nodesOf(notes));
        detail.cursor = nextCursor(notes);
    }
}
function toSnapshot(host, projectPath, node) {
    const number = Number(asString(node['iid']));
    if (!Number.isSafeInteger(number) || number <= 0)
        return undefined;
    const ref = { platform: 'gitlab', host, projectPath, number };
    const signals = readSignals(node);
    const pipelineNode = asRecord(node['headPipeline']);
    const approved = node['approved'];
    return {
        ref,
        webUrl: asString(node['webUrl']) ?? mergeRequestWebUrl(ref),
        title: asString(node['title']) ?? '',
        state: signals.state,
        draft: signals.draft,
        ...deriveStatus(signals),
        hasConflicts: signals.conflict,
        ...definedFields({
            platformStatus: asString(node['detailedMergeStatus']),
            sourceBranch: asString(node['sourceBranch']),
            targetBranch: asString(node['targetBranch']),
            headSha: asString(node['diffHeadSha']),
            authorLogin: asString(asRecord(node['author'])?.['username']),
            updatedAtMs: parseTimeMs(node['updatedAt']),
            pipeline: pipelineNode && signals.pipeline
                ? toPipeline(host, pipelineNode, signals.pipeline)
                : undefined,
        }),
        ...summaryExtras(node),
        review: {
            ...definedFields({
                approved: typeof approved === 'boolean' ? approved : undefined,
                approvalsRequired: asNumber(node['approvalsRequired']),
                approvalsLeft: asNumber(node['approvalsLeft']),
            }),
            changesRequested: signals.changesRequested,
            unresolvedDiscussionCount: signals.unresolvedDiscussions,
        },
    };
}
/** Summary fields shown on the card without a status signal of their own. */
function summaryExtras(node) {
    const stats = asRecord(node['diffStatsSummary']);
    const permissions = asRecord(node['userPermissions']);
    return definedFields({
        createdAtMs: parseTimeMs(node['createdAt']),
        authorName: asString(asRecord(node['author'])?.['name']),
        diffStats: someFields({
            fileCount: asNumber(stats?.['fileCount']),
            additions: asNumber(stats?.['additions']),
            deletions: asNumber(stats?.['deletions']),
        }),
        behindTarget: asBoolean(node['divergedFromTargetBranch']),
        permissions: someFields({
            canMerge: asBoolean(permissions?.['canMerge']),
            canUpdate: asBoolean(permissions?.['updateMergeRequest']),
        }),
        platformIds: someFields({
            headPipelineId: lastSegment(asString(asRecord(node['headPipeline'])?.['id'])),
        }),
    });
}
function readSignals(node) {
    const detailed = asString(node['detailedMergeStatus']);
    const pipelineNode = asRecord(node['headPipeline']);
    return {
        state: gitLabState(asString(node['state'])),
        draft: node['draft'] === true,
        conflict: node['conflicts'] === true || detailed === 'CONFLICT',
        ...(pipelineNode
            ? { pipeline: CHECK_STATUS[asString(pipelineNode['status']) ?? ''] ?? 'unknown' }
            : {}),
        changesRequested: detailed === 'REQUESTED_CHANGES',
        unresolvedDiscussions: unresolvedThreads(node, detailed),
        approvalRequired: (asNumber(node['approvalsLeft']) ?? 0) > 0 || detailed === 'NOT_APPROVED',
        needRebase: detailed === 'NEED_REBASE',
        checking: detailed !== undefined && CHECKING_STATUSES.has(detailed),
        platformMergeable: detailed === 'MERGEABLE',
    };
}
/**
 * Open threads among the newest 100. System notes are threads too and take some
 * of those places, so an older open thread can fall outside; where the project
 * requires resolved threads, GitLab's own status still says at least one is open.
 */
function unresolvedThreads(node, detailed) {
    const counted = nodesOf(node['discussions']).filter(isUnresolved).length;
    return detailed === 'DISCUSSIONS_NOT_RESOLVED' ? Math.max(counted, 1) : counted;
}
function isUnresolved(discussion) {
    return discussion['resolvable'] === true && discussion['resolved'] !== true;
}
function toPipeline(host, node, status) {
    const path = asString(node['path']);
    const failed = asRecord(node['failed']);
    const failedCount = asNumber(failed?.['count']);
    const runningCount = asNumber(asRecord(node['running'])?.['count']);
    const passedCount = asNumber(asRecord(node['passed'])?.['count']);
    const failedJobs = nodesOf(failed).map((job) => toJob(host, job));
    return {
        status,
        ...(path ? { webUrl: `https://${host}${path}` } : {}),
        ...(failedCount !== undefined ? { failedCount } : {}),
        ...(runningCount !== undefined ? { runningCount } : {}),
        ...(passedCount !== undefined ? { passedCount } : {}),
        ...(failedJobs.length > 0 ? { failedJobs } : {}),
    };
}
function toDetails(host, detail) {
    const { node } = detail;
    const jobs = nodesOf(asRecord(asRecord(node['headPipeline'])?.['jobs'])).map((job) => toJob(host, job));
    return {
        jobs,
        discussions: gitLabThreads(detail.notes),
        // Whole: an edit saves what the panel shows. GitLab itself caps a description at 1 MB.
        ...definedFields({ description: asString(node['description']) }),
        reviewers: toReviewers(node),
        // GitLab lists a merge request's commits newest first.
        commits: nodesOf(node['commits']).flatMap(toCommit).reverse(),
    };
}
/** Reviewers with their answer, and approvers who were never asked as reviewers. */
function toReviewers(node) {
    const reviewers = new Map();
    for (const reviewer of nodesOf(node['reviewers'])) {
        const interaction = asRecord(reviewer['mergeRequestInteraction']);
        const state = interaction?.['approved'] === true
            ? 'approved'
            : (REVIEW_STATES[asString(interaction?.['reviewState']) ?? ''] ?? 'requested');
        addReviewer(reviewers, reviewer, state);
    }
    for (const approver of nodesOf(node['approvedBy']))
        addReviewer(reviewers, approver, 'approved');
    return [...reviewers.values()];
}
function addReviewer(reviewers, user, state) {
    const login = asString(user['username']);
    if (login)
        reviewers.set(login, { login, ...definedFields({ name: asString(user['name']) }), state });
}
function toCommit(node) {
    const sha = asString(node['sha']);
    if (!sha)
        return [];
    return [
        {
            sha,
            ...definedFields({
                title: asString(node['title']),
                authorName: asString(node['authorName']),
                authoredAtMs: parseTimeMs(node['authoredDate']),
                webUrl: asString(node['webUrl']),
            }),
        },
    ];
}
function toJob(host, node) {
    const rawId = asString(node['id']) ?? '';
    const id = /(\d+)$/u.exec(rawId)?.[1] ?? rawId;
    const webPath = asString(node['webPath']);
    const allowFailure = node['allowFailure'];
    const startedAtMs = parseTimeMs(node['startedAt']);
    return {
        id,
        name: asString(node['name']) ?? id,
        status: CHECK_STATUS[asString(node['status']) ?? ''] ?? 'unknown',
        ...definedFields({
            groupName: asString(asRecord(node['stage'])?.['name']),
            webUrl: webPath ? `https://${host}${webPath}` : undefined,
            allowFailure: typeof allowFailure === 'boolean' ? allowFailure : undefined,
            startedAtMs,
            finishedAtMs: parseTimeMs(node['finishedAt']),
        }),
        logAvailable: startedAtMs !== undefined,
    };
}
/**
 * The single method the project and the merge request settle on, read fresh
 * with the blockers: GitLab follows the merge request's own squash setting.
 */
async function readMergeOptions(ref, context) {
    const { data } = await runGraphql(context.call, ref.host, `query { project(fullPath: ${JSON.stringify(ref.projectPath)}) { ` +
        `mrs: mergeRequests(iids: ["${String(ref.number)}"], first: 1) { nodes { ${SUMMARY_FIELDS} ` +
        'squashOnMerge shouldRemoveSourceBranch forceRemoveSourceBranch } } } }', context.nowMs());
    const node = nodesOf(asRecord(asRecord(data['project'])?.['mrs']))[0];
    const snapshot = node ? toSnapshot(ref.host, ref.projectPath, node) : undefined;
    if (!node || !snapshot)
        throw new CodeHostRequestError('not_found', 'GitLab has no such merge request');
    const project = await readProjectSettings(ref.host, ref.projectPath, context.call);
    const method = mergeMethod(node['squashOnMerge'] === true, project.mergeMethod);
    const forced = node['forceRemoveSourceBranch'] === true;
    return {
        headSha: snapshot.headSha ?? '',
        methods: [method],
        defaultMethod: method,
        methodLocked: true,
        deleteSourceBranch: forced ||
            (asBoolean(node['shouldRemoveSourceBranch']) ?? project.removeSourceBranch ?? false),
        deleteSourceBranchLocked: forced,
        mergeQueue: false,
        blockers: refusalBlockers(snapshot),
    };
}
/** A squash wins over the project's method: it is the one change to history the user sees. */
function mergeMethod(squash, projectMethod) {
    if (squash)
        return 'squash';
    return projectMethod === 'ff' ? 'fast_forward' : 'merge';
}
async function readGitLabJobLog(ref, jobId, call, options) {
    if (!/^\d+$/u.test(jobId))
        throw new CodeHostRequestError('not_found', 'Unknown job');
    return readApiLog(call, {
        host: ref.host,
        apiPath: `projects/${encodeURIComponent(ref.projectPath)}/jobs/${jobId}/trace`,
        webUrl: `https://${ref.host}/${ref.projectPath}/-/jobs/${jobId}`,
        ...(options?.full ? { full: true } : {}),
    });
}
function probeGlab(host, call) {
    return probeCli('glab', /Logged in to \S+ as (\S+)/u, host, call);
}
//# sourceMappingURL=gitlab.js.map