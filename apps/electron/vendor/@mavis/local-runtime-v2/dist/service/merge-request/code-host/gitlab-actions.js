/**
 * GitLab requests the user asks for one at a time: diffs, writes, reviewer and
 * link lookups. Threads are mapped here because both the details read and the
 * thread writes return them in one shape.
 */
import { asBoolean, asNumber, asRecord, asString, callApi, definedFields, gqlStringList, jsonBody, limitBody, mutationPayload, nodesOf, parseTimeMs, rankCandidates, readPatch, recordsOf, relabelFailure, runGraphql, } from './adapter.js';
import { CodeHostRequestError } from './cli-runner.js';
import { mergeRequestWebUrl, parseMergeRequestUrl } from './urls.js';
/** A note as the details read it and the thread writes return it. */
export const GITLAB_NOTE_FIELDS = 'id body createdAt url author { username name } position { filePath newLine oldLine } ' +
    'userPermissions { resolveNote createNote }';
/** A whole thread; its notes include system notes, which the mapping leaves out. */
const THREAD_FIELDS = `id resolved resolvable notes(first: 100) { nodes { ${GITLAB_NOTE_FIELDS} system } }`;
/** The IDL promises at most this many notes per thread. */
const NOTES_PER_THREAD = 100;
/**
 * Files per page of the diffs endpoint. gitlab.xaminim.com (17.1.8) answers
 * HTTP 500 at once for any per_page over 30 there, whatever the merge request.
 */
const DIFFS_PER_PAGE = 30;
const DIFF_FILES_LIMIT = 1_000;
/** Enough pages to see that a merge request has more files than are shown. */
const DIFF_PAGES_LIMIT = Math.floor(DIFF_FILES_LIMIT / DIFFS_PER_PAGE) + 1;
/** Pages read side by side once the first page says how many there are. */
const DIFF_PAGES_AT_ONCE = 4;
const BINARY_DIFF = /^Binary files /u;
const DISCUSSION_ID = /^[0-9a-f]+$/iu;
/** Prefixes GitLab reads as "draft" at the start of a title. */
const DRAFT_PREFIX = /^\s*(?:\[draft\]|\(draft\)|draft:|draft\s+-)\s*/iu;
const REVIEWER_RESULTS = 20;
const CANDIDATE_FIELDS = 'iid title state draft webUrl sourceBranch targetBranch updatedAt author { username } project { fullPath }';
export function gitLabActions(nowMs) {
    const context = (call) => ({ call, nowMs });
    return {
        changes: (ref, call) => readChanges(ref, context(call)),
        merge: (ref, input, _snapshot, call) => merge(ref, input, context(call)),
        retry: (ref, jobIds, snapshot, call) => retry(ref, { jobIds, snapshot }, context(call)),
        reply: (ref, discussionId, body, call) => reply(ref, { discussionId, body }, context(call)),
        resolve: (ref, discussionId, resolved, call) => resolve(ref, { discussionId, resolved }, context(call)),
        comment: (ref, body, call) => comment(ref, body, context(call)),
        update: (ref, change, snapshot, call) => update(ref, { change, snapshot }, context(call)),
        searchReviewers: (ref, query, call) => searchReviewers(ref, query, context(call)),
        projectDefaults: async (host, projectPath, call) => {
            const project = await readProjectSettings(host, projectPath, call);
            return projectDefaults(project);
        },
        create: (host, projectPath, input, call) => create({ host, projectPath }, input, call),
        suggestions: (scope, call) => suggestions(scope, context(call)),
        search: (scope, words, call) => search(scope, words, call),
    };
}
// ---- Threads ----
/**
 * Threads from comments read oldest first with \`notes(filter: ONLY_COMMENTS)\`,
 * each carrying its discussion: system notes never take a page slot, and a
 * thread's replies join it wherever they fall in the list.
 */
