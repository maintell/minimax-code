import { randomUUID } from 'node:crypto';
import { isDefaultAgentAvatarMarker } from '@mavis/shared/agent-avatar';
import { BoundedInternalTurnPromptReadRegistry, isPromptSnapshotInvalidError, } from '@mavis/agent-runtime';
import { AgentServiceError, AgentImportService, } from '../../service/agent/index.js';
import { SAFETY_SCENE, } from '../../service/content-safety/index.js';
import { publishBestEffort } from '../events.js';
/** Binds the runtime-owned safety and lifecycle capabilities to Agent workflows. */
export function createRuntimeAgentApplication(input, applications) {
    const { options, safety } = input;
    return new AgentApplication({
        service: input.agentService,
        root: applications.session.root,
        publish: input.writeGlobalEvent,
        deleteAgentCronTasks: (agentName) => options.compatibility.cron.deleteAgentTasks(agentName),
        removeAgentPin: (agentName) => input.pinService.removeAgent(agentName),
        reviewConfigFields: (values) => reviewAgentConfigFields(safety, values),
        greeting: {
            enabled: options.greetingEnabled === true,
            canSend: () => options.compatibility.greeting.canSend(),
            sendSystemReminder: (reminder) => options.compatibility.greeting.sendSystemReminder(reminder),
            promptReads: input.internalTurnPromptReads,
            ...(input.product.promptSnapshots ? { promptSnapshots: input.product.promptSnapshots } : {}),
        },
    });
}
/**
 * Cross-capability Agent workflows. The Agent service remains the Agent owner;
 * this class only sequences Agent persistence with the existing Root owner.
 */
