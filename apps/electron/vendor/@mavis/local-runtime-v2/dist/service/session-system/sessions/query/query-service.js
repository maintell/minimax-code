import { SessionQueryServiceError } from '../errors.js';
import { projectPrimarySessionAgentName } from '../agent-name.js';
import { sessionKindForLegacyPurposePrefix } from '../repo/drizzle/normalization.js';
import { sessionTreeFilterFromRequest } from './tree-query-policy.js';
export class SessionQueryService {
    repository;
    discovery;
    constructor(repository, discovery) {
        this.repository = repository;
        this.discovery = discovery;
    }
    async list(input = {}) {
        await this.discovery?.discover(input.agentName);
        const archived = archivedFilter(input);
        const page = await this.repository.listPage({
            ...input,
            archived,
            excludeInternalDefaultRoots: archived === true,
            includeHidden: input.includeHidden === true,
            ...sessionKindFilters(input),
        });
        return projectPrimarySessionPage(page, input.agentName);
    }
    async listExact(input) {
        await this.discovery?.discover(input?.agentName);
        const sessions = await this.repository.list(input);
        return projectPrimarySessions(sessions, input?.agentName);
    }
    async listFilteredPage(input) {
        await this.discovery?.discover(input.agentName);
        return projectPrimarySessionPage(await this.repository.listPage(input), input.agentName);
    }
    async search(input) {
        return projectPrimarySessionPage(await this.repository.searchPage(input), input.agentName);
    }
    async tree(input) {
        await this.discovery?.discover(input.agentName);
        const filter = sessionTreeFilterFromRequest(input, input.includeHidden === true);
        const roots = await this.repository.listRootPage({
            agentName: input.agentName,
            ...filter,
            limit: input.limit,
            cursor: input.cursor,
        });
        const children = await this.repository.listChildrenMany(roots.sessions.map(({ sessionId }) => sessionId), filter);
        return {
            sessions: roots.sessions.map((session) => ({
                session: projectPrimarySessionAgentName(session, input.agentName),
                children: (children.get(session.sessionId) ?? []).map((child) => projectPrimarySessionAgentName(child, input.agentName)),
            })),
            hasMore: roots.hasMore,
            ...(roots.nextCursor ? { nextCursor: roots.nextCursor } : {}),
        };
    }
    /**
     * Cross-Agent sidebar aggregate: one recency-ordered page of top-level
     * Sessions owned by *any* Agent.
     *
     * Why this exists: Cloud gets its all-Agent sidebar projection server-side,
     * but local(daemon) only had the Agent-scoped `tree()`. Every caller passed a
     * concrete Agent, so a non-primary Agent's root conversation — and an IM
     * `channel` Session parked under a non-primary Agent — could never reach the
     * sidebar even though the row itself was `visible` and un-archived.
     *
     * Design notes:
     * - Single keyset-cursor query instead of fan-out-per-Agent. Merging N Agent
     *   pages client-side would break `updated_at DESC` paging (each source has
     *   its own cursor), and with 16 Agents it would also mean 16 round trips.
     * - No `projectPrimarySessionAgentName` projection. `tree()` rewrites a
     *   primary-family Agent name onto the requested one so an Agent-scoped view
     *   stays self-consistent; here there is no requested Agent, and the UI needs
     *   each row's real owner to attribute it (notably IM rows).
     * - `cron`/`peek` stay excluded through the shared
     *   `sessionTreeFilterFromRequest` default, so this path inherits the same
     *   internal-tree policy as `tree()`.
     */
    async sidebarTree(input = {}) {
        // No Agent name: discovery hydrates metadata across all Agents.
        await this.discovery?.discover();
        const filter = sessionTreeFilterFromRequest(input, input.includeHidden === true);
        const roots = await this.repository.listRootPage({
            // Intentionally no `agentName` — see SessionRootPageOptions.agentName.
            ...filter,
            limit: input.limit,
            cursor: input.cursor,
        });
        const children = await this.repository.listChildrenMany(roots.sessions.map(({ sessionId }) => sessionId), filter);
        return {
            sessions: roots.sessions.map((session) => ({
                session,
                children: children.get(session.sessionId) ?? [],
            })),
            hasMore: roots.hasMore,
            ...(roots.nextCursor ? { nextCursor: roots.nextCursor } : {}),
        };
    }
    async get(sessionId) {
        const session = await this.find(sessionId);
        if (!session) {
            throw new SessionQueryServiceError('session-not-found', `Session not found: ${sessionId}`);
        }
        return session;
    }
    async find(sessionId) {
        await this.discovery?.ensureMetadataReady(sessionId);
        return this.repository.get(sessionId);
    }
}
function archivedFilter(input) {
    if (input.archived !== undefined)
        return input.archived;
    if (input.onlyArchived === true || input.onlyCompressed === true)
        return true;
    return input.includeArchived === true ? undefined : false;
}
function projectPrimarySessionPage(page, requestedAgentName) {
    return {
        ...page,
        sessions: projectPrimarySessions(page.sessions, requestedAgentName),
    };
}
function projectPrimarySessions(sessions, requestedAgentName) {
    return requestedAgentName
        ? sessions.map((session) => projectPrimarySessionAgentName(session, requestedAgentName))
        : sessions;
}
function sessionKindFilters(input) {
    const includeKind = mapPurposePrefix(input.includePurposePrefix);
    const excludeKind = mapPurposePrefix(input.excludePurposePrefix);
    const included = mergeKinds(input.includeSessionKinds, includeKind);
    const excluded = mergeKinds([...defaultExcludedKinds(input), ...(input.excludeSessionKinds ?? [])], excludeKind);
    return {
        ...optionalKinds('includeSessionKinds', included),
        ...optionalKinds('excludeSessionKinds', excluded),
        ...literalPurposeFilters(input, includeKind, excludeKind),
    };
}
function mapPurposePrefix(prefix) {
    return prefix ? sessionKindForLegacyPurposePrefix(prefix) : undefined;
}
function defaultExcludedKinds(input) {
    return input.includeHidden === true || input.includePurposePrefix ? [] : ['cron'];
}
function mergeKinds(kinds, extra) {
    const merged = extra ? [...(kinds ?? []), extra] : [...(kinds ?? [])];
    return [...new Set(merged)];
}
function optionalKinds(key, kinds) {
    return kinds.length > 0 ? { [key]: kinds } : {};
}
function literalPurposeFilters(input, includeKind, excludeKind) {
    return {
        ...(input.includePurposePrefix && !includeKind
            ? { includePurposePrefix: input.includePurposePrefix }
            : {}),
        ...(input.excludePurposePrefix && !excludeKind
            ? { excludePurposePrefix: input.excludePurposePrefix }
            : {}),
    };
}
//# sourceMappingURL=query-service.js.map