export function gitLabThreads(notes) {
    const threads = new Map();
    for (const note of notes) {
        const discussion = asRecord(note['discussion']);
        const id = asString(discussion?.['id']);
        if (!discussion || !id)
            continue;
        const thread = threads.get(id) ?? { discussion, notes: [] };
        thread.notes.push(note);
        threads.set(id, thread);
    }
    return [...threads.values()].flatMap((thread) => {
        const mapped = toThread(thread.discussion, thread.notes);
        return mapped ? [mapped] : [];
    });
}
/** A Discussion node read with THREAD_FIELDS. */
function toDiscussion(node) {
    const notes = nodesOf(node?.['notes']).filter((note) => note['system'] !== true);
    const thread = node ? toThread(node, notes) : undefined;
    if (!thread)
        throw new CodeHostRequestError('upstream', 'GitLab returned no thread');
    return thread;
}
function toThread(discussion, notes) {
    const first = notes[0];
    const id = lastSegment(asString(discussion['id']));
    if (!first || !id)
        return undefined;
    const resolvable = discussion['resolvable'] === true;
    const permissions = asRecord(first['userPermissions']);
    return {
        id,
        resolved: discussion['resolved'] === true,
        resolvable,
        notes: notes.slice(0, NOTES_PER_THREAD).map(toNote),
        ...positionOf(first),
        ...definedFields({
            webUrl: asString(first['url']),
            canReply: asBoolean(permissions?.['createNote']),
            canResolve: resolvable ? asBoolean(permissions?.['resolveNote']) : false,
        }),
    };
}
function positionOf(note) {
    const position = asRecord(note['position']);
    return definedFields({
        path: asString(position?.['filePath']),
        newLine: asNumber(position?.['newLine']),
        oldLine: asNumber(position?.['oldLine']),
    });
}
function toNote(node) {
    const author = asRecord(node['author']);
    return {
        id: lastSegment(asString(node['id'])) ?? '',
        ...definedFields({
            authorLogin: asString(author?.['username']),
            authorName: asString(author?.['name']),
        }),
        ...limitBody(node['body']),
        ...definedFields({
            createdAtMs: parseTimeMs(node['createdAt']),
            webUrl: asString(node['url']),
        }),
    };
}
/** The part after the last slash: the hex id of gid://gitlab/Discussion/<hex>, a note's number. */
export function lastSegment(value) {
    if (!value)
        return undefined;
    return value.slice(value.lastIndexOf('/') + 1) || undefined;
}
export function gitLabState(value) {
    if (value === 'merged')
        return 'merged';
    if (value === 'closed')
        return 'closed';
    return 'open';
}
function projectApiPath(projectPath) {
    return `projects/${encodeURIComponent(projectPath)}`;
}
function mergeRequestApiPath(ref) {
    return `${projectApiPath(ref.projectPath)}/merge_requests/${String(ref.number)}`;
}
function graphql(ref, query, context) {
    return runGraphql(context.call, ref.host, query, context.nowMs());
}
/** One merge request's fields, or not_found when the account cannot see it. */
async function readMergeRequest(ref, fields, context) {
    const { data } = await graphql(ref, `query { project(fullPath: ${JSON.stringify(ref.projectPath)}) { mergeRequest(iid: "${String(ref.number)}") { ${fields} } } }`, context);
    const node = asRecord(asRecord(data['project'])?.['mergeRequest']);
    if (!node)
        throw new CodeHostRequestError('not_found', 'GitLab has no such merge request');
    return node;
}
// ---- Changes ----
async function readChanges(ref, context) {
    // The diff head is the version the diffs endpoint lists, which the source branch can be ahead of.
    const [head, { items, overflow }] = await Promise.all([
        readMergeRequest(ref, 'diffHeadSha diffStatsSummary { fileCount }', context),
        readDiffItems(ref, context.call),
    ]);
    const files = items.slice(0, DIFF_FILES_LIMIT).map(toFileChange);
    const fileCount = asNumber(asRecord(head['diffStatsSummary'])?.['fileCount']);
    return {
        files,
        truncated: overflow || items.length > files.length || files.length < (fileCount ?? 0),
        ...definedFields({ headSha: asString(head['diffHeadSha']) }),
    };
}
async function readDiffItems(ref, call) {
    try {
        return { items: await readDiffPages(ref, call), overflow: false };
    }
    catch (error) {
        if (!(error instanceof CodeHostRequestError) || error.kind !== 'not_found')
            throw error;
        // GitLab before 15.7 has no diffs endpoint; its predecessor answers in one response.
        const body = asRecord(jsonBody(await callApi(call, { host: ref.host, path: `${mergeRequestApiPath(ref)}/changes` })));
        return { items: recordsOf(body?.['changes']), overflow: body?.['overflow'] === true };
    }
}
/**
 * Every page of the diffs endpoint. The first page says how many there are, so
 * the rest are read a few at a time instead of one after another: 197 files
 * took 7 requests in a row.
 */
