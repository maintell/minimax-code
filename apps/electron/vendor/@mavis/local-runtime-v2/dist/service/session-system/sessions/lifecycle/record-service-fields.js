import { isTaskSession } from '../repo/drizzle/normalization.js';
import { SessionServiceError } from '../errors.js';
import { applySessionMemoryPolicyPatch, effectiveSessionMemoryPolicy } from '../memory-policy.js';
export function normalizeSessionMutation(current, fields) {
    const { memoryPolicy, ...rest } = fields;
    const normalized = {
        ...rest,
        ...(fields.title !== undefined ? { titleSource: fields.titleSource ?? 'manual' } : {}),
    };
    if (memoryPolicy === undefined)
        return normalized;
    const policy = effectiveSessionMemoryPolicy(current.memoryPolicy);
    if (policy.recallLocked &&
        memoryPolicy.recallEnabled !== undefined &&
        memoryPolicy.recallEnabled !== policy.recallEnabled) {
        throw new SessionServiceError('memory-recall-locked', 'Memory recall cannot be changed after the conversation starts');
    }
    return {
        ...normalized,
        memoryPolicy: applySessionMemoryPolicyPatch(current.memoryPolicy, memoryPolicy),
    };
}
function metadataSessionKind(input) {
    const requestedKind = input.sessionKind ?? 'conversation';
    if (requestedKind === 'unknown') {
        throw new SessionServiceError('invalid-session-kind', `Unsupported Session kind: ${requestedKind}`);
    }
    if ((requestedKind === 'task' || requestedKind === 'peek') && !input.parentSessionId) {
        throw new SessionServiceError('parent-required', `${requestedKind} Session requires a parent Session`);
    }
    return requestedKind;
}
export function assertTaskParent(sessionKind, parent) {
    if (sessionKind === 'task' && !parent) {
        throw new SessionServiceError('parent-required', 'task Session requires a parent Session');
    }
}
export function assertPluginAgentTaskSession(session, pluginAgent) {
    if (pluginAgent && !isTaskSession(session)) {
        throw new SessionServiceError('invalid-session-kind', 'Plugin Agent requires a Task Session');
    }
}
export function taskWorkspaceFor(sessionKind, parent) {
    return sessionKind === 'task' ? parent?.workspaceDir : undefined;
}
export function taskMemoryPolicyFor(sessionKind, parent) {
    return sessionKind === 'task' ? effectiveSessionMemoryPolicy(parent?.memoryPolicy) : undefined;
}
/**
 * A Task carries its parent's advisor selection; an internal create that passes `advisor`
 * (Fork copies the source's) keeps that one instead. Whether the child may use the advisor
 * tool is decided per Turn by its own Agent definition, not here.
 */
