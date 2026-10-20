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
export function metadataSessionKind(input) {
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
export function taskWorkspaceFor(sessionKind, parent) {
    return sessionKind === 'task' ? parent?.workspaceDir : undefined;
}
export function taskMemoryPolicyFor(sessionKind, parent) {
    return sessionKind === 'task' ? effectiveSessionMemoryPolicy(parent?.memoryPolicy) : undefined;
}
export function createDefaultWorkspaceIdentity(input) {
    if (input.taskWorkspace !== undefined)
        return input.parent?.isDefaultWorkspace === true;
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
export function appModeFields(sessionType, appMode) {
    return sessionType === 'branch' ? { appMode: appMode ?? 'coding' } : {};
}
export function modelKey(providerId, modelId) {
    const provider = nonEmpty(providerId);
    const model = nonEmpty(modelId);
    return provider && model ? `${provider}/${model}` : undefined;
}
export function modelFieldsFromDefinition(definition) {
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
export function whenDefined(key, value) {
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
//# sourceMappingURL=record-service-fields.js.map