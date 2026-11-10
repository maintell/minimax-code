import { CloudSessionReadError } from '@mavis/agent-tools/desktop';
import { logger } from '../../../../infra/logging/logger.js';
import { fromCloudReadError, remoteSessionError } from './device-source.js';
import { sessionActivityMs } from './wire-mapping.js';
/** The only agent whose sessions a Remote Control device lists (its sidebar). */
const RC_AGENT = 'mavis';
/** Server requests one list page may make before it hands back a cursor. */
const MAX_PROJECT_REQUESTS_PER_PAGE = 10;
export const PROJECT_CURSOR_PREFIX = 'rcp1.';
/**
 * A first project request that fails like this means the device predates the
 * project list (the Remote Control UI falls back on 404 / 501 as well); its
 * sidebar list is read instead.
 */
const PROJECT_LIST_UNSUPPORTED_CODES = new Set([
    'RC_UNKNOWN_DOWNSTREAM_ERROR',
    'UNSUPPORTED_COMMAND',
]);
/** The device answered the first project request like a build without the project list. */
export class ProjectListUnsupported extends Error {
    reason;
    constructor(reason) {
        super('Remote Control device has no project list');
        this.reason = reason;
        this.name = 'ProjectListUnsupported';
    }
}
/**
 * One list page from the device's paged project list. Projects are read one at
 * a time with `session_limit` set to the room left on the page, and a project
 * with more sessions continues through its own session cursor, so the device
 * decides every page boundary; nothing is cut here.
 */
export async function listProjectWalk(deps, request) {
    const { device, limit, start, signal } = request;
    const context = { deps, device, signal };
    const sessions = [];
    let next = start;
    let requests = 0;
    while (next && sessions.length < limit && requests < MAX_PROJECT_REQUESTS_PER_PAGE) {
        const room = limit - sessions.length;
        const step = next.project
            ? await continueProject(context, { ...next, project: next.project }, room)
            : await readNextProject(context, next, room, requests === 0 && !start.projects);
        requests += 1;
        sessions.push(...step.sessions);
        next = step.next;
    }
    return finishPage(device, sessions, next, requests);
}
async function continueProject(context, walk, room) {
    const { deps, device, signal } = context;
    const { project } = walk;
    const identity = project.workspaceDir
        ? { workspaceDir: project.workspaceDir }
        : { projectKey: project.projectKey };
    const page = await deps.call(device, (consumer, bindingId) => deps.reader.listProjectSessions(consumer, bindingId, { ...identity, agentName: RC_AGENT, limit: room, cursor: project.sessionCursor }, signal), signal);
    if (!page)
        throw staleProjectCursor();
    if (page.hasMore && page.nextCursor === project.sessionCursor)
        throw stalledPaging();
    const sessions = deps.toSessions(device, page.sessions);
    if (page.hasMore && page.nextCursor) {
        return { sessions, next: { ...walk, project: { ...project, sessionCursor: page.nextCursor } } };
    }
    return { sessions, next: walk.projects ? { projects: walk.projects } : undefined };
}
async function readNextProject(context, walk, room, first) {
    const { deps, device, signal } = context;
    const page = await deps.call(device, (consumer, bindingId) => deps.reader.listProjects(consumer, bindingId, {
        agentName: RC_AGENT,
        limit: 1,
        sessionLimit: room,
        ...(walk.projects ? { cursor: walk.projects } : {}),
    }, signal), signal, (error) => (first && projectListUnsupported(error)) || fromCloudReadError(error));
    if (!page)
        throw first ? new ProjectListUnsupported('not_found') : staleProjectCursor();
    if (page.hasMore && page.nextCursor === walk.projects)
        throw stalledPaging();
    return collectProjects(context, page);
}
/** Sessions of one projects page, and where the list goes on after it. */
function collectProjects(context, page) {
    const after = page.hasMore ? page.nextCursor : undefined;
    const sessions = [];
    let next = after ? { projects: after } : undefined;
    for (const [index, group] of page.projects.entries()) {
        sessions.push(...context.deps.toSessions(context.device, group.sessions));
        if (!group.hasMoreSessions || !group.nextSessionCursor)
            continue;
        // Only the last project of a page can continue; an earlier one would lose its rest.
        if (index !== page.projects.length - 1)
            throw invalidProjectPage();
        next = projectContinuation(group, group.nextSessionCursor, after);
    }
    return { sessions, next };
}
function projectContinuation(group, sessionCursor, after) {
    if (!group.workspaceDir && !group.projectKey)
        throw invalidProjectPage();
    return {
        ...(after ? { projects: after } : {}),
        project: {
            ...(group.workspaceDir ? { workspaceDir: group.workspaceDir } : {}),
            ...(group.projectKey ? { projectKey: group.projectKey } : {}),
            sessionCursor,
        },
    };
}
/** Projects page in the device's order; inside a page sessions go by activity, once each. */
function finishPage(device, sessions, next, requests) {
    const seen = new Set();
    const items = sessions
        .sort((left, right) => sessionActivityMs(right) - sessionActivityMs(left))
        .filter((session) => {
        // toMavisSession only yields sessions that have an id.
        const id = session.sessionId ?? '';
        if (seen.has(id))
            return false;
        seen.add(id);
        return true;
    });
    logger.info({
        source: 'rc',
        deviceId: device.deviceId,
        requests,
        returned: items.length,
        hasMore: Boolean(next),
    }, 'Remote Control project list page read');
    return {
        sessions: items,
        hasMore: Boolean(next),
        ...(next ? { nextCursor: encodeProjectWalk(next) } : {}),
    };
}
function projectListUnsupported(error) {
    if (!(error instanceof CloudSessionReadError))
        return undefined;
    if (error.status === 404 || error.status === 501) {
        return new ProjectListUnsupported(`http_${error.status}`);
    }
    const code = error.upstreamCode;
    return code && PROJECT_LIST_UNSUPPORTED_CODES.has(code)
        ? new ProjectListUnsupported(code.toLowerCase())
        : undefined;
}
function encodeProjectWalk(walk) {
    const value = {
        ...(walk.projects ? { p: walk.projects } : {}),
        ...(walk.project
            ? { w: walk.project.workspaceDir, k: walk.project.projectKey, s: walk.project.sessionCursor }
            : {}),
    };
    return PROJECT_CURSOR_PREFIX + Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}
