/**
 * GitHub requests the user asks for one at a time: diffs, writes, reviewer and
 * link lookups. Review threads, conversation comments and review summaries are
 * mapped here because both the details read and the thread writes return them.
 */
import { asBoolean, asNumber, asRecord, asString, callApi, definedFields, graphqlFailure, jsonBody, limitBody, mutationPayload, nodesOf, parseTimeMs, rankCandidates, readPatch, recordsOf, relabelFailure, runGraphql, } from './adapter.js';
import { CodeHostRequestError } from './cli-runner.js';
import { mergeRequestWebUrl } from './urls.js';
export const GITHUB_AUTHOR_FIELDS = 'author { login ... on User { name } }';
export const GITHUB_THREAD_FIELDS = 'id isResolved isOutdated path line originalLine diffSide viewerCanReply viewerCanResolve viewerCanUnresolve ' +
    `comments(first: 100) { nodes { fullDatabaseId body createdAt url diffHunk ${GITHUB_AUTHOR_FIELDS} } }`;
export const GITHUB_COMMENT_FIELDS = `fullDatabaseId body createdAt url ${GITHUB_AUTHOR_FIELDS}`;
export const GITHUB_REVIEW_FIELDS = `fullDatabaseId body state createdAt submittedAt url ${GITHUB_AUTHOR_FIELDS}`;
/** GitHub's file list stops at 3,000 files. */
const FILES_PER_PAGE = 100;
const FILES_LIMIT = 3_000;
const MERGE_METHODS = { merge: 'MERGE', squash: 'SQUASH', rebase: 'REBASE' };
/** Conclusions "Re-run failed jobs" runs again. */
const FAILED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'CANCELLED']);
const FILE_KINDS = {
    added: 'added',
    removed: 'deleted',
    renamed: 'renamed',
    copied: 'added',
};
const CANDIDATE_FIELDS = 'number title url state isDraft headRefName baseRefName updatedAt author { login } repository { nameWithOwner }';
const HEAD_MOVED = /head branch was modified/iu;
export function gitHubActions(nowMs) {
    const context = (call) => ({ call, nowMs });
    return {
        changes: (ref, call) => readChanges(ref, context(call)),
        merge: (ref, input, _snapshot, call) => merge(ref, input, context(call)),
        retry: (ref, jobIds, _snapshot, call) => retry(ref, jobIds, context(call)),
        reply: (ref, discussionId, body, call) => reply(ref, { discussionId, body }, context(call)),
        resolve: (ref, discussionId, resolved, call) => resolve(ref, { discussionId, resolved }, context(call)),
        comment: (ref, body, call) => comment(ref, body, call),
        update: (ref, change, snapshot, call) => update(ref, { change, snapshot }, context(call)),
        searchReviewers: (ref, query, call) => searchReviewers(ref, query, context(call)),
        projectDefaults: (host, projectPath, call) => projectDefaults({ host, projectPath }, context(call)),
        create: (host, projectPath, input, call) => create({ host, projectPath }, input, call),
        suggestions: (scope, call) => suggestions(scope, context(call)),
        search: (scope, words, call) => search(scope, words, context(call)),
    };
}
// ---- Threads, conversation comments and review summaries ----
export function gitHubThread(node) {
    const comments = nodesOf(node['comments']);
    const first = comments[0];
    const id = asString(node['id']);
    if (!first || !id)
        return undefined;
    const resolved = node['isResolved'] === true;
    return {
        id,
        resolved,
        resolvable: true,
        notes: comments.map(toNote),
        ...definedFields({ path: asString(node['path']) }),
        ...linesOf(node),
        ...definedFields({
            diffHunk: asString(first['diffHunk']),
            outdated: asBoolean(node['isOutdated']),
            webUrl: asString(first['url']),
            canReply: asBoolean(node['viewerCanReply']),
            canResolve: asBoolean(resolved ? node['viewerCanUnresolve'] : node['viewerCanResolve']),
        }),
    };
}
/** The line a thread points at; an outdated thread only knows the line it was made on. */
function linesOf(node) {
    const line = asNumber(node['line']) ?? asNumber(node['originalLine']);
    if (line === undefined)
        return {};
    return node['diffSide'] === 'LEFT' ? { oldLine: line } : { newLine: line };
}
/** A conversation comment: outside any thread, so GitHub cannot reply to it or resolve it. */
export function gitHubConversationComment(node) {
    return standalone('comment', node);
}
/** A review's summary text; reviews without one only carry thread comments. */
export function gitHubReviewSummary(node) {
    // A pending review is the account's own unsent draft.
    if (!asString(node['body']) || node['state'] === 'PENDING')
        return undefined;
    return standalone('review', node);
}
function standalone(kind, node) {
    const id = databaseId(node);
    if (!id)
        return undefined;
    return {
        id: `${kind}:${id}`,
        resolved: false,
        resolvable: false,
        notes: [toNote(node)],
        ...definedFields({ webUrl: asString(node['url']) }),
        canReply: false,
        canResolve: false,
    };
}
/** Oldest first by the note that opens each discussion. */
export function byFirstNote(a, b) {
    return (a.notes[0]?.createdAtMs ?? 0) - (b.notes[0]?.createdAtMs ?? 0);
}
function toNote(node) {
    const author = asRecord(node['author']);
    return {
        id: databaseId(node) ?? asString(node['id']) ?? '',
        ...definedFields({
            authorLogin: asString(author?.['login']),
            authorName: asString(author?.['name']),
        }),
        ...limitBody(node['body']),
        ...definedFields({
            createdAtMs: parseTimeMs(node['submittedAt'] ?? node['createdAt']),
            webUrl: asString(node['url']),
        }),
    };
}
/** `fullDatabaseId` is a BigInt, which GitHub sends as a string. */
function databaseId(node) {
    const value = node['fullDatabaseId'] ?? node['databaseId'];
    return typeof value === 'number' ? String(value) : asString(value);
}
export function gitHubState(value) {
    if (value === 'MERGED')
        return 'merged';
    if (value === 'CLOSED')
        return 'closed';
    return 'open';
}
/** owner and name of an owner/repo path. */
export function splitRepository(projectPath) {
    const slash = projectPath.indexOf('/');
    return { owner: projectPath.slice(0, slash), name: projectPath.slice(slash + 1) };
}
function graphql(ref, query, context) {
    return runGraphql(context.call, ref.host, query, context.nowMs());
}
/** One pull request's fields, or not_found when the account cannot see it. */
async function readPullRequest(ref, fields, context) {
    const { owner, name } = splitRepository(ref.projectPath);
    const { data } = await graphql(ref, {
        query: 'query($owner: String!, $name: String!, $number: Int!) { ' +
            `repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${fields} } } }`,
        variables: { owner, name, number: ref.number },
    }, context);
    const node = asRecord(asRecord(data['repository'])?.['pullRequest']);
    if (!node)
        throw new CodeHostRequestError('not_found', 'GitHub has no such pull request');
    return node;
}
function pullRequestApiPath(ref) {
    return `repos/${ref.projectPath}/pulls/${String(ref.number)}`;
}
// ---- Changes ----
async function readChanges(ref, context) {
    const head = await readPullRequest(ref, 'headRefOid changedFiles', context);
    const items = [];
    for (let page = 1; items.length < FILES_LIMIT; page += 1) {
        const response = await callApi(context.call, {
            host: ref.host,
            path: `${pullRequestApiPath(ref)}/files?per_page=${String(FILES_PER_PAGE)}&page=${String(page)}`,
        });
        const batch = recordsOf(jsonBody(response));
        items.push(...batch);
        if (batch.length < FILES_PER_PAGE)
            break;
    }
    const files = items.slice(0, FILES_LIMIT).map(toFileChange);
    return {
        files,
        truncated: items.length > files.length || files.length < (asNumber(head['changedFiles']) ?? 0),
        ...definedFields({ headSha: asString(head['headRefOid']) }),
    };
}
function toFileChange(item) {
    const status = asString(item['status']) ?? 'modified';
    const kind = FILE_KINDS[status] ?? 'modified';
    return {
        path: asString(item['filename']) ?? '',
        kind,
        ...(kind === 'renamed' ? definedFields({ oldPath: asString(item['previous_filename']) }) : {}),
        ...patchOf(item, status),
    };
}
/**
 * GitHub leaves the patch out of a binary file and of a diff too large to show,
 * and a pure rename or mode change has none; only the changed-line count tells
 * a large diff from a binary file.
 */
