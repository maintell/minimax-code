import { listLegacyImCredentialCandidates } from '../migration/legacy-im-migration.js';
import { historicalChannelAgentReadErrorCode } from '../binding/agent-owner-compatibility.js';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
export async function migrateLegacyImConnectionState(input) {
    if (!input.imConnectionStore)
        return;
    const rawBindingRoutes = (await input.bindingStore.list()).map((binding) => ({
        key: binding.key,
        platform: binding.platform,
        clientName: binding.clientName,
        agentName: binding.agentName,
        projectKey: binding.projectKey,
        sessionId: binding.sessionId,
        strategy: binding.strategy,
        updatedAt: binding.updatedAt,
    }));
    const bindingRoutes = await resolveLegacyImBindingRoutes({
        ...input,
        bindingRoutes: rawBindingRoutes,
    });
    const credentialAgent = input.legacyImCredentialAgent;
    const credentialRoutes = credentialAgent
        ? await legacyCredentialRoutes({
            ...input,
            // A failed root/main resolution still owns this old transport
            // profile. Passing only the resolved rows would let a credential
            // candidate bypass that local safety skip.
            bindingRoutes: rawBindingRoutes,
            legacyImCredentialAgent: credentialAgent,
        })
        : [];
    logger.info({
        stage: 'legacy_wechat_route_filter',
        bindingRouteCount: bindingRoutes.length,
        credentialRouteCount: credentialRoutes.length,
    }, 'IM startup stage entered');
    const legacyRoutes = await filterUnconfirmedLegacyWeChatRoutes([...bindingRoutes, ...credentialRoutes], input.isUsableWeChatRoute);
    logger.info({ stage: 'legacy_connection_store_migration', legacyRouteCount: legacyRoutes.length }, 'IM startup stage entered');
    await input.imConnectionStore.migrateLegacy({
        legacyRoutes,
        ...(input.resolveActiveClient ? { resolveActiveClient: input.resolveActiveClient } : {}),
        // Per-row trust check: the row's own Session must exist and belong to
        // the row's own Agent. No shared session-id trust set (a bare id could
        // be claimed by an unrelated Agent's row), and no persisted owner-fence
        // snapshot comparison — that over-strict filter was the mass-skip root
        // cause (incident upload-442733104115904). Archived or non-root
        // Sessions stay usable: preserving the historical relationship is the
        // whole point.
        isUsableSession: (candidate) => isUsableLegacySession(input, candidate),
        onSkipped: ({ code, keys, reason, activeClientName }) => {
            if (reason === 'superseded_by_active_credential') {
                // F4: rows of an old bot are superseded facts, not failures — one
                // INFO per row keeps every bindingKey traceable next to the client
                // that won the arbitration.
                for (const bindingKey of keys) {
                    logger.info({ code, bindingKey, reason, ...(activeClientName ? { activeClientName } : {}) }, 'legacy IM route superseded by the active credential');
                }
                return;
            }
            logger.warn({ code, bindingKeys: keys, ...(reason ? { reason } : {}) }, 'legacy IM route migration skipped locally');
        },
    });
}
/** Owner identity read tolerant to the historical-agent-unavailable codes. */
async function readOwnerKeepingUnavailableLocal(input, candidate) {
    try {
        return await input.rootless.getAgentOwnerIdentity(candidate.agentName);
    }
    catch (error) {
        const code = historicalChannelAgentReadErrorCode(error);
        if (!code)
            throw error;
        logger.warn({ code, sessionId: candidate.sessionId }, 'legacy IM Session Agent could not be read; keeping original route');
        return undefined;
    }
}
/**
 * Per-row trust check: the row's own Session must exist and belong to the
 * row's own Agent. No shared session-id trust set (a bare id could be claimed
 * by an unrelated Agent's row), and no persisted owner-fence snapshot
 * comparison — that over-strict filter was the mass-skip root cause
 * (incident upload-442733104115904). Archived or non-root Sessions stay
 * usable: preserving the historical relationship is the whole point.
 */