export function taskAdvisorFor(sessionKind, parent) {
    return sessionKind === 'task' ? (parent?.advisor ?? undefined) : undefined;
}
export function createDefaultWorkspaceIdentity(input) {
    if (input.taskWorkspace !== undefined)
        return input.parent?.isDefaultWorkspace === true;
    if (input.preserveRequested && input.requested !== undefined && !input.runLocation)
        return input.requested;
    if (input.runLocation || input.explicitWorkspaceDir)
        return false;
    return input.requested ?? true;
}
export function visibilityForKind(kind, requested, parent) {
    if (parent === 'hidden')
        return 'hidden';
    if (kind === 'task')
        return 'visible';
    if (kind === 'peek')
        return 'hidden';
    return requested;
}
export function visibilityForInternalKind(kind, requested, parent) {
    if (kind === 'task')
        return 'visible';
    if (kind === 'peek')
        return 'hidden';
    return requested ?? parent;
}
export function assertNativeMutation(session) {
    if (session.runtime !== 'pi-agent') {
        throw new SessionServiceError('runtime-unsupported', 'Legacy opencode Session mutation is unavailable');
    }
}
export function sessionNotFound(sessionId) {
    return new SessionServiceError('session-not-found', `Session not found: ${sessionId}`);
}
export function normalizeAppMode(value) {
    return value === 'work' ? 'work' : 'coding';
}
function appModeFields(sessionType, appMode) {
    return sessionType === 'branch' ? { appMode: appMode ?? 'coding' } : {};
}
export function modelKey(providerId, modelId) {
    const provider = nonEmpty(providerId);
    const model = nonEmpty(modelId);
    return provider && model ? `${provider}/${model}` : undefined;
}
function modelFieldsFromDefinition(definition) {
    return {
        effectiveModel: `${definition.model.providerId}/${definition.model.modelId}`,
        ...whenDefined('effectiveModelVariant', definition.model.variant),
        ...whenDefined('effectiveModelThinking', definition.model.thinking),
        ...whenDefined('effectiveModelContextWindow', definition.model.contextWindow),
        ...whenDefined('effectiveModelMaxOutputTokens', definition.model.maxOutputTokens),
    };
}
export function internalExplicitWorkspaceDir(input) {
    if (input.workspaceDir !== undefined && !nonEmpty(input.workspaceDir)) {
        throw new SessionServiceError('workspace-required', 'Session workspace directory is required');
    }
    return nonEmpty(input.workspaceDir ?? input.runLocation?.resolvedDir);
}
/** Creates or attaches the requested worktree in the workspace the Session resolved to. */
export async function resolveRequestedRunLocation(input, workspaceDir, resolve) {
    if (!input.runLocationRequest)
        return input.runLocation;
    if (input.runLocation) {
        throw new SessionServiceError('run-location-invalid', 'runLocation and runLocationRequest cannot both be set');
    }
    return resolve(input.runLocationRequest, workspaceDir);
}
export function internalDefaultWorkspaceIdentity(input, implicitDefaultWorkspace) {
    if (input.preserveDefaultWorkspaceIdentity && input.isDefaultWorkspace !== undefined) {
        return input.isDefaultWorkspace;
    }
    if (input.runLocation)
        return false;
    return input.isDefaultWorkspace ?? implicitDefaultWorkspace;
}
export function nonEmpty(value) {
    return value?.trim() ? value : undefined;
}
export function optionalModelVariant(value) {
    return value === '' ? '' : nonEmpty(value);
}
export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export function whenPresent(key, value) {
    return value ? { [key]: value } : {};
}
function whenDefined(key, value) {
    return value !== undefined && value !== null ? { [key]: value } : {};
}
/** Minimal in-memory record used to capture before the durable row exists. */
export function sessionCaptureCandidate(input) {
    return {
        sessionId: input.sessionId,
        agentName: input.agentName,
        workspaceDir: input.workspaceDir,
        isDefaultWorkspace: input.isDefaultWorkspace,
        runtime: 'pi-agent',
        sessionType: input.sessionType,
        sessionKind: input.sessionKind,
        archived: false,
        parentSessionId: input.parentSessionId,
        visibility: input.visibility,
        status: 'idle',
        ...(input.appMode ? { appMode: input.appMode } : {}),
        ...(input.effectiveModel ? { effectiveModel: input.effectiveModel } : {}),
        ...(input.effectiveModelVariant === undefined || input.effectiveModelVariant === null
            ? {}
            : { effectiveModelVariant: input.effectiveModelVariant }),
        ...(input.effectiveModelThinking
            ? { effectiveModelThinking: input.effectiveModelThinking }
            : {}),
        ...(input.effectiveModelContextWindow === undefined ||
            input.effectiveModelContextWindow === null
            ? {}
            : { effectiveModelContextWindow: input.effectiveModelContextWindow }),
        ...(input.effectiveModelMaxOutputTokens === undefined ||
            input.effectiveModelMaxOutputTokens === null
            ? {}
            : { effectiveModelMaxOutputTokens: input.effectiveModelMaxOutputTokens }),
        createdAtMs: 0,
        updatedAtMs: 0,
    };
}
/**
 * Assembles the `SessionMetadataCreateInput` a create call hands the metadata writer, for both
 * the public and the internal create path. Pure functions over the context the record service
 * resolved; they live here so `record-service.ts` stays within the layout budget.
 */