async function readDiffPages(ref, call) {
    const first = await readDiffPage(ref, call, 1);
    const items = [...first.items];
    const pages = Math.min(Number(first.headers['x-total-pages']), DIFF_PAGES_LIMIT);
    if (!Number.isSafeInteger(pages))
        return readNextDiffPages(ref, call, first);
    for (let start = 2; start <= pages; start += DIFF_PAGES_AT_ONCE) {
        const numbers = Array.from({ length: Math.min(DIFF_PAGES_AT_ONCE, pages - start + 1) }, (_, index) => start + index);
        const batches = await Promise.all(numbers.map((page) => readDiffPage(ref, call, page)));
        for (const batch of batches)
            items.push(...batch.items);
    }
    return items;
}
/** Without a page count, follows the next pages one at a time. */
async function readNextDiffPages(ref, call, first) {
    const items = [...first.items];
    let last = first;
    for (let page = 2; items.length <= DIFF_FILES_LIMIT && hasNextPage(last); page += 1) {
        last = await readDiffPage(ref, call, page);
        items.push(...last.items);
    }
    return items;
}
async function readDiffPage(ref, call, page) {
    const response = await callApi(call, {
        host: ref.host,
        path: `${mergeRequestApiPath(ref)}/diffs?per_page=${String(DIFFS_PER_PAGE)}&page=${String(page)}`,
    });
    return { items: recordsOf(jsonBody(response)), headers: response.headers };
}
function hasNextPage(page) {
    return page.items.length >= DIFFS_PER_PAGE && page.headers['x-next-page'] !== '';
}
function toFileChange(item) {
    const kind = changeKind(item);
    const newPath = asString(item['new_path']) ?? '';
    const oldPath = asString(item['old_path']) ?? newPath;
    return {
        path: kind === 'deleted' ? oldPath : newPath,
        kind,
        ...(kind === 'renamed' ? { oldPath } : {}),
        ...diffOf(item, kind),
    };
}
function changeKind(item) {
    if (item['new_file'] === true)
        return 'added';
    if (item['deleted_file'] === true)
        return 'deleted';
    if (item['renamed_file'] === true)
        return 'renamed';
    return 'modified';
}
/**
 * GitLab sends a binary file's diff as "Binary files a and b differ" and one
 * past its size limits as an empty diff; newer versions also flag the latter.
 */
