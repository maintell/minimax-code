import { randomUUID } from 'node:crypto';
import { hasConversationTaskModelSelection, } from '@mavis/conversation-contract';
import { isCurrentSessionAgentDefinition, withCurrentSessionAgentDefinitionProject, } from '../repo/agent-binding.js';
import { isTaskSession } from '../repo/drizzle/normalization.js';
import { isAgentNotFoundError, reportDeletedAgentBackfillSkip, } from './backfill-diagnostics.js';
import { SessionServiceError } from '../errors.js';
import { isDefaultProjectWorkspace } from '../../shared/project-workspace.js';
import { decideToolCallMode } from '../support/tool-call-mode.js';
import { assertNativeMutation, assertPluginAgentTaskSession, assertTaskParent, createDefaultWorkspaceIdentity, errorMessage, internalDefaultWorkspaceIdentity, internalExplicitWorkspaceDir, resolveRequestedRunLocation, modelKey, nonEmpty, normalizeAppMode, normalizeSessionMutation, optionalModelVariant, sessionCaptureCandidate, sessionNotFound, taskAdvisorFor, taskMemoryPolicyFor, taskWorkspaceFor, toInternalMetadataCreateInput, toMetadataCreateInput, visibilityForInternalKind, visibilityForKind, whenPresent, } from './record-service-fields.js';
export class SessionRecordService {
    deps;
    captureAgentShell;
    bindAgentShellCapture(capture) {
        this.captureAgentShell = capture;
    }
    makeSessionId;
    taskAgentBindingCapture;
    constructor(deps) {
        this.deps = deps;
        this.makeSessionId = deps.makeSessionId ?? (() => `mvs_${randomUUID().replaceAll('-', '')}`);
        this.taskAgentBindingCapture = deps.taskAgentBindingCapture;
    }
    /** Bound by production composition only after Agent and ModelSystem are ready. */
    bindTaskAgentBindingCapture(capture) {
        this.taskAgentBindingCapture = capture;
    }
    isTaskSession(session) {
        return isTaskSession(session);
    }
    /**
     * Read gate for frozen Task execution. A missing or V1 definition is upgraded
     * before execution; ordinary Sessions always read the live Agent definition.
     */
    async ensureSessionAgentDefinition(sessionId) {
        const session = await this.requireSession(sessionId);
        if (!isTaskSession(session))
            return undefined;
        const bindings = this.requireSessionAgentBindings();
        const existing = await bindings.getSessionAgentDefinition(sessionId);
        if (existing && isCurrentSessionAgentDefinition(existing.definition))
            return existing;
        const legacyDefinition = existing && !isCurrentSessionAgentDefinition(existing.definition)
            ? existing.definition
            : undefined;
        const parent = await this.resolveParent(session.parentSessionId);
        const backfill = await this.captureHistoricalSessionAgentDefinition({
            agentName: session.agentName,
            session,
            parent,
            appMode: session.appMode,
            ...(legacyDefinition ? { legacyDefinition } : {}),
        });
        if (existing) {
            return bindings.replaceSessionAgentDefinitionIfLegacy(sessionId, backfill);
        }
        return bindings.backfillSessionAgentDefinitionIfAbsent(sessionId, backfill);
    }
    /** Reads historical routing identity without creating or upgrading a definition. */
    async readSessionAgentRouting(sessionId) {
        const session = await this.deps.sessions.get(sessionId);
        if (!session)
            return undefined;
        const definition = await this.deps.agentBindings?.getSessionAgentDefinition(sessionId);
        return { session, ...(definition ? { definition } : {}) };
    }
    /** Startup gate: complete/upgrade historical rows before inbound Turn admission. */
    async backfillAllSessionAgentDefinitions() {
        const sessions = this.deps.sessions;
        if (!sessions.listPage) {
            throw new SessionServiceError('task-agent-capture-unavailable', 'Session Agent definition enumeration is unavailable');
        }
        let cursor;
        do {
            const page = await sessions.listPage({ ...(cursor ? { cursor } : {}), limit: 100 });
            for (const session of page.sessions) {
                await this.backfillSessionAgentDefinitionForStartup(session);
            }
            cursor = page.nextCursor;
            if (!page.hasMore)
                return;
        } while (cursor);
    }
    async backfillSessionAgentDefinitionForStartup(session) {
        if (!isTaskSession(session))
            return;
        try {
            await this.ensureSessionAgentDefinition(session.sessionId);
        }
        catch (error) {
            // Startup backfill sweep tolerates a deleted historical Agent so one dead
            // reference does not stop the runtime from reaching `ready()`. Explicit
            // Session reopen still fails closed through ensureSessionAgentDefinition.
            if (!isAgentNotFoundError(error))
                throw error;
            reportDeletedAgentBackfillSkip(session, this.deps.backfillDiagnostics);
        }
    }
    /** Backfills only the frozen definition of a historical Task, once. */
    async ensureTaskAgentBinding(sessionId) {
        const bindings = this.deps.agentBindings;
        if (!bindings) {
            throw new SessionServiceError('task-agent-capture-unavailable', 'Task Session Agent binding persistence is unavailable');
        }
        const existing = await bindings.getTaskAgentBinding(sessionId);
        if (existing)
            return existing;
        const session = await this.requireSession(sessionId);
        if (!isTaskSession(session)) {
            throw new SessionServiceError('invalid-session-kind', 'Task Agent binding requires a Task Session');
        }
        const parent = await this.resolveParent(session.parentSessionId);
        if (!parent) {
            throw new SessionServiceError('parent-required', 'task Session requires a parent Session');
        }
        const backfill = await this.captureHistoricalTaskAgentBinding({
            agentName: session.agentName,
            parent,
            appMode: session.appMode,
        });
        return bindings.backfillTaskAgentBindingIfAbsent(sessionId, backfill);
    }
    async createSession(input) {
        const context = await this.prepareSessionCreate(input);
        return this.createRecord(toMetadataCreateInput(context));
    }
    async createInternalSession(input) {
        const context = await this.prepareInternalSessionCreate(input);
        return this.createRecord(toInternalMetadataCreateInput(context));
    }
    resolveCreateModel(input) {
        if (input.sessionKind === 'task' || !input.model)
            return input;
        if (!this.deps.resolveRequestedModel)
            throw new Error('Session model resolution is unavailable');
        return { ...input, model: this.deps.resolveRequestedModel(input.model) };
    }
    async prepareSessionCreate(requested) {
        const sessionId = requested.sessionId ?? this.makeSessionId();
        const agent = await this.requireAgentDefaults(requested.agentName);
        const parent = await this.resolveParent(requested.parentSessionId);
        const input = this.resolveCreateModel(requested);
        const sessionKind = input.sessionKind ?? 'conversation';
        assertTaskParent(sessionKind, parent);
        const explicitWorkspaceDir = nonEmpty(input.workspaceDir);
        const workspace = await this.resolveCreateWorkspace({
            sessionId,
            sessionKind,
            parent,
            explicitWorkspaceDir,
            agent,
        });
        const appMode = normalizeAppMode(input.appMode ?? parent?.appMode);
        const runLocation = await this.resolveCreateRunLocation(input.runLocation, appMode, workspace.workspaceDir);
        const isDefaultWorkspace = createDefaultWorkspaceIdentity({
            taskWorkspace: workspace.taskWorkspace,
            parent,
            runLocation,
            explicitWorkspaceDir,
            requested: input.isDefaultWorkspace,
            preserveRequested: input.preserveDefaultWorkspaceIdentity === true,
        });
        const taskCapture = await this.captureSessionAgentDefinition({
            agentName: input.agentName,
            ...(input.model ? { requestedModel: input.model } : {}),
            session: sessionCaptureCandidate({
                sessionId,
                agentName: input.agentName,
                workspaceDir: workspace.taskWorkspace ?? runLocation?.resolvedDir ?? workspace.workspaceDir,
                isDefaultWorkspace,
                sessionType: 'branch',
                sessionKind,
                parentSessionId: input.parentSessionId ?? null,
                visibility: visibilityForKind(sessionKind, input.visibility, parent?.visibility) ?? 'visible',
                appMode,
                effectiveModel: modelKey(input.model?.providerId, input.model?.modelId),
                effectiveModelVariant: optionalModelVariant(input.model?.variant),
                effectiveModelContextWindow: input.effectiveModelContextWindow,
                effectiveModelMaxOutputTokens: input.effectiveModelMaxOutputTokens,
            }),
            parent,
            appMode,
        });
        return {
            input,
            sessionId,
            requestedWorkspaceDir: workspace.workspaceDir,
            appMode,
            runLocation,
            ...(input.projectWorkspaceDir ? { projectWorkspaceDir: input.projectWorkspaceDir } : {}),
            taskWorkspace: workspace.taskWorkspace,
            isDefaultWorkspace,
            parentVisibility: parent?.visibility,
            taskMemoryPolicy: taskMemoryPolicyFor(sessionKind, parent),
            taskAdvisor: taskAdvisorFor(sessionKind, parent),
            taskCapture,
        };
    }
    async prepareInternalSessionCreate(requested) {
        const sessionId = this.makeSessionId();
        const agent = await this.requireAgentDefaults(requested.agentName);
        const parent = await this.resolveParent(requested.parentSessionId);
        const sessionKind = requested.sessionKind ?? 'conversation';
        assertTaskParent(sessionKind, parent);
        const taskWorkspace = taskWorkspaceFor(sessionKind, parent);
        const explicitWorkspaceDir = taskWorkspace ?? internalExplicitWorkspaceDir(requested);
        const workspace = await this.resolveCreateWorkspace({
            sessionId,
            sessionKind,
            parent,
            explicitWorkspaceDir,
            agent,
        });
        const runLocation = await resolveRequestedRunLocation(requested, workspace.workspaceDir, (r, dir) => this.resolveRunLocation(r, dir));
        const input = { ...requested, ...whenPresent('runLocation', runLocation) };
        const appMode = input.appMode ?? parent?.appMode;
        const sessionType = input.sessionType ?? 'branch';
        const isDefaultWorkspace = taskWorkspace !== undefined
            ? parent?.isDefaultWorkspace === true
            : internalDefaultWorkspaceIdentity(input, workspace.implicitDefaultWorkspace);
        const workspaceDir = taskWorkspace ?? input.runLocation?.resolvedDir ?? workspace.workspaceDir;
        const definition = await this.prepareInternalAgentDefinition({
            input,
            sessionId,
            parent,
            sessionKind,
            sessionType,
            workspaceDir,
            isDefaultWorkspace,
            appMode,
            taskModelSelection: input.taskModelSelection,
        });
        return {
            input,
            sessionId,
            parent,
            sessionKind,
            taskWorkspace,
            workspace,
            taskMemoryPolicy: taskMemoryPolicyFor(sessionKind, parent),
            taskAdvisor: taskAdvisorFor(sessionKind, parent),
            workspaceDir,
            isDefaultWorkspace,
            ...definition,
        };
    }
    async prepareInternalAgentDefinition(input) {
        const session = sessionCaptureCandidate({
            sessionId: input.sessionId,
            agentName: input.input.agentName,
            workspaceDir: input.workspaceDir,
            isDefaultWorkspace: input.isDefaultWorkspace,
            sessionType: input.sessionType,
            sessionKind: input.sessionKind,
            parentSessionId: input.input.parentSessionId ?? null,
            visibility: visibilityForInternalKind(input.sessionKind, input.input.visibility, input.parent?.visibility) ?? 'visible',
            appMode: input.appMode,
            effectiveModel: input.input.effectiveModel,
            effectiveModelVariant: input.input.effectiveModelVariant,
            effectiveModelThinking: input.input.effectiveModelThinking,
            effectiveModelContextWindow: input.input.effectiveModelContextWindow,
            effectiveModelMaxOutputTokens: input.input.effectiveModelMaxOutputTokens,
        });
        if (input.input.forkedAgentDefinition && isTaskSession(session)) {
            return {
                taskCapture: undefined,
                forkedAgentDefinition: withCurrentSessionAgentDefinitionProject(input.input.forkedAgentDefinition, {
                    workspaceDir: input.workspaceDir,
                    isDefaultWorkspace: input.isDefaultWorkspace,
                }),
            };
        }
        return {
            forkedAgentDefinition: undefined,
            taskCapture: await this.captureSessionAgentDefinition({
                agentName: input.input.agentName,
                session,
                parent: input.parent,
                appMode: input.appMode,
                ...(hasConversationTaskModelSelection(input.taskModelSelection)
                    ? { taskModelSelection: input.taskModelSelection }
                    : {}),
                pluginAgent: input.input.pluginAgentDefinition,
            }),
        };
    }
    async resolveCreateWorkspace(input) {
        const taskWorkspace = taskWorkspaceFor(input.sessionKind, input.parent);
        if (taskWorkspace) {
            return {
                workspaceDir: taskWorkspace,
                implicitDefaultWorkspace: input.parent?.isDefaultWorkspace === true,
                taskWorkspace,
            };
        }
        const workspace = await this.resolveWorkspace(input.sessionId, input.explicitWorkspaceDir, input.agent);
        return { ...workspace, taskWorkspace };
    }
    async resolveCreateRunLocation(requested, appMode, workspaceDir) {
        if (!requested || appMode !== 'coding')
            return undefined;
        return this.resolveRunLocation(requested, workspaceDir);
    }
    async createRootSession(input) {
        const sessionId = this.makeSessionId();
        const explicitWorkspaceDir = nonEmpty(input.workspaceDir);
        const agent = explicitWorkspaceDir ? {} : await this.requireAgentDefaults(input.agentName);
        const workspace = await this.resolveWorkspace(sessionId, explicitWorkspaceDir, agent);
        const isDefaultWorkspace = this.rootWorkspaceIdentity({
            agentName: input.agentName,
            sessionId,
            requested: input.isDefaultWorkspace,
            workspace,
        });
        const hidden = await this.deps.agentSurfaces?.hidesRootSessions(input.agentName);
        return this.createRecord({
            sessionId,
            agentName: input.agentName,
            workspaceDir: workspace.workspaceDir,
            isDefaultWorkspace,
            sessionType: 'root',
            sessionKind: 'conversation',
            title: 'Main',
            visibility: hidden ? 'hidden' : 'visible',
            titleSource: 'auto',
            parentSessionId: null,
            origin: 'root-repair',
        });
    }
    async resolveWorkspace(sessionId, explicitWorkspaceDir, agent) {
        if (explicitWorkspaceDir) {
            return { workspaceDir: explicitWorkspaceDir, implicitDefaultWorkspace: false };
        }
        const agentDefaultWorkspaceDir = nonEmpty(agent.defaultWorkspaceDir);
        if (agentDefaultWorkspaceDir) {
            return {
                workspaceDir: agentDefaultWorkspaceDir,
                implicitDefaultWorkspace: true,
                agentDefaultWorkspaceDir,
            };
        }
        const sessionDefaultWorkspaceDir = nonEmpty(this.deps.sessionDefaultWorkspaceDir?.(sessionId));
        if (!sessionDefaultWorkspaceDir) {
            throw new SessionServiceError('workspace-required', 'Session workspace directory is required');
        }
        await this.deps.workspace?.initialize(sessionDefaultWorkspaceDir);
        return { workspaceDir: sessionDefaultWorkspaceDir, implicitDefaultWorkspace: true };
    }
    rootWorkspaceIdentity(input) {
        if (input.requested !== undefined)
            return input.requested;
        if (input.workspace.agentDefaultWorkspaceDir === undefined) {
            return input.workspace.implicitDefaultWorkspace;
        }
        return isDefaultProjectWorkspace({
            sessionId: input.sessionId,
            workspaceDir: input.workspace.workspaceDir,
            defaultWorkspaceDir: this.deps.defaultWorkspaceDir?.(),
            sessionDefaultWorkspaceDir: this.deps.sessionDefaultWorkspaceDir?.(input.sessionId),
            agentInternalWorkspaceDir: this.deps.agentInternalWorkspaceDir?.(input.agentName),
            agentName: input.agentName,
        });
    }
    async captureSessionAgentDefinition(input) {
        assertPluginAgentTaskSession(input.session, input.pluginAgent);
        if (!isTaskSession(input.session))
            return undefined;
        const capture = this.taskAgentBindingCapture;
        if (!capture) {
            throw new SessionServiceError('task-agent-capture-unavailable', 'Session Agent definition capture is unavailable');
        }
        const parentDefinition = input.parent
            ? await this.deps.agentBindings?.getSessionAgentDefinition(input.parent.sessionId)
            : undefined;
        const parentModel = parentDefinition?.definition.definitionVersion === 2
            ? parentDefinition.definition.model
            : undefined;
        return capture.capture({
            agentName: input.agentName,
            session: input.session,
            ...(input.parent ? { parent: input.parent } : {}),
            ...(input.appMode ? { appMode: input.appMode } : {}),
            ...(parentModel?.parameterSnapshot ? { parentModel } : {}),
            ...(input.requestedModel ? { requestedModel: input.requestedModel } : {}),
            ...(hasConversationTaskModelSelection(input.taskModelSelection)
                ? { taskModelSelection: input.taskModelSelection }
                : {}),
            pluginAgent: input.pluginAgent,
        });
    }
    async captureHistoricalTaskAgentBinding(input) {
        const capture = this.taskAgentBindingCapture;
        if (!capture) {
            throw new SessionServiceError('task-agent-capture-unavailable', 'Task Agent binding capture is unavailable');
        }
        return capture.captureFrozenDefinition({
            agentName: input.agentName,
            parent: input.parent,
            ...(input.appMode ? { appMode: input.appMode } : {}),
        });
    }
    requireSessionAgentBindings() {
        const bindings = this.deps.agentBindings;
        if (!bindings) {
            throw new SessionServiceError('task-agent-capture-unavailable', 'Session Agent definition persistence is unavailable');
        }
        return bindings;
    }
    async captureHistoricalSessionAgentDefinition(input) {
        const capture = this.taskAgentBindingCapture;
        if (!capture) {
            throw new SessionServiceError('task-agent-capture-unavailable', 'Session Agent definition capture is unavailable');
        }
        return capture.captureSessionDefinition({
            agentName: input.agentName,
            session: input.session,
            ...(input.parent ? { parent: input.parent } : {}),
            ...(input.appMode ? { appMode: input.appMode } : {}),
            ...(input.legacyDefinition ? { legacyDefinition: input.legacyDefinition } : {}),
        });
    }
    async requireAgentDefaults(agentName) {
        const agent = await this.deps.agents.getDefaults(agentName);
        if (agent)
            return agent;
        throw new SessionServiceError('agent-not-found', `Agent not found: ${agentName}`);
    }
    async mutateSession(sessionId, fields, expectedModel, expectedTitle) {
        const signal = expectedTitle?.signal;
        signal?.throwIfAborted();
        const current = await this.requireSession(sessionId);
        signal?.throwIfAborted();
        assertNativeMutation(current);
        if (fields.title !== undefined &&
            fields.title !== null &&
            (await this.deps.titlePolicy.blocks(fields.title, current))) {
            throw new SessionServiceError('content-policy-rejected', 'Content validation failed');
        }
        const normalizedFields = normalizeSessionMutation(current, fields);
        // Policy checks may involve remote I/O. Revocation must be checked at the
        // durable write boundary, not only before starting that request.
        signal?.throwIfAborted();
        if (Object.keys(normalizedFields).length === 0)
            return current;
        const updated = await this.deps.metadata.update(sessionId, normalizedFields, expectedModel, expectedTitle);
        if (!updated)
            throw sessionNotFound(sessionId);
        if (Object.hasOwn(normalizedFields, 'visibility') &&
            (current.visibility ?? 'visible') !== (updated.visibility ?? 'visible')) {
            this.deps.facts.handle({ kind: 'visibility-updated', session: updated });
        }
        return updated;
    }
    deleteSessionRecord(sessionId) {
        return this.deps.metadata.delete(sessionId);
    }
    async discardCreatedSession(sessionId) {
        const failures = await this.cleanupCreatedSession(sessionId);
        if (failures.length > 0) {
            throw new AggregateError(failures, `Transient Session cleanup failed: ${sessionId}`);
        }
        this.deps.facts.handle({ kind: 'deleted', sessionId });
    }
    async requireSession(sessionId) {
        const session = await this.deps.sessions.get(sessionId);
        if (!session)
            throw sessionNotFound(sessionId);
        return session;
    }
    async createRecord(input) {
        const capture = await this.captureAgentShell?.(input.parentSessionId);
        const toolCallMode = decideToolCallMode(this.deps.toolCallMode, input.toolCallMode);
        const created = await this.deps.metadata.create({
            ...input,
            ...(capture?.agentShell ? { agentShell: capture.agentShell } : {}),
            ...(capture?.agentShellPreference
                ? { agentShellPreference: capture.agentShellPreference }
                : {}),
            ...toolCallMode.fields,
        });
        try {
            await this.deps.artifacts?.initialize(created.sessionId);
        }
        catch (error) {
            await this.compensateCreate(created.sessionId, error);
        }
        this.deps.facts.handle({ kind: 'created', session: created });
        return toolCallMode.recorded(created);
    }
    async compensateCreate(sessionId, original) {
        const failures = await this.cleanupCreatedSession(sessionId);
        if (failures.length > 0) {
            throw new AggregateError([original, ...failures], `${errorMessage(original)}; Session create compensation failed`);
        }
        throw original;
    }
    async cleanupCreatedSession(sessionId) {
        try {
            await this.deps.artifacts?.delete(sessionId);
        }
        catch (error) {
            // Artifact deletion resolves its path from the Session row. Preserve the
            // row on failure so the whole compensation remains retryable.
            return [error];
        }
        try {
            await this.deps.metadata.delete(sessionId);
            return [];
        }
        catch (error) {
            return [error];
        }
    }
    async resolveParent(parentSessionId) {
        if (!parentSessionId)
            return undefined;
        const parent = await this.deps.sessions.get(parentSessionId);
        if (!parent)
            throw new SessionServiceError('parent-not-found', `Parent Session not found: ${parentSessionId}`);
        return parent;
    }
    async resolveRunLocation(input, workspaceDir) {
        try {
            return await this.deps.runLocation.resolve(input, workspaceDir);
        }
        catch (error) {
            const code = error && typeof error === 'object' && typeof Reflect.get(error, 'code') === 'string'
                ? String(Reflect.get(error, 'code'))
                : undefined;
            throw new SessionServiceError('run-location-invalid', errorMessage(error), code);
        }
    }
}
//# sourceMappingURL=record-service.js.map