async function isUsableLegacySession(input, candidate) {
    const [session, owner, project] = await Promise.all([
        input.getSessionById(candidate.sessionId),
        readOwnerKeepingUnavailableLocal(input, candidate),
        input.rootless.getSessionProjectIdentity(candidate.sessionId),
    ]);
    const unusableReason = await classifyLegacySessionUsability({
        input,
        candidate,
        session,
        owner,
        project,
    });
    if (unusableReason) {
        logger.warn({
            sessionId: candidate.sessionId,
            agentName: candidate.agentName,
            reason: unusableReason,
            ...(unusableReason === 'project_mismatch' ? { projectKey: candidate.projectKey } : {}),
        }, 'legacy IM route cursor is not usable');
        return false;
    }
    return true;
}
/** Ordered v1 gate sequence; first failing gate names the skip reason. */
async function classifyLegacySessionUsability(scope) {
    const { input, candidate, session, owner, project } = scope;
    if (!session || typeof session !== 'object' || !owner || !project) {
        return 'session_or_identity_missing';
    }
    if (!(await isLegacySessionOwnedByAgent(input, owner, session))) {
        return 'session_owner_mismatch';
    }
    if (project.projectKey !== candidate.projectKey)
        return 'project_mismatch';
    return undefined;
}
function isLegacyRootStrategy(strategy) {
    return strategy === 'root' || strategy === 'main';
}
/**
 * Legacy `root` / `main` rows recorded the Session that was bound when the
 * row was written. Product semantics (2026-09-17 clarification): an IM
 * binding targets one Session — the migration preserves that recorded
 * relationship and never substitutes "the current Root" for it. A row whose
 * Session is gone still materializes with an empty lazily-resolved cursor;
 * only a row whose Agent is gone is skipped.
 */
async function resolveLegacyImBindingRoutes(input) {
    const resolved = [];
    for (const route of input.bindingRoutes) {
        if (!isLegacyRootStrategy(route.strategy)) {
            resolved.push(route);
            continue;
        }
        const resolution = await resolveLegacyImHistoricalSession(input, route, route.sessionId);
        if (!resolution)
            continue;
        if (resolution.kind === 'keep') {
            resolved.push({
                ...route,
                agentName: resolution.agentName,
                projectKey: resolution.projectKey,
                sessionId: resolution.sessionId,
                legacyRootSessionId: route.sessionId,
                legacyRootProjectKey: route.projectKey,
                trustedRootSessionId: resolution.sessionId,
            });
            continue;
        }
        // The historical Session is gone: keep the credentials and the bound
        // state, drop only the dead cursor. The store's emptyCursor path (the
        // same one credential-only imports use) creates the Session lazily on
        // the first inbound message and never eagerly.
        resolved.push({
            ...route,
            agentName: resolution.agentName,
            sessionId: '',
            emptyCursor: true,
        });
    }
    return resolved;
}
async function resolveLegacyImHistoricalSession(input, route, historicalSessionId, hint) {
    const owner = hint?.owner ?? (await resolveLegacyRouteOwner(input, route));
    if (!owner)
        return undefined;
    const sessionId = historicalSessionId.trim();
    const emptyResolution = (reason) => {
        logger.warn({
            bindingKey: route.key,
            agentName: owner.exactOwnerName,
            clientName: route.clientName,
            ...(sessionId ? { legacySessionId: sessionId } : {}),
            reason,
        }, 'legacy IM route lost its historical Session; materializing an empty cursor');
        return { kind: 'empty', agentName: owner.exactOwnerName };
    };
    if (!sessionId)
        return emptyResolution('session_missing');
    const loaded = await loadLegacySessionWithProject(input, sessionId);
    if (!loaded)
        return emptyResolution('session_missing');
    const { session, project } = loaded;
    // Ownership is judged from the Session record itself (name or trusted
    // builtin family alias, e.g. historical `main` for `mavis`). Deliberately
    // NOT required any more: sessionType === 'root', archived !== true, or a
    // compatible persisted owner-fence snapshot — that over-strict filter is
    // what mass-skipped real bindings (incident upload-442733104115904).
    if (!(await isLegacySessionOwnedByAgent(input, owner, session))) {
        return emptyResolution('session_owner_mismatch');
    }
    logger.info({
        bindingKey: route.key,
        agentName: owner.exactOwnerName,
        clientName: route.clientName,
        sessionId,
        projectKey: project.projectKey,
    }, 'legacy IM route keeps its historical Session');
    return {
        kind: 'keep',
        agentName: owner.exactOwnerName,
        projectKey: project.projectKey,
        sessionId,
    };
}
/**
 * The Agent behind this route no longer exists (or cannot be read).
 * Orphaned credentials must not be materialized onto a fresh Connection, so
 * an unreadable Agent stays a skip. `agentReadErrorCode` (for example
 * AGENT_NOT_FOUND) distinguishes this case from other skip reasons.
 */