function diffOf(item, kind) {
    const diff = typeof item['diff'] === 'string' ? item['diff'] : '';
    if (BINARY_DIFF.test(diff))
        return { binary: true };
    // A mode change alone also comes without a diff; only a modified file with the same mode lost one.
    const omitted = diff === '' && kind === 'modified' && item['a_mode'] === item['b_mode'];
    if (item['too_large'] === true || item['collapsed'] === true || omitted)
        return { tooLarge: true };
    const { patch, additions, deletions } = readPatch(diff);
    return { additions, deletions, ...(patch ? { patch } : {}) };
}
// ---- Merge ----
const MERGE_REFUSALS = [
    { statuses: [409], pattern: /SHA does not match HEAD/iu, kind: 'head_changed' },
    { statuses: [401, 403], kind: 'forbidden' },
    { statuses: [405, 406, 409, 422], kind: 'not_mergeable' },
];
/**
 * Merges with the merge request's own squash setting and never asks for an
 * automatic merge. GitLab answers 200 only once it merged.
 */
async function merge(ref, input, context) {
    try {
        await callApi(context.call, {
            host: ref.host,
            method: 'PUT',
            path: `${mergeRequestApiPath(ref)}/merge`,
            fields: {
                sha: input.expectedHeadSha,
                ...(input.deleteSourceBranch === undefined
                    ? {}
                    : { should_remove_source_branch: input.deleteSourceBranch }),
            },
        });
        return { queued: false };
    }
    catch (error) {
        throw await explainRefusal(ref, input, relabelFailure(error, MERGE_REFUSALS), context);
    }
}
/**
 * GitLab checks mergeability before the SHA, so a push that started a new
 * pipeline is refused as not mergeable; the head tells the two apart.
 */
async function explainRefusal(ref, input, failure, context) {
    if (!(failure instanceof CodeHostRequestError) || failure.kind !== 'not_mergeable')
        return failure;
    try {
        const head = asString((await readMergeRequest(ref, 'diffHeadSha', context))['diffHeadSha']);
        if (head && head !== input.expectedHeadSha)
            return new CodeHostRequestError('head_changed', 'New commits arrived after the merge was confirmed');
    }
    catch {
        // The refusal itself is what the user needs to see.
    }
    return failure;
}
// ---- Retry ----
const RETRY_REFUSALS = [
    { statuses: [400, 403, 422], pattern: /retr(?:y|ied)/iu, kind: 'cannot_retry' },
    { statuses: [403], kind: 'forbidden' },
];
async function retry(ref, target, context) {
    const invalid = target.jobIds.find((id) => !/^\d+$/u.test(id));
    if (invalid !== undefined)
        throw new CodeHostRequestError('cannot_retry', `GitLab has no job ${invalid} to run again`);
    const project = projectApiPath(ref.projectPath);
    if (target.jobIds.length > 0) {
        for (const id of target.jobIds)
            await post(ref.host, `${project}/jobs/${id}/retry`, context.call);
        return;
    }
    const pipelineId = target.snapshot?.platformIds?.headPipelineId ?? (await readHeadPipelineId(ref, context));
    if (!pipelineId)
        throw new CodeHostRequestError('cannot_retry', 'This merge request has no pipeline to run again');
    await post(ref.host, `${project}/pipelines/${pipelineId}/retry`, context.call);
}
async function post(host, path, call) {
    try {
        await callApi(call, { host, method: 'POST', path });
    }
    catch (error) {
        throw relabelFailure(error, RETRY_REFUSALS);
    }
}
async function readHeadPipelineId(ref, context) {
    const node = await readMergeRequest(ref, 'headPipeline { id }', context);
    const id = lastSegment(asString(asRecord(node['headPipeline'])?.['id']));
    return id && /^\d+$/u.test(id) ? id : undefined;
}
// ---- Thread writes ----
/**
 * GraphQL rather than REST: the REST note a write returns carries no thread,
 * and GitLab 17.1 cannot read one thread back by id, while createNote and
 * discussionToggleResolve return the thread in the shape the details read.
 */