function patchOf(item, status) {
    const counts = definedFields({
        additions: asNumber(item['additions']),
        deletions: asNumber(item['deletions']),
    });
    const patch = asString(item['patch']);
    if (patch)
        return { ...counts, patch: readPatch(patch).patch ?? patch };
    if ((asNumber(item['changes']) ?? 0) > 0)
        return { ...counts, tooLarge: true };
    return status === 'added' || status === 'removed' || status === 'modified'
        ? { binary: true }
        : {};
}
// ---- Merge ----
/**
 * Merges at the confirmed head, or adds the pull request to the base branch's
 * merge queue. After a direct merge the head branch goes when asked, unless it
 * lives in a fork.
 */
async function merge(ref, input, context) {
    const pullRequest = await readPullRequest(ref, 'id headRefOid headRefName isMergeQueueEnabled headRepository { nameWithOwner }', context);
    const id = asString(pullRequest['id']);
    if (!id)
        throw new CodeHostRequestError('not_found', 'GitHub has no such pull request');
    if (asString(pullRequest['headRefOid']) !== input.expectedHeadSha)
        throw new CodeHostRequestError('head_changed', 'New commits arrived after the merge was confirmed');
    if (pullRequest['isMergeQueueEnabled'] === true) {
        await mergeMutation(ref, enqueueDocument(id, input), context);
        return { queued: true };
    }
    await mergeMutation(ref, mergeDocument(id, input), context);
    const headRepository = asString(asRecord(pullRequest['headRepository'])?.['nameWithOwner']);
    if (input.deleteSourceBranch === true &&
        headRepository?.toLowerCase() === ref.projectPath.toLowerCase())
        await deleteBranch(ref, asString(pullRequest['headRefName']), context.call);
    return { queued: false };
}
function mergeDocument(id, input) {
    if (input.method === 'fast_forward')
        throw new CodeHostRequestError('not_mergeable', 'GitHub cannot fast-forward a pull request');
    const method = input.method ? MERGE_METHODS[input.method] : undefined;
    return {
        query: `mutation($id: ID!, $head: GitObjectID!${method ? ', $method: PullRequestMergeMethod!' : ''}) { ` +
            `mergePullRequest(input: {pullRequestId: $id, expectedHeadOid: $head${method ? ', mergeMethod: $method' : ''}}) { ` +
            'pullRequest { merged } } }',
        variables: { id, head: input.expectedHeadSha, ...(method ? { method } : {}) },
    };
}
function enqueueDocument(id, input) {
    return {
        query: 'mutation($id: ID!, $head: GitObjectID!) { ' +
            'enqueuePullRequest(input: {pullRequestId: $id, expectedHeadOid: $head}) { mergeQueueEntry { id } } }',
        variables: { id, head: input.expectedHeadSha },
    };
}
/** "Head branch was modified" means the head moved; any other refusal is the platform's reason. */
async function mergeMutation(ref, document, context) {
    const { data, errors } = await graphql(ref, document, context);
    const field = Object.keys(data)[0] ?? '';
    if (asRecord(data[field]))
        return;
    throw mergeFailure(errors);
}
function mergeFailure(errors) {
    const moved = errors.find((error) => HEAD_MOVED.test(error.message));
    if (moved)
        return new CodeHostRequestError('head_changed', moved.message);
    return graphqlFailure(errors, 'not_mergeable');
}
/**
 * Best effort: the merge already happened. GitHub may have deleted the branch
 * itself ("Reference does not exist") or protect it; the panel shows the
 * branch's state either way.
 */