export class AgentApplication {
    options;
    closed = false;
    ensureBuiltinPromise;
    ensureBuiltinDefinitionsPromise;
    greetingInFlight = new Set();
    pendingGreetingByTurn = new Map();
    /** Ephemeral only: opaque scopes never enter queue storage, history, or public APIs. */
    promptReads;
    constructor(options) {
        this.options = options;
        this.promptReads = options.greeting?.promptReads ?? new BoundedInternalTurnPromptReadRegistry();
    }
    /** Consumed by TurnPreflight once an internally rendered Turn owns its lease. */
    takeInternalTurnPromptRead(turnId) {
        return this.promptReads.take(turnId);
    }
    close() {
        this.closed = true;
        this.promptReads.close();
        this.pendingGreetingByTurn.clear();
        this.greetingInFlight.clear();
    }
    list(options) {
        return this.options.service.list(options);
    }
    get(requestRef, options) {
        return this.options.service.get(requestRef, options);
    }
    getConfigDocument(requestRef) {
        return this.options.service.getConfigDocument(requestRef);
    }
    async putConfigDocument(input) {
        await this.reviewConfigFields([input.content]);
        return this.options.service.putConfigDocument(input);
    }
    resolveAgentWriteTarget(requestRef) {
        return this.options.service.resolveAgentWriteTarget(requestRef);
    }
    getLegacyHistoryNotice(requestRef) {
        return this.options.service.getLegacyHistoryNotice(requestRef);
    }
    /**
     * Definition-only creation: no Root, no Session, no greeting (product
     * decision 2026-09-04; the legacy Root-materializing `create` path was
     * removed after the V2 HTTP endpoint retired it). The management page
     * creates a regular top-level Session only when the user explicitly
     * chooses Chat.
     */
    async createDefinition(input) {
        await this.reviewConfigFields(createDefinitionReviewFields(input));
        const created = await this.options.service.create(input);
        publishBestEffort(this.options.publish ?? (() => undefined), {
            type: 'agent.created',
            payload: { agentName: created.exactOwnerName },
        });
        return created;
    }
    /**
     * Creates an imported Custom Agent definition only. In particular this must
     * not ask the Root application to materialize a Root/Session: Chat owns that
     * later, explicit action.
     */
    async createImportedDefinition(input) {
        const preview = new AgentImportService().create(input);
        await this.reviewConfigFields([
            preview.canonicalContent,
            { value: preview.proposedName, scene: SAFETY_SCENE.AgentConfigName },
            { value: preview.candidate.name, scene: SAFETY_SCENE.AgentConfigName },
        ]);
        const created = await this.options.service.create({
            name: preview.proposedName,
            displayName: preview.candidate.name,
            description: preview.candidate.description,
            systemPrompt: preview.candidate.systemPrompt,
        });
        let createdOwnerInstanceId;
        try {
            createdOwnerInstanceId = await this.options.service.getOrCreateCustomAgentInstanceId(`agent:${created.exactOwnerName}`);
            const current = await this.options.service.getConfigDocument(`agent:${created.exactOwnerName}`);
            const config = await this.options.service.putConfigDocument({
                requestRef: `agent:${created.exactOwnerName}`,
                content: preview.canonicalContent,
                expectedRevision: current.revision,
                expectedOwnerInstanceId: createdOwnerInstanceId,
            });
            publishBestEffort(this.options.publish ?? (() => undefined), {
                type: 'agent.created',
                payload: { agentName: created.exactOwnerName },
            });
            return { agent: created, config };
        }
        catch (error) {
            return rollbackImportedAgent(this.options.service, created.exactOwnerName, createdOwnerInstanceId, error);
        }
    }
    async update(input) {
        await this.reviewConfigFields([
            { value: input.displayName, scene: SAFETY_SCENE.AgentConfigName },
            input.description,
            input.persona,
            input.systemPrompt,
            ...reviewableAvatar(input.avatar),
        ]);
        return this.options.service.update(input);
    }
    setRootSession(requestRef, sessionId) {
        return this.options.service.setRootSession(requestRef, sessionId);
    }
    listLegacyPinnedAgentRefs() {
        return this.options.service.listLegacyPinnedAgentRefs?.() ?? Promise.resolve([]);
    }
    async delete(requestRef) {
        const exactOwnerName = await this.options.service.requireExactAgentKey(requestRef);
        await this.options.service.delete(`agent:${exactOwnerName}`);
        // Product decision 2026-09-04: cron tasks are intentionally NOT cascaded
        // on Agent delete (desktop and cloud agree). Orphaned tasks stay listed
        // and fail at trigger time; users manage them from the scheduled-tasks UI.
        await this.options.removeAgentPin?.(exactOwnerName);
    }
    ensureBuiltinAgents() {
        this.ensureBuiltinPromise ??= this.runEnsureBuiltinAgents();
        return this.ensureBuiltinPromise;
    }
    /**
     * Phase-2 startup deliberately does not materialize legacy Root sessions.
     * Keep this separate from ensureBuiltinAgents(), which is the V1 facade
     * contract and therefore still repairs or creates each builtin Root.
     */
    ensureBuiltinDefinitionsForPhase2() {
        this.ensureBuiltinDefinitionsPromise ??= this.runEnsureBuiltinDefinitionsForPhase2();
        return this.ensureBuiltinDefinitionsPromise;
    }
    /** Startup-only canonicalization, deliberately after builtin rows exist. */
    materializeLegacyCustomAgents() {
        return this.options.service.materializeLegacyCustomAgents();
    }
    /** Schedules V2-owned greeting turns; CLI composition leaves this disabled. */
    async scheduleBuiltinGreetings() {
        if (this.closed)
            return;
        const greeting = this.options.greeting;
        if (!greeting?.enabled || greeting.canSend?.() === false)
            return;
        const agents = await this.options.service.list();
        if (this.closed)
            return;
        await Promise.all(agents
            .filter((agent) => agent.creationSource === 'builtin')
            .map((agent) => this.scheduleGreeting(agent)));
    }
    async retryBuiltinGreetings() {
        await this.scheduleBuiltinGreetings();
    }
    async notifyGreetingTurnTerminal(turnId, status) {
        const agentName = this.pendingGreetingByTurn.get(turnId);
        if (!agentName)
            return;
        this.promptReads.discard(turnId);
        this.pendingGreetingByTurn.delete(turnId);
        this.greetingInFlight.delete(agentName);
        if (status === 'completed')
            await this.options.service.markGreetingSent(agentName);
    }
    async ensureBuiltinRowsOnly() {
        return this.ensureBuiltinRows({ ensureRoots: false });
    }
    async ensureBuiltinRowsAndRoots() {
        return this.ensureBuiltinRows({ ensureRoots: true });
    }
    async ensureBuiltinRows(options) {
        const seeded = await this.options.service.ensureBuiltinRows();
        if (!options.ensureRoots)
            return this.options.service.list();
        for (const agent of seeded) {
            if (agent.creationSource !== 'builtin')
                continue;
            await this.options.root.getRootSessionByAgent(agent.exactOwnerName);
        }
        return this.options.service.list();
    }
    async runEnsureBuiltinAgents() {
        try {
            return await this.ensureBuiltinRowsAndRoots();
        }
        finally {
            this.ensureBuiltinPromise = undefined;
        }
    }
    async runEnsureBuiltinDefinitionsForPhase2() {
        try {
            return await this.ensureBuiltinRowsOnly();
        }
        finally {
            this.ensureBuiltinDefinitionsPromise = undefined;
        }
    }
    async reviewConfigFields(values) {
        await this.options.reviewConfigFields?.(values);
    }
    async scheduleGreeting(agent) {
        if (this.closed)
            return;
        const greeting = this.options.greeting;
        if (!greeting || !greeting.enabled || greeting.canSend?.() === false)
            return;
        if (this.greetingInFlight.has(agent.exactOwnerName))
            return;
        const state = await this.options.service.getGreetingState(agent.exactOwnerName);
        if (!state || state.greetingSent || !state.rootSessionId)
            return;
        await this.dispatchGreeting(agent, state.rootSessionId, greeting);
    }
    async dispatchGreeting(agent, rootSessionId, greeting) {
        if (this.closed)
            return;
        this.greetingInFlight.add(agent.exactOwnerName);
        const requestedTurnId = `turn_greeting_${randomUUID()}`;
        this.pendingGreetingByTurn.set(requestedTurnId, agent.exactOwnerName);
        if (greeting.promptSnapshots && !this.promptReads.reserve(requestedTurnId)) {
            this.pendingGreetingByTurn.delete(requestedTurnId);
            this.greetingInFlight.delete(agent.exactOwnerName);
            return;
        }
        try {
            const rendered = await this.renderGreeting(agent.exactOwnerName, greeting);
            if (this.closed) {
                this.clearGreetingDispatch(agent.exactOwnerName, requestedTurnId);
                return;
            }
            if (rendered.promptRead)
                this.promptReads.remember(requestedTurnId, rendered.promptRead);
            const result = await greeting.sendSystemReminder({
                agentName: agent.exactOwnerName,
                sessionId: rootSessionId,
                content: rendered.content,
                requestedTurnId,
            });
            if (this.closed) {
                this.clearGreetingDispatch(agent.exactOwnerName, requestedTurnId);
                return;
            }
            if (result === 'finished') {
                this.promptReads.discard(requestedTurnId);
                this.pendingGreetingByTurn.delete(requestedTurnId);
                this.greetingInFlight.delete(agent.exactOwnerName);
                await this.options.service.markGreetingSent(agent.exactOwnerName);
            }
            else if (result.turnId !== requestedTurnId) {
                this.promptReads.rebind(requestedTurnId, result.turnId);
                this.pendingGreetingByTurn.delete(requestedTurnId);
                this.pendingGreetingByTurn.set(result.turnId, agent.exactOwnerName);
            }
        }
        catch {
            this.clearGreetingDispatch(agent.exactOwnerName, requestedTurnId);
            // Keep greetingSent=false so the next ensure/retry can try again.
        }
    }
    async renderGreeting(agentName, greeting) {
        const source = greeting.promptSnapshots;
        if (!source) {
            const content = await this.options.service.buildGreetingReminder(agentName);
            if (this.closed)
                throw new GreetingDispatchClosedError();
            return { content };
        }
        const promptRead = { source, snapshot: await source.capture() };
        if (this.closed)
            throw new GreetingDispatchClosedError();
        try {
            const content = await this.options.service.buildGreetingReminder(agentName, promptRead);
            if (this.closed)
                throw new GreetingDispatchClosedError();
            return {
                content,
                promptRead,
            };
        }
        catch (error) {
            if (!isPromptSnapshotInvalidError(error))
                throw error;
            const builtinPromptRead = { source, snapshot: await source.captureBuiltin() };
            if (this.closed)
                throw new GreetingDispatchClosedError();
            const content = await this.options.service.buildGreetingReminder(agentName, builtinPromptRead);
            if (this.closed)
                throw new GreetingDispatchClosedError();
            return {
                content,
                promptRead: builtinPromptRead,
            };
        }
    }
    clearGreetingDispatch(agentName, turnId) {
        this.promptReads.discard(turnId);
        this.pendingGreetingByTurn.delete(turnId);
        this.greetingInFlight.delete(agentName);
    }
}
function createDefinitionReviewFields(input) {
    const definition = input.initialDefinition;
    return definition === undefined
        ? legacyCreateDefinitionReviewFields(input)
        : initialDefinitionReviewFields(input, definition);
}
function legacyCreateDefinitionReviewFields(input) {
    return [
        ...(input.name === undefined
            ? []
            : [{ value: input.name, scene: SAFETY_SCENE.AgentConfigName }]),
        { value: input.displayName, scene: SAFETY_SCENE.AgentConfigName },
        input.description,
        input.persona,
        input.systemPrompt,
        ...reviewableAvatar(input.avatar),
    ];
}
function initialDefinitionReviewFields(input, definition) {
    const mavis = definition.mavis;
    return [
        { value: input.name ?? definition.name, scene: SAFETY_SCENE.AgentConfigName },
        definition.description,
        definition.model,
        definition.effort,
        ...(definition.tools ?? []),
        ...(definition.disallowedTools ?? []),
        ...(definition.mcpServers ?? []),
        ...(definition.skills ?? []),
        { value: mavis?.displayName ?? input.displayName, scene: SAFETY_SCENE.AgentConfigName },
        ...reviewableAvatar(mavis?.avatar ?? input.avatar),
        mavis?.defaultWorkspaceDir ?? input.defaultWorkspaceDir,
        ...(mavis?.extensionSkills ?? []),
        definition.systemPrompt,
    ];
}
function reviewableAvatar(value) {
    return isDefaultAgentAvatarMarker(value)
        ? []
        : [{ value, scene: SAFETY_SCENE.AgentConfigAvatar }];
}
class GreetingDispatchClosedError extends Error {
}
async function reviewAgentConfigFields(safety, values) {
    for (const raw of values) {
        const field = typeof raw === 'object' && raw !== null
            ? raw
            : { value: raw, scene: SAFETY_SCENE.ConfigField };
        const value = field.value?.trim() ?? '';
        if (!value)
            continue;
        if (await safety.blocks(value, field.scene)) {
            throw new AgentServiceError('CONTENT_POLICY_VIOLATION', 'Content validation failed');
        }
    }
}
export function createAgentSessionPorts(service) {
    const roots = {
        clearRootSession: (agentName, sessionId) => service.clearRootSessionByExactOwner(agentName, sessionId),
        get: async (agentName) => {
            const view = await service.getPersistedOwner(agentName);
            return view ? toRootAgentRecord(view) : undefined;
        },
        setRootSession: (agentName, sessionId) => service.setRootSessionByExactOwner(agentName, sessionId),
    };
    return {
        roots,
        resolveWriteTarget: (requestRef) => service.resolveAgentWriteTarget(requestRef),
        requireExactAgentKey: (requestRef) => service.requireExactAgentKey(requestRef),
        resolveAgentReadScope: (requestRef) => service.resolveAgentReadScope(requestRef),
        directory: {
            get: async (agentName) => {
                const view = await service.getPersistedOwner(agentName);
                if (!view)
                    return undefined;
                return view.defaultWorkspaceDir ? { defaultWorkspaceDir: view.defaultWorkspaceDir } : {};
            },
        },
    };
}
function toRootAgentRecord(agent) {
    return {
        agentName: agent.exactOwnerName,
        ...(agent.rootSessionId ? { rootSessionId: agent.rootSessionId } : {}),
        ...(agent.displayName ? { displayName: agent.displayName } : {}),
        ...(agent.defaultWorkspaceDir ? { defaultWorkspaceDir: agent.defaultWorkspaceDir } : {}),
    };
}
async function rollbackImportedAgent(service, exactOwnerName, createdOwnerInstanceId, originalError) {
    if (createdOwnerInstanceId === undefined) {
        throw new AggregateError([originalError], `Agent import failed before conditional cleanup became available: ${exactOwnerName}`);
    }
    try {
        await service.deleteIfOwnerInstanceId(`agent:${exactOwnerName}`, createdOwnerInstanceId);
    }
    catch (cleanupError) {
        throw new AggregateError([originalError, cleanupError], `Agent import failed and conditional cleanup did not complete: ${exactOwnerName}`);
    }
    throw originalError;
}
//# sourceMappingURL=agent-application.js.map