async function reply(ref, input, context) {
    const discussion = discussionGid(input.discussionId);
    const noteable = await readNoteableId(ref, context);
    return createNote(ref, {
        query: 'mutation($noteable: NoteableID!, $discussion: DiscussionID!, $body: String!) { ' +
            'createNote(input: {noteableId: $noteable, discussionId: $discussion, body: $body}) { ' +
            `errors note { discussion { ${THREAD_FIELDS} } } } }`,
        variables: { noteable, discussion, body: input.body },
    }, context);
}
async function comment(ref, body, context) {
    const noteable = await readNoteableId(ref, context);
    return createNote(ref, {
        query: 'mutation($noteable: NoteableID!, $body: String!) { ' +
            'createNote(input: {noteableId: $noteable, body: $body}) { ' +
            `errors note { discussion { ${THREAD_FIELDS} } } } }`,
        variables: { noteable, body },
    }, context);
}
async function createNote(ref, document, context) {
    const payload = mutationPayload(await graphql(ref, document, context), 'createNote');
    const note = asRecord(payload['note']);
    // A body of quick actions only runs them and keeps no note.
    if (!note)
        throw new CodeHostRequestError('upstream', 'GitLab ran the quick actions and kept no comment');
    return toDiscussion(asRecord(note['discussion']));
}
async function resolve(ref, input, context) {
    const outcome = await graphql(ref, {
        query: 'mutation($id: DiscussionID!, $resolve: Boolean!) { ' +
            'discussionToggleResolve(input: {id: $id, resolve: $resolve}) { ' +
            `errors discussion { ${THREAD_FIELDS} } } }`,
        variables: { id: discussionGid(input.discussionId), resolve: input.resolved },
    }, context);
    return toDiscussion(asRecord(mutationPayload(outcome, 'discussionToggleResolve')['discussion']));
}
function discussionGid(discussionId) {
    if (!DISCUSSION_ID.test(discussionId))
        throw new CodeHostRequestError('not_found', 'GitLab has no such thread');
    return `gid://gitlab/Discussion/${discussionId}`;
}
/** The merge request's global id, which createNote takes instead of the project and iid. */
async function readNoteableId(ref, context) {
    const id = asString((await readMergeRequest(ref, 'id', context))['id']);
    if (!id)
        throw new CodeHostRequestError('not_found', 'GitLab has no such merge request');
    return id;
}
// ---- Update ----
/**
 * Title, description and state in one REST update, then the draft flag and
 * reviewers through their mutations. GitLab reads "draft" from the title, so a
 * new title carries the draft state the merge request should end up in.
 */