async function resolveLegacyRouteOwner(input, route) {
    try {
        return await input.rootless.getAgentOwnerIdentity(route.agentName);
    }
    catch (error) {
        const agentReadErrorCode = historicalChannelAgentReadErrorCode(error);
        if (!agentReadErrorCode)
            throw error;
        reportLegacyImSkip('CHANNEL_IM_LEGACY_ROOT_UNTRUSTED', route.key, agentReadErrorCode);
        return undefined;
    }
}
/**
 * A missing Session (or one whose Agent config is gone) degrades to the
 * empty-cursor import; storage-level failures abort startup loudly.
 */
async function loadLegacySessionWithProject(input, sessionId) {
    let session;
    let project;
    try {
        [session, project] = await Promise.all([
            input.getSessionById(sessionId),
            input.rootless.getSessionProjectIdentity(sessionId),
        ]);
    }
    catch (error) {
        if (!isMissingSessionError(error) && !historicalChannelAgentReadErrorCode(error))
            throw error;
        return undefined;
    }
    if (!session || typeof session !== 'object' || !project)
        return undefined;
    return { session, project };
}
/**
 * Does this Session record belong to this Agent? Exact name match, or a
 * trusted builtin family alias (historical `main` rows for the `mavis`
 * primary). This intentionally reads the Session's own `agentName` instead
 * of comparing persisted owner-fence snapshots: the snapshot expresses a
 * routing fence, not whether the historical binding relationship existed.
 */
async function isLegacySessionOwnedByAgent(input, owner, session) {
    const rawSessionAgent = session.agentName;
    const sessionAgent = typeof rawSessionAgent === 'string' ? rawSessionAgent.trim() : '';
    if (!sessionAgent)
        return false;
    if (sessionAgent === owner.exactOwnerName)
        return true;
    // Cross-name adoption is a builtin-family privilege proven by the shared
    // resolver; custom Agents always require the exact name.
    if (owner.ownerKind !== 'builtin' || !input.resolveAgentReadScope)
        return false;
    try {
        const scope = await input.resolveAgentReadScope(owner.exactOwnerName);
        const family = trustedBuiltinFamilyNames(scope);
        return Boolean(family?.has(sessionAgent) && family.has(owner.exactOwnerName));
    }
    catch {
        return false;
    }
}
/** Trusted-builtin gate + the family alias set; undefined when untrusted. */
function trustedBuiltinFamilyNames(scope) {
    const canonicalName = scope.canonicalName.trim();
    const primaryName = scope.primaryName?.trim();
    if (scope.trustedBuiltin !== true ||
        !canonicalName ||
        !primaryName ||
        canonicalName !== primaryName) {
        return undefined;
    }
    return new Set([canonicalName, primaryName, scope.exactOwnerName, ...(scope.compatibleNames ?? [])].filter((name) => typeof name === 'string' && name.length > 0));
}
async function filterUnconfirmedLegacyWeChatRoutes(routes, isUsableWeChatRoute) {
    if (!isUsableWeChatRoute)
        return [...routes];
    const eligible = [];
    for (const route of routes) {
        if (route.platform !== 'wechat' || (await isUsableWeChatRoute(route))) {
            eligible.push(route);
            continue;
        }
        reportLegacyImSkip('CHANNEL_IM_LEGACY_WECHAT_UNCONFIRMED', route.key);
    }
    return eligible;
}
async function legacyCredentialRoutes(input) {
    const routes = [];
    for (const candidate of await listLegacyImCredentialCandidates(input.dataDir)) {
        const identity = await resolveCredentialCandidateIdentity(input, candidate);
        if (!identity)
            continue;
        const { agent, owner } = identity;
        if (hasExactLegacyBindingProfile(input.bindingRoutes, candidate, owner.exactOwnerName))
            continue;
        const rootSessionId = agent.rootSessionId?.trim();
        if (!rootSessionId) {
            const projectKey = agent.defaultProjectKey?.trim();
            if (!projectKey) {
                reportLegacyCredentialSkip('CHANNEL_IM_LEGACY_CREDENTIAL_PROJECT_UNTRUSTED', candidate.key);
                continue;
            }
            routes.push({
                ...candidate,
                agentName: owner.exactOwnerName,
                projectKey,
                sessionId: '',
                emptyCursor: true,
                updatedAt: 0,
            });
            continue;
        }
        const resolution = await resolveLegacyImHistoricalSession(input, candidate, rootSessionId, {
            owner,
        });
        if (!resolution) {
            reportLegacyCredentialSkip('CHANNEL_IM_LEGACY_CREDENTIAL_ROOT_UNTRUSTED', candidate.key);
            continue;
        }
        if (resolution.kind === 'keep') {
            routes.push({
                ...candidate,
                agentName: resolution.agentName,
                projectKey: resolution.projectKey,
                sessionId: resolution.sessionId,
                trustedRootSessionId: resolution.sessionId,
                updatedAt: 0,
            });
            continue;
        }
        // The recorded pointer Session is gone. Keep the credentials by falling
        // back to the same empty-cursor import used when the pointer never
        // existed; without a default Project there is no place to put the
        // Connection, so that narrow case still skips (same rule as above).
        const fallbackProjectKey = agent.defaultProjectKey?.trim();
        if (!fallbackProjectKey) {
            reportLegacyCredentialSkip('CHANNEL_IM_LEGACY_CREDENTIAL_PROJECT_UNTRUSTED', candidate.key);
            continue;
        }
        routes.push({
            ...candidate,
            agentName: resolution.agentName,
            projectKey: fallbackProjectKey,
            sessionId: '',
            emptyCursor: true,
            updatedAt: 0,
        });
    }
    return routes;
}
/**
 * Resolve the candidate's Agent pointer + owner identity; unreadable/missing
 * Agents skip the row with the CREDENTIAL_AGENT_MISSING code (per-row skip,
 * storage failures still abort loudly).
 */