export function decodeProjectWalk(cursor) {
    const fields = readCursorFields(cursor);
    const { p: projects, w: workspaceDir, k: projectKey, s: sessionCursor } = fields;
    const hasProject = Boolean(workspaceDir || projectKey);
    if (Boolean(sessionCursor) !== hasProject)
        throw invalidCursor();
    if (!sessionCursor) {
        if (!projects)
            throw invalidCursor();
        return { projects };
    }
    return {
        ...(projects ? { projects } : {}),
        project: {
            ...(workspaceDir ? { workspaceDir } : {}),
            ...(projectKey ? { projectKey } : {}),
            sessionCursor,
        },
    };
}
function readCursorFields(cursor) {
    let value;
    try {
        value = JSON.parse(Buffer.from(cursor.slice(PROJECT_CURSOR_PREFIX.length), 'base64url').toString('utf8'));
    }
    catch {
        throw invalidCursor();
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw invalidCursor();
    const fields = {};
    for (const key of ['p', 'w', 'k', 's']) {
        const entry = value[key];
        if (entry === undefined)
            continue;
        if (typeof entry !== 'string' || !entry)
            throw invalidCursor();
        fields[key] = entry;
    }
    return fields;
}
function invalidCursor() {
    return remoteSessionError(400, 'INVALID_CURSOR', 'cursor is not from this device list; list again without cursor');
}
function staleProjectCursor() {
    return remoteSessionError(400, 'INVALID_CURSOR', "cursor no longer matches this device's projects; list again without cursor");
}
function stalledPaging() {
    return remoteSessionError(502, 'INVALID_REMOTE_RESPONSE', 'The Remote Control device returned the same page cursor twice');
}
function invalidProjectPage() {
    return remoteSessionError(502, 'INVALID_REMOTE_RESPONSE', 'The Remote Control device returned a project page that cannot be continued');
}
//# sourceMappingURL=rc-project-walk.js.map