async function update(ref, input, context) {
    const { change } = input;
    const fields = definedFields({
        title: change.title === undefined
            ? undefined
            : draftTitle(change.title, change.draft ?? input.snapshot?.draft),
        description: change.description,
        state_event: change.stateEvent,
    });
    if (Object.keys(fields).length > 0) {
        await callApi(context.call, {
            host: ref.host,
            method: 'PUT',
            path: mergeRequestApiPath(ref),
            fields,
        });
    }
    if (change.draft !== undefined && change.title === undefined)
        await setDraft(ref, change.draft, context);
    if (change.addReviewers && change.addReviewers.length > 0)
        await addReviewers(ref, change.addReviewers, context);
}
/** The title with GitLab's draft prefix added or removed; unchanged when the state is unknown. */
function draftTitle(title, draft) {
    if (draft === undefined)
        return title;
    let plain = title;
    while (DRAFT_PREFIX.test(plain))
        plain = plain.replace(DRAFT_PREFIX, '');
    return draft ? `Draft: ${plain}` : plain;
}
async function setDraft(ref, draft, context) {
    const outcome = await graphql(ref, {
        query: 'mutation($project: ID!, $iid: String!, $draft: Boolean!) { ' +
            'mergeRequestSetDraft(input: {projectPath: $project, iid: $iid, draft: $draft}) { errors } }',
        variables: { project: ref.projectPath, iid: String(ref.number), draft },
    }, context);
    mutationPayload(outcome, 'mergeRequestSetDraft');
}
/** Usernames go into the query as string literals: glab takes no list variable in a JSON body. */
async function addReviewers(ref, usernames, context) {
    const outcome = await graphql(ref, 'mutation { mergeRequestSetReviewers(input: {' +
        `projectPath: ${JSON.stringify(ref.projectPath)}, iid: "${String(ref.number)}", ` +
        `reviewerUsernames: ${gqlStringList(usernames)}, operationMode: APPEND}) { errors } }`, context);
    mutationPayload(outcome, 'mergeRequestSetReviewers');
}
// ---- Reviewers and project defaults ----
/** Active project members, people only: project and group access tokens are bot users. */
async function searchReviewers(ref, query, context) {
    const words = query.trim();
    const { data } = await graphql(ref, {
        query: `query($project: ID!${words ? ', $search: String!' : ''}) { project(fullPath: $project) { ` +
            `projectMembers(${words ? 'search: $search, ' : ''}first: 50) { ` +
            'nodes { user { username name state bot } } } } }',
        variables: { project: ref.projectPath, ...(words ? { search: words } : {}) },
    }, context);
    const users = new Map();
    for (const member of nodesOf(asRecord(asRecord(data['project'])?.['projectMembers']))) {
        const user = asRecord(member['user']);
        const login = asString(user?.['username']);
        if (!login || user?.['bot'] === true || user?.['state'] !== 'active')
            continue;
        users.set(login, { login, ...definedFields({ name: asString(user['name']) }) });
    }
    return [...users.values()].slice(0, REVIEWER_RESULTS);
}
/** Project settings GraphQL does not expose on 17.1: merge method and squash option. */
export async function readProjectSettings(host, projectPath, call) {
    const project = asRecord(jsonBody(await callApi(call, { host, path: projectApiPath(projectPath) })));
    return definedFields({
        defaultBranch: asString(project?.['default_branch']),
        mergeMethod: asString(project?.['merge_method']),
        squashOption: asString(project?.['squash_option']),
        removeSourceBranch: asBoolean(project?.['remove_source_branch_after_merge']),
    });
}
function projectDefaults(project) {
    return definedFields({
        defaultBranch: project.defaultBranch,
        squash: project.squashOption === undefined
            ? undefined
            : project.squashOption === 'always' || project.squashOption === 'default_on',
        deleteSourceBranch: project.removeSourceBranch,
    });
}
// ---- Create ----
const CREATE_REFUSALS = [
    { statuses: [409, 422], pattern: /already exists/iu, kind: 'already_exists' },
];
async function create(project, input, call) {
    let created;
    try {
        const response = await callApi(call, {
            host: project.host,
            method: 'POST',
            path: `${projectApiPath(project.projectPath)}/merge_requests`,
            fields: definedFields({
                source_branch: input.sourceBranch,
                target_branch: input.targetBranch,
                title: draftTitle(input.title, input.draft),
                description: input.description,
                squash: input.squash,
                remove_source_branch: input.deleteSourceBranch,
            }),
        });
        created = asRecord(jsonBody(response));
    }
    catch (error) {
        throw relabelFailure(error, CREATE_REFUSALS);
    }
    const number = asNumber(created?.['iid']);
    if (number === undefined)
        throw new CodeHostRequestError('upstream', 'GitLab returned no merge request');
    const ref = { platform: 'gitlab', ...project, number };
    return { ref, webUrl: asString(created?.['web_url']) ?? mergeRequestWebUrl(ref) };
}
// ---- Link candidates ----
/** The account's open merge requests, the ones waiting for its review, and the project's latest. */
async function suggestions(scope, context) {
    const project = scope.projectPath
        ? `project(fullPath: ${JSON.stringify(scope.projectPath)}) { ` +
            `mergeRequests(state: opened, first: 20, sort: UPDATED_DESC) { nodes { ${CANDIDATE_FIELDS} } } }`
        : '';
    const { data } = await graphql(scope, 'query { currentUser { username ' +
        `authored: authoredMergeRequests(state: opened, first: 20, sort: UPDATED_DESC) { nodes { ${CANDIDATE_FIELDS} } } ` +
        `review: reviewRequestedMergeRequests(state: opened, first: 10, sort: UPDATED_DESC) { nodes { ${CANDIDATE_FIELDS} } } } ` +
        `${project} }`, context);
    const user = asRecord(data['currentUser']);
    const login = asString(user?.['username']);
    const own = (node) => inScope(scope, node) ? 'mine_in_repository' : 'mine';
    const recent = (node) => login && asString(asRecord(node['author'])?.['username']) === login
        ? 'mine_in_repository'
        : 'in_repository';
    return rankCandidates([
        ...candidates(scope.host, nodesOf(user?.['authored']), own),
        ...candidates(scope.host, nodesOf(user?.['review']), () => 'review_requested'),
        ...candidates(scope.host, nodesOf(asRecord(data['project'])?.['mergeRequests']), recent),
    ]);
}
function inScope(scope, node) {
    const projectPath = asString(asRecord(node['project'])?.['fullPath']);
    return projectPath?.toLowerCase() === scope.projectPath?.toLowerCase();
}
function candidates(host, nodes, reason) {
    return nodes.flatMap((node) => {
        const projectPath = asString(asRecord(node['project'])?.['fullPath']);
        const candidate = projectPath
            ? toCandidate({ host, projectPath, iid: node['iid'] }, node, reason(node))
            : undefined;
        return candidate ? [candidate] : [];
    });
}
function toCandidate(where, node, reason) {
    const number = Number(where.iid);
    if (!Number.isSafeInteger(number) || number <= 0)
        return undefined;
    const ref = {
        platform: 'gitlab',
        host: where.host,
        projectPath: where.projectPath,
        number,
    };
    return {
        ref,
        webUrl: asString(node['webUrl'] ?? node['web_url']) ?? mergeRequestWebUrl(ref),
        reason,
        ...definedFields({
            title: asString(node['title']),
            state: gitLabState(asString(node['state'])),
            draft: asBoolean(node['draft']),
            authorLogin: asString(asRecord(node['author'])?.['username']),
            sourceBranch: asString(node['sourceBranch'] ?? node['source_branch']),
            targetBranch: asString(node['targetBranch'] ?? node['target_branch']),
            updatedAtMs: parseTimeMs(node['updatedAt'] ?? node['updated_at']),
        }),
    };
}
/**
 * Title matches in the project, in every state, and among the account's own
 * merge requests. REST: the GraphQL mergeRequests field takes no search on 17.1.
 */