export function toMetadataCreateInput(context) {
    const requestedKind = metadataSessionKind(context.input);
    return {
        ...metadataIdentityFields(context, requestedKind),
        sessionType: 'branch',
        sessionKind: requestedKind,
        ...whenDefined('memoryPolicy', context.taskMemoryPolicy),
        ...metadataModelFields(context.input, context.taskCapture),
        ...metadataBindingFields(context.taskCapture),
        ...whenPresent('advisor', context.taskAdvisor),
        origin: 'user',
    };
}
export function toInternalMetadataCreateInput(context) {
    const sessionType = context.input.sessionType ?? 'branch';
    return {
        ...internalIdentityFields(context),
        sessionType,
        sessionKind: context.sessionKind,
        ...whenDefined('memoryPolicy', context.taskMemoryPolicy),
        ...internalMetadataFields(context, sessionType),
        ...internalModelFields(context.input, context.taskCapture, context.forkedAgentDefinition),
        ...internalBindingFields(context.taskCapture, context.forkedAgentDefinition),
        origin: context.input.origin ?? 'user',
        ...whenPresent('createdBySessionId', context.input.createdBySessionId),
        ...whenPresent('toolCallMode', context.input.toolCallMode),
        ...whenPresent('advisor', context.input.advisor ?? context.taskAdvisor),
    };
}
function metadataIdentityFields(context, sessionKind) {
    const { input, taskWorkspace, runLocation } = context;
    return {
        sessionId: context.sessionId,
        agentName: input.agentName,
        workspaceDir: taskWorkspace ?? runLocation?.resolvedDir ?? context.requestedWorkspaceDir,
        isDefaultWorkspace: context.isDefaultWorkspace,
        title: input.title ?? null,
        parentSessionId: input.parentSessionId ?? null,
        visibility: visibilityForKind(sessionKind, input.visibility, context.parentVisibility) ?? 'visible',
        ...whenPresent('purpose', nonEmpty(input.purpose)),
        ...whenPresent('projectWorkspaceDir', context.projectWorkspaceDir),
        ...whenPresent('runLocation', runLocation),
        appMode: context.appMode,
    };
}
function metadataModelFields(input, taskCapture) {
    const effectiveModel = modelKey(input.model?.providerId, input.model?.modelId);
    return {
        ...whenPresent('effectiveModel', taskCapture?.effectiveModel ?? effectiveModel),
        ...metadataVariantField(input, taskCapture),
        ...whenDefined('effectiveModelThinking', taskCapture ? taskCapture.effectiveModelThinking : input.model?.thinking),
        ...whenDefined('effectiveModelContextWindow', taskCapture?.effectiveModelContextWindow ??
            input.model?.contextLimit ??
            input.effectiveModelContextWindow),
        ...whenDefined('effectiveModelMaxOutputTokens', taskCapture?.effectiveModelMaxOutputTokens ?? input.effectiveModelMaxOutputTokens),
    };
}
function metadataVariantField(input, taskCapture) {
    if (taskCapture)
        return whenDefined('effectiveModelVariant', taskCapture.effectiveModelVariant);
    return whenDefined('effectiveModelVariant', optionalModelVariant(input.model?.variant));
}
function metadataBindingFields(taskCapture) {
    if (!taskCapture)
        return {};
    return {
        agentDefinition: taskCapture.agentDefinition,
        taskAgentBinding: taskCapture.taskAgentBinding,
    };
}
function internalIdentityFields(context) {
    const { input } = context;
    return {
        sessionId: context.sessionId,
        agentName: input.agentName,
        workspaceDir: context.workspaceDir,
        isDefaultWorkspace: context.isDefaultWorkspace,
        title: input.title ?? null,
        titleSource: input.titleSource ?? (input.title?.trim() ? 'auto' : 'default'),
        parentSessionId: input.parentSessionId ?? null,
    };
}
function internalMetadataFields(context, sessionType) {
    const { input, parent, sessionKind } = context;
    const visibility = visibilityForInternalKind(sessionKind, input.visibility, parent?.visibility);
    return {
        ...whenPresent('visibility', visibility),
        ...whenPresent('purpose', input.purpose),
        ...whenPresent('originCronId', input.originCronId),
        ...whenPresent('miniAppOrigin', input.miniAppOrigin),
        ...whenPresent('runLocation', input.runLocation),
        ...appModeFields(sessionType, input.appMode ?? parent?.appMode),
    };
}
function internalModelFields(input, taskCapture, forkedAgentDefinition) {
    if (forkedAgentDefinition)
        return modelFieldsFromDefinition(forkedAgentDefinition.definition);
    return {
        ...whenPresent('effectiveModel', taskCapture?.effectiveModel ?? input.effectiveModel),
        ...internalVariantField(input, taskCapture),
        ...whenDefined('effectiveModelThinking', taskCapture?.effectiveModelThinking ?? input.effectiveModelThinking),
        ...whenDefined('effectiveModelContextWindow', taskCapture?.effectiveModelContextWindow ?? input.effectiveModelContextWindow),
        ...whenDefined('effectiveModelMaxOutputTokens', taskCapture?.effectiveModelMaxOutputTokens ?? input.effectiveModelMaxOutputTokens),
    };
}
function internalVariantField(input, taskCapture) {
    if (taskCapture)
        return whenDefined('effectiveModelVariant', taskCapture.effectiveModelVariant);
    return whenDefined('effectiveModelVariant', input.effectiveModelVariant);
}
function internalBindingFields(taskCapture, forkedAgentDefinition) {
    if (forkedAgentDefinition)
        return { agentDefinition: forkedAgentDefinition };
    return metadataBindingFields(taskCapture);
}
//# sourceMappingURL=record-service-fields.js.map