async function resolveCredentialCandidateIdentity(input, candidate) {
    let agent;
    try {
        agent = await input.legacyImCredentialAgent(candidate.agentName);
    }
    catch (error) {
        if (historicalChannelAgentReadErrorCode(error)) {
            reportLegacyCredentialSkip('CHANNEL_IM_LEGACY_CREDENTIAL_AGENT_MISSING', candidate.key, historicalChannelAgentReadErrorCode(error));
            return undefined;
        }
        throw error;
    }
    if (!agent) {
        reportLegacyCredentialSkip('CHANNEL_IM_LEGACY_CREDENTIAL_AGENT_MISSING', candidate.key);
        return undefined;
    }
    try {
        return { agent, owner: await input.rootless.getAgentOwnerIdentity(candidate.agentName) };
    }
    catch (error) {
        if (historicalChannelAgentReadErrorCode(error)) {
            reportLegacyCredentialSkip('CHANNEL_IM_LEGACY_CREDENTIAL_AGENT_MISSING', candidate.key, historicalChannelAgentReadErrorCode(error));
            return undefined;
        }
        throw error;
    }
}
function hasExactLegacyBindingProfile(routes, candidate, exactOwnerName) {
    return routes.some((route) => (route.agentName === candidate.agentName || route.agentName === exactOwnerName) &&
        route.platform === candidate.platform &&
        route.clientName === candidate.clientName);
}
function reportLegacyImSkip(code, bindingKey, agentReadErrorCode) {
    logger.warn({ code, bindingKey, ...(agentReadErrorCode ? { agentReadErrorCode } : {}) }, 'legacy IM migration skipped locally');
}
function reportLegacyCredentialSkip(code, bindingKey, agentReadErrorCode) {
    logger.warn({ code, bindingKey, ...(agentReadErrorCode ? { agentReadErrorCode } : {}) }, 'legacy IM credential migration skipped locally');
}
function isMissingSessionError(error) {
    return (typeof error === 'object' &&
        error !== null &&
        error.code === 'SESSION_NOT_FOUND');
}
//# sourceMappingURL=legacy-connection-migration.js.map