async function search(scope, words, call) {
    const query = words.trim();
    if (!query)
        return [];
    const filter = `search=${encodeURIComponent(query)}&in=title&state=all&order_by=updated_at&sort=desc`;
    const paths = [
        ...(scope.projectPath
            ? [`${projectApiPath(scope.projectPath)}/merge_requests?${filter}&per_page=20`]
            : []),
        `merge_requests?scope=created_by_me&${filter}&per_page=10`,
    ];
    const found = [];
    for (const path of paths) {
        const items = recordsOf(jsonBody(await callApi(call, { host: scope.host, path })));
        found.push(...items.flatMap((item) => restCandidate(scope.host, item)));
    }
    return rankCandidates(found);
}
/** A REST merge request; its project path comes from "references.full" (group/project!iid). */
function restCandidate(host, item) {
    const reference = asString(asRecord(item['references'])?.['full']) ?? '';
    const bang = reference.lastIndexOf('!');
    const projectPath = bang > 0
        ? reference.slice(0, bang)
        : parseMergeRequestUrl(asString(item['web_url']) ?? '')?.projectPath;
    const candidate = projectPath
        ? toCandidate({ host, projectPath, iid: item['iid'] }, item, 'search')
        : undefined;
    return candidate ? [candidate] : [];
}
//# sourceMappingURL=gitlab-actions.js.map