async function deleteBranch(ref, branch, call) {
    if (!branch)
        return;
    const path = branch.split('/').map(encodeURIComponent).join('/');
    try {
        await callApi(call, {
            host: ref.host,
            method: 'DELETE',
            path: `repos/${ref.projectPath}/git/refs/heads/${path}`,
        });
    }
    catch {
        // See above: deleting the branch never turns a merge into a failure.
    }
}
// ---- Retry ----
const RETRY_REFUSALS = [
    { statuses: [403, 422], pattern: /re-?run|retry|cannot|unable/iu, kind: 'cannot_retry' },
    { statuses: [404], kind: 'cannot_retry' },
    { statuses: [403], kind: 'forbidden' },
];
/**
 * Only GitHub Actions jobs run again on request: a commit status or another
 * app's check run belongs to a CI that GitHub cannot start.
 */
async function retry(ref, jobIds, context) {
    const checks = await readHeadChecks(ref, context);
    const paths = jobIds.length > 0
        ? jobIds.map((id) => `actions/jobs/${actionsJobId(id, checks)}/rerun`)
        : failedRunPaths(checks);
    for (const path of paths) {
        try {
            await callApi(context.call, {
                host: ref.host,
                method: 'POST',
                path: `repos/${ref.projectPath}/${path}`,
            });
        }
        catch (error) {
            throw relabelFailure(error, RETRY_REFUSALS);
        }
    }
}
function actionsJobId(id, checks) {
    const check = checks.get(id);
    if (!/^\d+$/u.test(id) || (check && !check.actions))
        throw new CodeHostRequestError('cannot_retry', 'Only GitHub Actions jobs can run again from MCode');
    return id;
}
/** "Re-run failed jobs" once per workflow run that has a failed job. */
function failedRunPaths(checks) {
    const runs = new Set();
    for (const check of checks.values()) {
        if (check.failed && check.actions && check.runId)
            runs.add(check.runId);
    }
    if (runs.size === 0)
        throw new CodeHostRequestError('cannot_retry', 'No failed GitHub Actions job to run again');
    return [...runs].map((run) => `actions/runs/${run}/rerun-failed-jobs`);
}
async function readHeadChecks(ref, context) {
    const node = await readPullRequest(ref, 'commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { ' +
        '__typename ... on CheckRun { databaseId conclusion checkSuite { app { slug } workflowRun { databaseId } } } ' +
        '} } } } } }', context);
    const commit = asRecord(nodesOf(node['commits'])[0]?.['commit']);
    const contexts = asRecord(asRecord(commit?.['statusCheckRollup'])?.['contexts']);
    const checks = new Map();
    for (const check of nodesOf(contexts)) {
        const id = asNumber(check['databaseId']);
        if (check['__typename'] !== 'CheckRun' || id === undefined)
            continue;
        const suite = asRecord(check['checkSuite']);
        const runId = asNumber(asRecord(suite?.['workflowRun'])?.['databaseId']);
        checks.set(String(id), {
            id: String(id),
            actions: asString(asRecord(suite?.['app'])?.['slug']) === 'github-actions',
            failed: FAILED_CONCLUSIONS.has(asString(check['conclusion']) ?? ''),
            ...(runId === undefined ? {} : { runId: String(runId) }),
        });
    }
    return checks;
}
// ---- Thread writes ----
function threadIdOf(discussionId) {
    if (discussionId.startsWith('comment:') || discussionId.startsWith('review:'))
        throw new CodeHostRequestError('not_found', 'GitHub has no thread for a conversation comment or a review summary; comment on the pull request instead');
    return discussionId;
}
/** Replies, then reads the thread back: the reply's payload holds only the new comment. */
async function reply(ref, input, context) {
    const thread = threadIdOf(input.discussionId);
    const outcome = await graphql(ref, {
        query: 'mutation($thread: ID!, $body: String!) { ' +
            'addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $thread, body: $body}) { ' +
            `comment { ${GITHUB_COMMENT_FIELDS} } } }`,
        variables: { thread, body: input.body },
    }, context);
    const added = asRecord(mutationPayload(outcome, 'addPullRequestReviewThreadReply')['comment']);
    try {
        return await readThread(ref, thread, context);
    }
    catch {
        // The reply is posted: show it on its own until the details are read again.
        return {
            id: thread,
            resolved: false,
            resolvable: true,
            notes: added ? [toNote(added)] : [],
            canReply: true,
        };
    }
}
async function readThread(ref, threadId, context) {
    const { data } = await graphql(ref, {
        query: `query($id: ID!) { node(id: $id) { ... on PullRequestReviewThread { ${GITHUB_THREAD_FIELDS} } } }`,
        variables: { id: threadId },
    }, context);
    const thread = gitHubThread(asRecord(data['node']) ?? {});
    if (!thread)
        throw new CodeHostRequestError('not_found', 'GitHub has no such thread');
    return thread;
}
async function resolve(ref, input, context) {
    const thread = threadIdOf(input.discussionId);
    const field = input.resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
    const outcome = await graphql(ref, {
        query: `mutation($thread: ID!) { ${field}(input: {threadId: $thread}) { thread { ${GITHUB_THREAD_FIELDS} } } }`,
        variables: { thread },
    }, context);
    const resolved = gitHubThread(asRecord(mutationPayload(outcome, field)['thread']) ?? {});
    if (!resolved)
        throw new CodeHostRequestError('upstream', 'GitHub returned no thread');
    return resolved;
}
/** A conversation comment; the REST answer is the whole of it, without the author's name. */
async function comment(ref, body, call) {
    const response = await callApi(call, {
        host: ref.host,
        method: 'POST',
        path: `repos/${ref.projectPath}/issues/${String(ref.number)}/comments`,
        fields: { body },
    });
    const created = asRecord(jsonBody(response));
    const discussion = created
        ? gitHubConversationComment({
            databaseId: created['id'],
            body: created['body'],
            createdAt: created['created_at'],
            url: created['html_url'],
            author: { login: asRecord(created['user'])?.['login'] },
        })
        : undefined;
    if (!discussion)
        throw new CodeHostRequestError('upstream', 'GitHub returned no comment');
    return discussion;
}
// ---- Update ----
/** Title, description and state in one REST update, then the draft flag and reviewers. */
async function update(ref, input, context) {
    const { change } = input;
    const fields = definedFields({
        title: change.title,
        body: change.description,
        state: change.stateEvent && (change.stateEvent === 'close' ? 'closed' : 'open'),
    });
    if (Object.keys(fields).length > 0)
        await callApi(context.call, {
            host: ref.host,
            method: 'PATCH',
            path: pullRequestApiPath(ref),
            fields,
        });
    if (change.draft !== undefined)
        await setDraft(ref, { draft: change.draft, snapshot: input.snapshot }, context);
    if (change.addReviewers && change.addReviewers.length > 0)
        await requestReviews(ref, change.addReviewers, context.call);
}
async function setDraft(ref, input, context) {
    const id = input.snapshot?.platformIds?.nodeId ??
        asString((await readPullRequest(ref, 'id', context))['id']);
    if (!id)
        throw new CodeHostRequestError('not_found', 'GitHub has no such pull request');
    const field = input.draft ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview';
    const outcome = await graphql(ref, {
        query: `mutation($id: ID!) { ${field}(input: {pullRequestId: $id}) { pullRequest { isDraft } } }`,
        variables: { id },
    }, context);
    mutationPayload(outcome, field);
}
/** People by login; a team as org/team-slug, the way GitHub names it. */
async function requestReviews(ref, logins, call) {
    const teams = logins.flatMap((login) => login.includes('/') ? [login.slice(login.indexOf('/') + 1)] : []);
    const users = logins.filter((login) => !login.includes('/'));
    await callApi(call, {
        host: ref.host,
        method: 'POST',
        path: `${pullRequestApiPath(ref)}/requested_reviewers`,
        fields: {
            ...(users.length > 0 ? { reviewers: users } : {}),
            ...(teams.length > 0 ? { team_reviewers: teams } : {}),
        },
    });
}
// ---- Reviewers and project defaults ----
async function searchReviewers(ref, query, context) {
    const words = query.trim();
    const { owner, name } = splitRepository(ref.projectPath);
    const { data } = await graphql(ref, {
        query: `query($owner: String!, $name: String!${words ? ', $search: String!' : ''}) { ` +
            'repository(owner: $owner, name: $name) { ' +
            `assignableUsers(${words ? 'query: $search, ' : ''}first: 20) { nodes { login name } } } }`,
        variables: { owner, name, ...(words ? { search: words } : {}) },
    }, context);
    return nodesOf(asRecord(data['repository'])?.['assignableUsers']).flatMap((user) => {
        const login = asString(user['login']);
        return login ? [{ login, ...definedFields({ name: asString(user['name']) }) }] : [];
    });
}
async function projectDefaults(project, context) {
    const { owner, name } = splitRepository(project.projectPath);
    const { data } = await graphql(project, {
        query: 'query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { defaultBranchRef { name } } }',
        variables: { owner, name },
    }, context);
    const repository = asRecord(data['repository']);
    if (!repository)
        throw new CodeHostRequestError('not_found', 'GitHub has no such repository');
    return definedFields({
        defaultBranch: asString(asRecord(repository['defaultBranchRef'])?.['name']),
    });
}
// ---- Create ----
const CREATE_REFUSALS = [
    { statuses: [422], pattern: /already exists/iu, kind: 'already_exists' },
];
async function create(project, input, call) {
    let created;
    try {
        const response = await callApi(call, {
            host: project.host,
            method: 'POST',
            path: `repos/${project.projectPath}/pulls`,
            fields: definedFields({
                head: input.sourceBranch,
                base: input.targetBranch,
                title: input.title,
                body: input.description,
                draft: input.draft,
            }),
        });
        created = asRecord(jsonBody(response));
    }
    catch (error) {
        throw relabelFailure(error, CREATE_REFUSALS);
    }
    const number = asNumber(created?.['number']);
    if (number === undefined)
        throw new CodeHostRequestError('upstream', 'GitHub returned no pull request');
    const ref = { platform: 'github', ...project, number };
    return { ref, webUrl: asString(created?.['html_url']) ?? mergeRequestWebUrl(ref) };
}
// ---- Link candidates ----
/** The account's open pull requests, the ones waiting for its review, and the repository's latest. */
async function suggestions(scope, context) {
    const recentlyUpdated = `pullRequests(states: OPEN, first: 20, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ${CANDIDATE_FIELDS} } }`;
    const repository = scope.projectPath ? splitRepository(scope.projectPath) : undefined;
    const inRepository = repository
        ? `repository(owner: ${JSON.stringify(repository.owner)}, name: ${JSON.stringify(repository.name)}) { ${recentlyUpdated} }`
        : '';
    const { data } = await graphql(scope, `query { viewer { login ${recentlyUpdated} } ` +
        'review: search(query: "is:pr is:open review-requested:@me", type: ISSUE, first: 10) { ' +
        `nodes { ... on PullRequest { ${CANDIDATE_FIELDS} } } } ${inRepository} }`, context);
    const viewer = asRecord(data['viewer']);
    const login = asString(viewer?.['login']);
    const own = (node) => repositoryOf(node)?.toLowerCase() === scope.projectPath?.toLowerCase()
        ? 'mine_in_repository'
        : 'mine';
    const recent = (node) => login && asString(asRecord(node['author'])?.['login']) === login
        ? 'mine_in_repository'
        : 'in_repository';
    return rankCandidates([
        ...candidates(scope.host, nodesOf(viewer?.['pullRequests']), own),
        ...candidates(scope.host, nodesOf(data['review']), () => 'review_requested'),
        ...candidates(scope.host, nodesOf(asRecord(data['repository'])?.['pullRequests']), recent),
    ]);
}
function repositoryOf(node) {
    return asString(asRecord(node['repository'])?.['nameWithOwner']);
}
function candidates(host, nodes, reason) {
    return nodes.flatMap((node) => {
        const candidate = toCandidate(host, node, reason(node));
        return candidate ? [candidate] : [];
    });
}
function toCandidate(host, node, reason) {
    const number = asNumber(node['number']);
    const projectPath = repositoryOf(node);
    if (number === undefined || !projectPath)
        return undefined;
    const ref = { platform: 'github', host, projectPath, number };
    return {
        ref,
        webUrl: asString(node['url']) ?? mergeRequestWebUrl(ref),
        reason,
        ...definedFields({
            title: asString(node['title']),
            state: gitHubState(asString(node['state'])),
            draft: asBoolean(node['isDraft']),
            authorLogin: asString(asRecord(node['author'])?.['login']),
            sourceBranch: asString(node['headRefName']),
            targetBranch: asString(node['baseRefName']),
            updatedAtMs: parseTimeMs(node['updatedAt']),
        }),
    };
}
/**
 * Title matches in the repository and among the account's own pull requests.
 * Each word is quoted, so "author:x" in the words is searched as text rather
 * than read as a qualifier.
 */
async function search(scope, words, context) {
    const terms = words
        .split(/\s+/u)
        .map((word) => word.replace(/["\\]/gu, ''))
        .filter((word) => word.length > 0)
        .map((word) => `"${word}"`)
        .join(' ');
    if (!terms)
        return [];
    const pullRequests = `nodes { ... on PullRequest { ${CANDIDATE_FIELDS} } }`;
    const inRepository = scope.projectPath
        ? `repo: search(query: $repo, type: ISSUE, first: 20) { ${pullRequests} } `
        : '';
    const { data } = await graphql(scope, {
        query: `query(${scope.projectPath ? '$repo: String!, ' : ''}$mine: String!) { ${inRepository}` +
            `mine: search(query: $mine, type: ISSUE, first: 10) { ${pullRequests} } }`,
        variables: {
            ...(scope.projectPath ? { repo: `repo:${scope.projectPath} is:pr in:title ${terms}` } : {}),
            mine: `is:pr author:@me in:title ${terms}`,
        },
    }, context);
    return rankCandidates([
        ...candidates(scope.host, nodesOf(data['repo']), () => 'search'),
        ...candidates(scope.host, nodesOf(data['mine']), () => 'search'),
    ]);
}
//# sourceMappingURL=github-actions.js.map