import { join } from 'node:path';
import { LocalAgentManagementRoutes } from './agent-management.js';
import { replaceStoredAgentRootSession } from './agent-root-replacement.js';
import { applyLocalRunLocation, LocalRunLocationError, readLocalRunLocationInput, } from '../../../service/turn-system/index.js';
import {} from '../../../infra/conversation/run-location.js';
import { logger } from '../../../infra/logging/logger.js';
import { LegacyOpencodeMigrationError, LegacyOpencodeMigrator, } from '../../../infra/legacy-db/legacy-opencode-migrator.js';
import { readLocalSessionListOptions } from '../../../service/session-system/index.js';
import { canUseRunLocationForAppMode, } from '../../../infra/runtime-owner/app-mode.js';
import { timeRouteDuration } from '../../../infra/logging/metrics.js';
import { isValidLocalAgentName, json, notFound, readJsonBody, readRequestedFramework, readString, readVisibility, } from '../../../infra/transport/host-http.js';
import { buildFailedLegacyMigrationStub, migrateLegacySessionsForList, presentLegacyStubAsPiAgent, presentLegacyStubsAsPiAgent, } from '../host-support.js';
import { isAgentInternalDefaultWorkspaceDir, normalizeAbsolutePath, } from '../../../infra/legacy-db/project-canonical-workspace.js';
import { DEFAULT_LOCAL_AGENT_AVATAR_URL, buildLegacyAgentIdentity, readSessionAppMode, readSessionModelSelection, readOnlyLegacySessionResponse, isPiRootSession, isActivePiRootSession, resolvePreferredLegacyRootSession, } from './agent-route-support.js';
const LEGACY_PRIMARY_AGENT_NAME = 'main';
export class LocalApiAgentRoutes {
    ctx;
    rootSessionId;
    management;
    constructor(ctx) {
        this.ctx = ctx;
        this.management = new LocalAgentManagementRoutes({
            agentRuntimePort: ctx.agentRuntimePort,
            agentName: ctx.agentName,
            resolveDefaultWorkspaceDir: () => this.resolveDefaultWorkspaceDir(),
            hasLegacyAgent: (name) => this.hasLegacyAgent(name),
        });
    }
    get controller() {
        return this.ctx.controller;
    }
    get conversation() {
        if (!this.ctx.conversation) {
            throw new Error('Runtime Conversation is unavailable for Agent Session operations');
        }
        return this.ctx.conversation;
    }
    // Reads and owned-session updates stay tolerant of a missing Runtime
    // Conversation: `replaceRootSession` still keeps a `!ctx.conversation`
    // branch for hosts booted without Local Runtime V2, and that branch is the
    // only caller of `updateOwnedSession`. Session *creation* stays V2-only —
    // its former V1 fallback depended on `initMessageState`, which the Agent
    // cutover removed along with V1 message-state ownership.
    querySession(sessionId) {
        return this.ctx.conversation
            ? this.ctx.conversation.query.getSession(sessionId)
            : this.controller.getSession(sessionId);
    }
    querySessions(options) {
        return this.ctx.conversation
            ? this.ctx.conversation.query.listSessions(options)
            : this.controller.listSessions(options);
    }
    updateOwnedSession(sessionId, fields) {
        if (!this.ctx.conversation)
            return this.controller.updateSession(sessionId, fields);
        return this.conversation.lifecycle.updateSession(sessionId, {
            ...(fields.title !== undefined ? { title: fields.title } : {}),
            ...(fields.sessionType !== undefined ? { sessionType: fields.sessionType } : {}),
            ...(fields.parentSessionId !== undefined ? { parentSessionId: fields.parentSessionId } : {}),
            ...(fields.archived !== undefined ? { archived: fields.archived } : {}),
            ...(fields.effectiveModel !== undefined ? { effectiveModel: fields.effectiveModel } : {}),
            ...(fields.effectiveModelVariant !== undefined
                ? { effectiveModelVariant: fields.effectiveModelVariant }
                : {}),
        });
    }
    get agentService() {
        return this.ctx.agentRuntimePort;
    }
    get legacyMigrator() {
        return this.ctx.legacyMigrator;
    }
    get runtimeMode() {
        return this.ctx.runtimeMode;
    }
    get agentName() {
        return this.ctx.agentName;
    }
    get agentDisplayName() {
        return this.ctx.agentDisplayName;
    }
    configGetter() {
        return this.ctx.configGetter();
    }
    nowMs() {
        return this.ctx.nowMs();
    }
    resolveDefaultWorkspaceDir() {
        return this.ctx.resolveDefaultWorkspaceDir();
    }
    getLegacyRuntime() {
        return this.ctx.getLegacyRuntime();
    }
    getSessionById(sessionId) {
        return this.ctx.getSessionById(sessionId);
    }
    listAllSessions(agentName, options) {
        return this.ctx.listAllSessions(agentName, options);
    }
    serializeSessions(sessions) {
        return this.ctx.serializeSessions(sessions);
    }
    serializeSessionTree(sessions, url, agentName, getSessionById) {
        return this.ctx.serializeSessionTree(sessions, url, agentName, getSessionById);
    }
    serializeSession(session) {
        return this.ctx.serializeSession(session);
    }
    markMigratedLegacySessionDeleted(sessionId) {
        return this.ctx.markMigratedLegacySessionDeleted(sessionId);
    }
    abortLocalSessionTurn(sessionId) {
        this.ctx.abortLocalSessionTurn(sessionId);
    }
    normalizeCleanLocalSession(session) {
        return this.ctx.normalizeCleanLocalSession(session);
    }
    publishGlobalEvent(event) {
        this.ctx.publishGlobalEvent(event);
    }
    async routeAgentApi(request, parts, url) {
        const method = request.method.toUpperCase();
        const tail = parts.slice(2).join('/');
        // List latency is user-perceived: timing starts before agent pre-resolution
        // (legacy discovery / root-session ensure), not at the list branch itself.
        if (method === 'GET' && (tail === 'session' || tail === 'session/tree')) {
            return timeRouteDuration(this.ctx.metricsReporter, 'session_list_duration_ms', () => this.routeAgentApiInner(request, parts, url));
        }
        return this.routeAgentApiInner(request, parts, url);
    }
    routeCustomAgentAvatar(agentName) {
        return this.management.routeCustomAgentAvatar(agentName);
    }
    async routeAgentApiInner(request, parts, url) {
        const method = request.method.toUpperCase();
        const agentName = parts[1];
        if (!agentName)
            return notFound('/agent');
        const tail = parts.slice(2).join('/');
        // Avatar reads must precede legacy discovery and root-session work.
        if (method === 'GET' && tail === 'identity/avatar') {
            return this.routeCustomAgentAvatar(agentName);
        }
        const agent = await this.resolveRouteAgent(agentName);
        if (!agent)
            return notFound(`/agent/${agentName}`);
        if (agent.primaryAgent)
            await this.ensureRootSession();
        if (agent.localAgent)
            await this.ensureLocalAgentRootSession(agent.localAgent);
        return this.routeResolvedAgent(request, parts, url, agent);
    }
    async resolveRouteAgent(agentName) {
        const primaryAgent = agentName === this.agentName;
        let localAgent = primaryAgent ? undefined : await this.getLocalAgent(agentName);
        if (primaryAgent || localAgent)
            return { agentName, primaryAgent, localAgent, legacyAgent: false };
        const foundLegacyAgent = await this.hasLegacyAgent(agentName);
        localAgent = await this.getLocalAgent(agentName);
        const legacyAgent = !localAgent && foundLegacyAgent;
        if (!localAgent && !legacyAgent && !(await this.getPreferredSessionForAgent(agentName))) {
            return undefined;
        }
        return { agentName, primaryAgent, localAgent, legacyAgent };
    }
    async routeResolvedAgent(request, parts, url, agent) {
        const method = request.method.toUpperCase();
        const tail = parts.slice(2).join('/');
        const { agentName } = agent;
        switch (`${method} ${tail}`) {
            case 'GET im':
            case 'DELETE im':
                return this.routeAgentIm(agentName, method);
            case 'GET ':
                return this.routeAgentInfo(agent);
            case 'GET session/root':
                return this.routeRootSession(agent);
            case 'PUT session/root':
                return this.routeReplaceRootSession(request, agent);
            case 'GET session': {
                const sessions = await this.listAgentSessions(url, agentName);
                return json({ sessions: await this.serializeSessions(sessions) });
            }
            case 'POST session':
                return this.routeCreateSession(request, agent);
            case 'GET session/tree':
                return this.routeSessionTree(url, agentName);
            default:
                return this.routeCompaction(request, parts, agentName);
        }
    }
    async routeAgentIm(agentName, method) {
        if (this.ctx.routeAgentIm)
            return this.ctx.routeAgentIm(agentName, method);
        return method === 'GET'
            ? json({ channel: null, activeBindings: [], localRuntime: true })
            : json({ ok: true, deleted: false, deletedCount: 0, localRuntime: true });
    }
    async routeAgentInfo(agent) {
        const { agentName, legacyAgent, localAgent, primaryAgent } = agent;
        if (this.runtimeMode === 'clean' && legacyAgent && !localAgent && !primaryAgent) {
            return json(await this.buildCleanLegacyAgentInfo(agentName));
        }
        return json(await this.buildAgentInfo(agentName));
    }
    async routeRootSession(agent) {
        const session = await this.getRouteRootSession(agent);
        if (!session)
            return notFound(`/agent/${agent.agentName}/session/root`);
        return json({ session: await this.serializeSession(session) });
    }
    getRouteRootSession(agent) {
        if (agent.primaryAgent)
            return this.ensureRootSession();
        if (agent.localAgent)
            return this.ensureLocalAgentRootSession(agent.localAgent);
        return this.getPreferredSessionForAgent(agent.agentName);
    }
    async routeReplaceRootSession(request, agent) {
        if (agent.legacyAgent) {
            return json({ error: 'Legacy opencode root replacement is not managed by local-runtime.' }, { status: 501 });
        }
        const body = await readJsonBody(request);
        const sessionId = readString(body, 'sessionId') ?? readString(body, 'session_id');
        if (!sessionId)
            return json({ error: 'Missing sessionId' }, { status: 400 });
        const replaced = await this.replaceRootSession(agent.agentName, sessionId);
        if (!replaced)
            return notFound(`/agent/${agent.agentName}/session/root`);
        return json({ ok: true });
    }
    async routeCreateSession(request, agent) {
        if (agent.legacyAgent) {
            return json({ error: 'New legacy opencode sessions are disabled; create a pi-agent session instead.' }, { status: 403 });
        }
        const body = await readJsonBody(request);
        if (readRequestedFramework(body) === 'opencode') {
            return json({ error: 'New opencode sessions are disabled; create a pi-agent session instead.' }, { status: 403 });
        }
        const location = await this.resolveSessionLocation(body, agent.localAgent);
        if (location instanceof Response)
            return location;
        const session = await this.createSession({
            agentName: agent.agentName,
            ...location,
            title: readString(body, 'title') ?? null,
            visibility: readVisibility(body),
            purpose: readString(body, 'purpose'),
            ...readSessionModelSelection(body.model),
        });
        return json({ sessionId: session.sessionId, session: await this.serializeSession(session) }, { status: 201 });
    }
    async resolveSessionLocation(body, localAgent) {
        const parentSessionId = readString(body, 'parentSessionId') ?? null;
        // Parent identity controls lineage and inherited app mode; workspace selection is independent.
        const parentSession = parentSessionId ? await this.getSessionById(parentSessionId) : undefined;
        const explicitWorkspaceDir = readString(body, 'workspaceDir') ?? readString(body, 'workspace_dir');
        const appMode = readSessionAppMode(body, parentSession);
        const runLocation = await this.resolveSessionRunLocation(body, appMode, explicitWorkspaceDir ?? localAgent?.defaultWorkspaceDir);
        if (runLocation instanceof Response)
            return runLocation;
        const workspaceDir = runLocation?.resolvedDir ?? explicitWorkspaceDir;
        return {
            parentSessionId,
            appMode,
            runLocation,
            ...(workspaceDir ? { workspaceDir } : {}),
            isDefaultWorkspace: explicitWorkspaceDir === undefined && runLocation === undefined,
        };
    }
    async resolveSessionRunLocation(body, appMode, workspaceDir) {
        const baseDir = workspaceDir ?? this.resolveDefaultWorkspaceDir();
        try {
            const input = canUseRunLocationForAppMode(appMode)
                ? readLocalRunLocationInput(body.runLocation)
                : undefined;
            if (!input)
                return undefined;
            return await applyLocalRunLocation(input, baseDir, () => this.nowMs());
        }
        catch (err) {
            if (err instanceof LocalRunLocationError) {
                return json({ error: err.message, code: err.code }, { status: err.status });
            }
            throw err;
        }
    }
    async routeSessionTree(url, agentName) {
        const sessions = await this.listSessionsForTree();
        const byId = new Map(sessions.map((session) => [session.sessionId, session]));
        return json({
            sessions: await this.serializeSessionTree(sessions, url, agentName, (sessionId) => Promise.resolve(byId.get(sessionId))),
        });
    }
    async routeCompaction(request, parts, agentName) {
        const tail = parts.slice(2).join('/');
        const sessionId = parts[3];
        if (request.method.toUpperCase() !== 'POST' ||
            !sessionId ||
            tail !== `session/${sessionId}/request-compaction`) {
            return notFound(`/agent/${agentName}/${tail}`);
        }
        return this.requestLocalCompaction(agentName, sessionId, await readJsonBody(request));
    }
    async routeAgentSessionLookup(sessionId) {
        const session = await this.getSessionById(sessionId);
        if (!session)
            return notFound(`/agent/session/${sessionId}`);
        return json({
            session: await this.serializeSession(session),
            agent: await this.buildAgentInfoForSession(session),
        });
    }
    async ensureRootSession() {
        let cachedRoot;
        if (this.rootSessionId) {
            const existing = await this.querySession(this.rootSessionId);
            if (existing && isActivePiRootSession(existing, this.agentName))
                return existing;
            if (existing && isPiRootSession(existing, this.agentName))
                cachedRoot = existing;
            this.rootSessionId = undefined;
        }
        const sessions = await this.querySessions();
        const existingRoot = sessions.find((session) => isActivePiRootSession(session, this.agentName)) ??
            cachedRoot ??
            sessions.find((session) => isPiRootSession(session, this.agentName));
        if (existingRoot) {
            this.rootSessionId = existingRoot.sessionId;
            return existingRoot;
        }
        // In clean mode, discovery-only migration deliberately does NOT create
        // pi-agent rows in the controller for legacy sessions until the user
        // touches them. If a legacy root session exists for this agent we must
        // materialize it right here — otherwise we would silently create a
        // brand-new empty root while a legacy root (potentially with hundreds
        // of messages) stays undiscoverable behind the compat boundary. The
        // legacy migrator handles primary-agent aliasing (main ↔ this.agentName)
        // inside listLegacySessions, so we do not need to double-check aliases.
        const migratedRoot = await this.migratePrimaryLegacyRoot();
        if (migratedRoot) {
            this.rootSessionId = migratedRoot.sessionId;
            return migratedRoot;
        }
        const session = await this.createSession({
            workspaceDir: this.resolveDefaultWorkspaceDir(),
            sessionType: 'root',
            title: 'Main',
            parentSessionId: null,
            isDefaultWorkspace: true,
            origin: 'root-repair',
        });
        this.rootSessionId = session.sessionId;
        return session;
    }
    async migratePrimaryLegacyRoot() {
        if (this.runtimeMode !== 'clean' || !this.legacyMigrator)
            return undefined;
        const sessions = await this.legacyMigrator.listLegacySessions(this.agentName);
        const root = sessions.find((session) => session.sessionType === 'root');
        if (!root)
            return undefined;
        try {
            return (await this.legacyMigrator.migrateSession(root.sessionId, { materialize: true }))
                ?.session;
        }
        catch {
            // Migration telemetry and failed stubs retain the error; the caller repairs the root.
            return undefined;
        }
    }
    async migrateLocalAgentLegacyRoot(record) {
        if (this.runtimeMode !== 'clean' || !this.legacyMigrator)
            return undefined;
        const rootId = await this.pickLegacyRootIdForAgent(record);
        if (!rootId)
            return undefined;
        try {
            const result = await this.legacyMigrator.migrateSession(rootId, { materialize: true });
            if (!result?.session)
                return undefined;
            if (result.session.sessionId !== record.rootSessionId) {
                await this.updateLocalAgentRoot(record, result.session.sessionId);
            }
            return result.session;
        }
        catch {
            // Keep the original recovery boundary, including a failed Agent pointer update.
            return undefined;
        }
    }
    async ensureLocalAgentRootSession(record) {
        const existing = await this.querySession(record.rootSessionId);
        if (existing && isPiRootSession(existing, record.name)) {
            return (await this.getMigrationAwareLocalAgentRoot(existing)) ?? existing;
        }
        const root = (await this.querySessions()).find((session) => session.agentName === record.name &&
            session.runtime === 'pi-agent' &&
            session.sessionType === 'root');
        if (root) {
            const checkedRoot = (await this.getMigrationAwareLocalAgentRoot(root)) ?? root;
            if (root.sessionId !== record.rootSessionId) {
                await this.updateLocalAgentRoot(record, checkedRoot.sessionId);
            }
            return checkedRoot;
        }
        // Legacy root fallback for custom (non-primary) agents.
        // seeds `record.rootSessionId` with the legacy id — but under discovery-only
        // migration no pi-agent row is created for that root until the user touches it,
        // so the two lookups above both return undefined. Without this branch we would
        // `createSession()` a fresh empty root and `updateLocalAgentRoot()` would rewrite
        // the agent's rootSessionId, orphaning the legacy history behind the pointer.
        // Materialize the legacy root instead, then keep the agent pointer pointing at
        // its (unchanged) session id.
        const migratedRoot = await this.migrateLocalAgentLegacyRoot(record);
        if (migratedRoot)
            return migratedRoot;
        const workspaceDir = record.defaultWorkspaceDir ?? this.resolveDefaultWorkspaceDir();
        const created = await this.createSession({
            agentName: record.name,
            workspaceDir,
            sessionType: 'root',
            title: 'Main',
            parentSessionId: null,
            isDefaultWorkspace: this.isDefaultLocalAgentRootWorkspace(record, workspaceDir),
            origin: 'root-repair',
        });
        await this.updateLocalAgentRoot(record, created.sessionId);
        return created;
    }
    isDefaultLocalAgentRootWorkspace(record, workspaceDir) {
        const workspace = normalizeAbsolutePath(workspaceDir);
        const runtimeDefault = normalizeAbsolutePath(this.resolveDefaultWorkspaceDir());
        if (!workspace || workspace === runtimeDefault)
            return true;
        const agentWorkspace = isValidLocalAgentName(record.name)
            ? join(this.configGetter().dataDir, 'agents', record.name, 'workspace')
            : undefined;
        return isAgentInternalDefaultWorkspaceDir(workspaceDir, agentWorkspace, record.name);
    }
    async pickLegacyRootIdForAgent(record) {
        if (!this.legacyMigrator)
            return undefined;
        // `listLegacySessions` already handles the primary agent alias
        // (main ↔ this.agentName) internally, but for custom agents the record
        // name is authoritative.
        const legacySessions = await this.legacyMigrator.listLegacySessions(record.name);
        if (legacySessions.length === 0)
            return undefined;
        const preferred = resolvePreferredLegacyRootSession(legacySessions, record.rootSessionId || undefined);
        return preferred?.sessionType === 'root' ? preferred.sessionId : undefined;
    }
    async getMigrationAwareLocalAgentRoot(session) {
        if (this.runtimeMode !== 'clean')
            return session;
        const checked = await this.getSessionById(session.sessionId);
        if (checked &&
            checked.agentName === session.agentName &&
            checked.runtime === 'pi-agent' &&
            checked.sessionType === 'root') {
            return checked;
        }
        return undefined;
    }
    async replaceRootSession(agentName, sessionId) {
        if (this.ctx.conversation) {
            return this.replaceConversationRootSession(agentName, sessionId);
        }
        return replaceStoredAgentRootSession({
            controller: this.controller,
            agentName: this.agentName,
            agentDisplayName: this.agentDisplayName,
            querySession: (id) => this.querySession(id),
            ensureRootSession: () => this.ensureRootSession(),
            getPreferredSessionForAgent: (name) => this.getPreferredSessionForAgent(name),
            getLocalAgent: (name) => this.getLocalAgent(name),
            abortLocalSessionTurn: (id) => this.abortLocalSessionTurn(id),
            updateOwnedSession: (id, fields) => this.updateOwnedSession(id, fields),
            setRootSessionId: (name, id) => this.setRootSessionId(name, id),
            publishGlobalEvent: (event) => this.publishGlobalEvent(event),
            resolveLocale: this.ctx.resolveLocale,
        }, agentName, sessionId);
    }
    async replaceConversationRootSession(agentName, sessionId) {
        const conversation = this.conversation;
        try {
            const replacement = await conversation.lifecycle.replaceRootSession(agentName, sessionId);
            if (agentName === this.agentName)
                this.rootSessionId = replacement.nextRoot.sessionId;
            return replacement.nextRoot;
        }
        catch (error) {
            logger.warn({ agentName, sessionId, err: error instanceof Error ? error.message : String(error) }, 'v2-owned root Session replacement failed');
            return undefined;
        }
    }
    async createSession(input) {
        const session = await this.conversation.lifecycle.createSession({
            ...input,
            agentName: input.agentName ?? this.agentName,
            sessionType: input.sessionType ?? 'branch',
            sessionKind: input.sessionKind ?? 'conversation',
            origin: input.origin ?? 'user',
        });
        logger.info({
            sessionId: session.sessionId,
            agentName: session.agentName,
            sessionType: session.sessionType,
            appMode: session.appMode ?? null,
        }, 'local session created');
        return session;
    }
    async requestLocalCompaction(agentName, sessionId, body) {
        const session = await this.getSessionById(sessionId);
        if (!session || session.agentName !== agentName) {
            return json({
                error: 'sessionId does not belong to this agent',
                code: 'FORBIDDEN',
            }, { status: 403 });
        }
        if (await this.ctx.isReadOnlyLegacySession(session))
            return readOnlyLegacySessionResponse();
        return this.ctx.requestCompaction(session, body);
    }
    getLocalAgent(name) {
        return this.management.getLocalAgent(name);
    }
    async ensurePrimaryAgentRecord() {
        const existing = await this.getLocalAgent(this.agentName);
        if (existing)
            return existing;
        const root = await this.ensureRootSession();
        return {
            name: this.agentName,
            displayName: this.agentDisplayName,
            creationSource: 'manual',
            rootSessionId: root.sessionId,
            createdAtMs: root.createdAtMs,
            updatedAtMs: this.nowMs(),
            defaultWorkspaceDir: this.resolveDefaultWorkspaceDir(),
        };
    }
    listLocalAgents() {
        return this.management.listLocalAgents();
    }
    /**
     * Create a brand-new local Pi agent and persist its root session.
     *
     * Used by `POST /mavis/api/agent` (with body). Without a body, the host
     *'s `ensureRootSession()` path returns the primary agent. With a body
     * (e.g. `{displayName, defaultWorkspaceDir, ...}`), this method mints a
     * fresh `agent-<hex12>` name (or uses the requested name), creates its
     * root session, and writes the local agent record. Returns 201 with
     * `{name, rootSessionId}`.
     */
    async createLocalAgent(body) {
        return this.management.createLocalAgent(body);
    }
    async updateLocalAgentRoot(record, rootSessionId) {
        // Persist the Agent Main pointer through the owning runtime port.
        await this.setRootSessionId(record.name, rootSessionId);
    }
    async setRootSessionId(agentName, rootSessionId) {
        if (agentName === this.agentName) {
            this.rootSessionId = rootSessionId;
        }
        // Primary agent is also present in the `agents` table (built-in mavis
        // seed); flip its `main_session_id` too so the desktop sidebar sees the
        // new root without waiting for a full refetch.
        const ok = await this.agentService.setMainSession(agentName, rootSessionId);
        if (!ok) {
            logger.warn({
                scope: 'agent-routes',
                op: 'setRootSessionId',
                agentName,
                rootSessionId,
            }, 'setMainSession: agent not found in agents store');
        }
    }
    async listAgentSessions(url, agentName = this.agentName) {
        return this.listAllSessions(agentName, readLocalSessionListOptions(url, { agentName }));
    }
    async listAgentInfos(options = {}) {
        await this.ensureRootSession();
        const localAgents = (await this.listLocalAgents()).filter((agent) => agent.name !== this.agentName);
        const sessionAgentNames = new Set((await this.listAllSessions())
            .map((session) => session.agentName)
            .filter((agentName) => agentName &&
            agentName !== this.agentName &&
            !localAgents.some((agent) => agent.name === agentName)));
        const legacyNames = await this.listLegacyAgentNames(localAgents, sessionAgentNames, options);
        return [
            await this.buildAgentInfo(this.agentName),
            ...(await Promise.all(localAgents.map((agent) => this.buildLocalAgentInfo(agent)))),
            ...(await Promise.all([...sessionAgentNames].map((agentName) => this.buildAgentInfo(agentName)))),
            ...(await Promise.all([...legacyNames].map((agentName) => this.runtimeMode === 'clean'
                ? this.buildCleanLegacyAgentInfo(agentName)
                : this.buildAgentInfo(agentName)))),
        ];
    }
    async listLegacyAgentNames(localAgents, sessionAgentNames, options) {
        if (this.runtimeMode === 'clean' && options.includeLegacy === false)
            return new Set();
        const sessions = this.runtimeMode === 'clean'
            ? ((await this.legacyMigrator?.listLegacySessions()) ?? [])
            : await this.getLegacyRuntime().listSessions();
        return new Set(sessions
            .map((session) => session.agentName)
            .filter((name) => name &&
            name !== this.agentName &&
            !(this.runtimeMode === 'clean' && name === LEGACY_PRIMARY_AGENT_NAME) &&
            !localAgents.some((agent) => agent.name === name) &&
            !sessionAgentNames.has(name)));
    }
    async buildAgentInfo(agentName = this.agentName) {
        if (agentName !== this.agentName) {
            const localAgent = await this.getLocalAgent(agentName);
            if (localAgent)
                return this.buildLocalAgentInfo(localAgent);
            const sessionBacked = await this.buildSessionBackedAgentInfo(agentName);
            if (sessionBacked)
                return sessionBacked;
            return this.buildLegacyAgentInfo(agentName);
        }
        const root = await this.ensureRootSession();
        const sessions = await this.listAgentInfoSessions(this.agentName);
        const override = await this.getLocalAgent(this.agentName);
        const now = this.nowMs();
        return {
            name: this.agentName,
            displayName: this.agentDisplayName,
            agentRole: 1,
            frameworkType: 'pi-agent',
            rootSessionId: root.sessionId,
            defaultWorkspaceDir: override?.defaultWorkspaceDir ?? this.resolveDefaultWorkspaceDir(),
            userDefaultWorkspaceDir: override?.defaultWorkspaceDir,
            sessionCount: sessions.filter((session) => session.agentName === this.agentName).length,
            createdAt: root.createdAtMs,
            updatedAt: Math.max(now, override?.updatedAtMs ?? 0),
            creationSource: 'builtin',
            isBuiltin: true,
            identity: {
                display_name: this.agentDisplayName,
                avatar: override?.avatar ?? DEFAULT_LOCAL_AGENT_AVATAR_URL,
            },
            description: override?.description ?? 'Local Pi runtime agent',
            ...(override?.persona ? { persona: override.persona } : {}),
            ...(override?.systemPrompt ? { systemPrompt: override.systemPrompt } : {}),
            channel: await this.ctx.getAgentChannelConfig?.(this.agentName),
        };
    }
    async buildLocalAgentInfo(record) {
        const root = await this.ensureLocalAgentRootSession(record);
        const sessions = await this.listAgentInfoSessions(record.name);
        const updatedAt = Math.max(record.updatedAtMs, ...sessions.map((session) => session.updatedAtMs));
        return {
            name: record.name,
            displayName: record.displayName,
            agentRole: 0,
            frameworkType: 'pi-agent',
            rootSessionId: root.sessionId,
            defaultWorkspaceDir: record.defaultWorkspaceDir ?? this.resolveDefaultWorkspaceDir(),
            userDefaultWorkspaceDir: record.defaultWorkspaceDir,
            sessionCount: sessions.filter((session) => session.agentName === record.name).length,
            createdAt: record.createdAtMs,
            updatedAt,
            creationSource: record.creationSource,
            isBuiltin: false,
            identity: {
                display_name: record.displayName,
                avatar: record.avatar ?? DEFAULT_LOCAL_AGENT_AVATAR_URL,
            },
            description: record.description ?? '',
            ...(record.persona ? { persona: record.persona } : {}),
            ...(record.systemPrompt ? { systemPrompt: record.systemPrompt } : {}),
            channel: await this.ctx.getAgentChannelConfig?.(record.name),
        };
    }
    async buildSessionBackedAgentInfo(agentName) {
        const sessions = await this.listAgentInfoSessions(agentName);
        const root = sessions.find((session) => session.sessionType === 'root') ?? sessions[0];
        if (!root)
            return undefined;
        const updatedAt = Math.max(...sessions.map((session) => session.updatedAtMs));
        return {
            name: agentName,
            displayName: agentName,
            agentRole: 0,
            frameworkType: 'pi-agent',
            rootSessionId: root.sessionId,
            defaultWorkspaceDir: root.workspaceDir ?? this.resolveDefaultWorkspaceDir(),
            sessionCount: sessions.filter((session) => session.agentName === agentName).length,
            createdAt: root.createdAtMs,
            updatedAt,
            creationSource: 'manual',
            isBuiltin: false,
            identity: {
                display_name: agentName,
                avatar: DEFAULT_LOCAL_AGENT_AVATAR_URL,
            },
            description: '',
        };
    }
    async buildCleanLegacyAgentInfo(agentName) {
        const sessions = (await this.legacyMigrator?.listLegacySessions(agentName)) ?? [];
        const legacyAgent = await this.legacyMigrator?.getLegacyAgent(agentName);
        const root = resolvePreferredLegacyRootSession(sessions, legacyAgent?.rootSessionId);
        const now = this.nowMs();
        return {
            name: agentName,
            ...buildLegacyAgentIdentity(legacyAgent, agentName),
            agentRole: 1,
            frameworkType: 'pi-agent',
            rootSessionId: root?.sessionId ?? null,
            defaultWorkspaceDir: legacyAgent?.defaultWorkspaceDir ?? root?.workspaceDir ?? this.resolveDefaultWorkspaceDir(),
            userDefaultWorkspaceDir: legacyAgent?.defaultWorkspaceDir,
            sessionCount: sessions.length,
            createdAt: legacyAgent?.createdAtMs ?? root?.createdAtMs ?? now,
            updatedAt: Math.max(legacyAgent?.updatedAtMs ?? 0, root?.updatedAtMs ?? now),
            creationSource: 'legacy-import',
            isBuiltin: true,
        };
    }
    async listAgentInfoSessions(agentName) {
        if (this.runtimeMode !== 'clean')
            return this.listAllSessions(agentName);
        const local = await Promise.all((await this.querySessions({ agentName })).map((session) => this.normalizeCleanLocalSession(session)));
        const legacy = (await this.legacyMigrator?.listLegacySessions(agentName)) ?? [];
        const legacyAlias = agentName === this.agentName && agentName !== LEGACY_PRIMARY_AGENT_NAME
            ? ((await this.legacyMigrator?.listLegacySessions(LEGACY_PRIMARY_AGENT_NAME)) ?? [])
            : [];
        const byId = new Map();
        // Legacy discovery-only stubs land here with `runtime === 'opencode'`.
        // Present them as pi-agent so the wire `frameworkType` reflects the
        // clean-mode "no legacy concept" invariant — otherwise the UI hides
        // the composer input on every session the user has never opened. See
        // `presentLegacyStubAsPiAgent` docs for the full rationale.
        for (const session of legacy) {
            byId.set(session.sessionId, presentLegacyStubAsPiAgent(session));
        }
        for (const session of legacyAlias) {
            byId.set(session.sessionId, presentLegacyStubAsPiAgent(session, {
                primaryAgentName: this.agentName,
                legacyPrimaryAgentName: LEGACY_PRIMARY_AGENT_NAME,
            }));
        }
        for (const session of local) {
            if (session)
                byId.set(session.sessionId, session);
        }
        return [...byId.values()];
    }
    async listSessionsForTree() {
        if (this.runtimeMode !== 'clean')
            return this.listAllSessions();
        const local = await Promise.all((await this.querySessions()).map((session) => this.normalizeCleanLocalSession(session)));
        const legacy = (await this.legacyMigrator?.listLegacySessions()) ?? [];
        // Discovery-only migration pass — mirrors what `GET /agent/:name/session`
        // does. Keeps the two entry points (tree + flat list) aligned: both
        // upsert a cheap `local_runtime_legacy_migrations` row per legacy
        // session, and neither builds a local pi-agent session row / agent row
        // until an on-demand path materializes it (`migrateSession(...,
        // { materialize: true })` above) or the user sends a message. Failed discoveries surface
        // via the existing `failedRecords` branch below so we intentionally
        // swallow the telemetry emit here (tree renders don't need per-session
        // failure fan-out — the sidebar just shows the failed stub).
        if (this.legacyMigrator && legacy.length > 0) {
            await migrateLegacySessionsForList({
                sessions: legacy,
                legacyMigrator: this.legacyMigrator,
                controller: this.controller,
                normalizeStalePiSession: async (session) => session,
                emitLegacyMigrationTelemetry: () => { },
            });
        }
        const byId = new Map();
        for (const session of legacy)
            byId.set(session.sessionId, session);
        for (const session of local) {
            if (session)
                byId.set(session.sessionId, session);
        }
        await this.attachFailedMigrationStubs(byId);
        const results = [...byId.values()];
        // Fold legacy `main` alias into the current primary agent name AND
        // present `runtime === 'opencode'` discovery stubs as pi-agent so the
        // wire `frameworkType` reflects the clean-mode invariant. Both concerns
        // live in the same helper so they cannot drift out of sync — see
        // `presentLegacyStubAsPiAgent` docs in `host-support.ts`. Successfully
        // materialized pi-agent rows and failed stubs (already
        // `runtime === 'pi-agent'` via `buildFailedLegacyMigrationStub`) pass
        // through unchanged.
        return presentLegacyStubsAsPiAgent(results, {
            primaryAgentName: this.agentName,
            legacyPrimaryAgentName: LEGACY_PRIMARY_AGENT_NAME,
        });
    }
    async attachFailedMigrationStubs(byId) {
        const failedRecords = (await this.legacyMigrator?.listMigrationRecords())?.filter((record) => record.status === 'failed') ?? [];
        for (const record of failedRecords) {
            const session = byId.get(record.localSessionId) ?? byId.get(record.legacySessionId);
            if (!session)
                continue;
            byId.set(record.localSessionId, buildFailedLegacyMigrationStub(session, new LegacyOpencodeMigrationError(record, record.error ?? new Error('Previous legacy opencode session migration failed.')), record));
            if (record.legacySessionId !== record.localSessionId)
                byId.delete(record.legacySessionId);
        }
    }
    async buildAgentInfoForSession(session) {
        if (session.runtime === 'opencode') {
            return this.runtimeMode === 'clean'
                ? this.buildCleanLegacyAgentInfo(session.agentName)
                : this.buildLegacyAgentInfo(session.agentName);
        }
        return this.buildAgentInfo(session.agentName);
    }
    async buildLegacyAgentInfo(agentName) {
        const sessions = await this.getLegacyRuntime().listSessions(agentName);
        const root = sessions[0];
        const now = this.nowMs();
        return {
            name: agentName,
            displayName: agentName,
            agentRole: 1,
            frameworkType: 'opencode',
            rootSessionId: root?.sessionId ?? null,
            sessionCount: sessions.length,
            createdAt: root?.createdAtMs ?? now,
            updatedAt: root?.updatedAtMs ?? now,
            creationSource: 'legacy',
            isBuiltin: true,
            identity: { display_name: agentName, avatar: DEFAULT_LOCAL_AGENT_AVATAR_URL },
            description: 'Legacy opencode runtime agent',
        };
    }
    async hasLegacyAgent(agentName) {
        if (this.runtimeMode === 'clean') {
            const sessions = await this.legacyMigrator?.listLegacySessions(agentName);
            return (sessions?.length ?? 0) > 0;
        }
        return (await this.getLegacyRuntime().listSessions(agentName)).length > 0;
    }
    async getPreferredSessionForAgent(agentName) {
        let preferredRootSessionId;
        if (this.runtimeMode === 'clean') {
            const legacySessions = (await this.legacyMigrator?.listLegacySessions(agentName)) ?? [];
            const legacyAgent = await this.legacyMigrator?.getLegacyAgent(agentName);
            preferredRootSessionId = legacyAgent?.rootSessionId;
            const preferred = resolvePreferredLegacyRootSession(legacySessions, preferredRootSessionId);
            const preferredMigration = preferred
                ? await this.legacyMigrator?.getMigrationRecordForLegacySession(preferred.sessionId)
                : undefined;
            if (preferred && preferredMigration?.status !== 'failed')
                return preferred;
        }
        const sessions = await this.listAllSessions(agentName);
        if (this.runtimeMode === 'clean') {
            const preferred = resolvePreferredLegacyRootSession(sessions, preferredRootSessionId);
            if (preferred)
                return preferred;
        }
        return sessions.find((session) => session.sessionType === 'root') ?? sessions[0];
    }
}
//# sourceMappingURL=agents.js.map