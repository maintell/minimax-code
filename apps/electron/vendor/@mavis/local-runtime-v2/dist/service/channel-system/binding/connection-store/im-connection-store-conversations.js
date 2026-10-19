/**
 * Migration copy (MR1) of v1 `channels/im-connection-store-conversations.ts`.
 */
import { KeyedOperationLane } from '@mavis/shared/keyed-operation-lane';
import { mutateDurableYaml, readYamlDocument } from '../storage/durable-yaml.js';
import { invalidImStorage, nextBindingUpdatedAt, readBindingData, requireBindingSessionState, writeBindingData, } from './im-connection-store-data.js';
import { LocalImConnectionError, } from '../im-connection-types.js';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
/** Advances one physical Binding; shared legacy cursors are never advanced together. */
export async function advanceImBinding(operations, advance) {
    const { connection, bindingId, requestId, telemetry } = advance;
    return operations.bindingSessionLane.run(bindingId, async () => {
        const existing = await readBindingForConnection(operations, connection, bindingId);
        const prior = requireBindingSessionState(existing).mutationReceipts[requestId];
        if (prior) {
            logAdvanceLifecycle({
                telemetry,
                connection,
                bindingId,
                stage: 'new_cursor_update',
                outcome: 'replayed',
                sessionId: prior,
            });
            return { ...existing, currentSessionId: prior };
        }
        const session = await createBindingSession({
            operations,
            connection,
            binding: existing,
            telemetry,
        });
        logAdvanceLifecycle({
            telemetry,
            connection,
            bindingId,
            stage: 'new_cursor_update',
            outcome: 'started',
            sessionId: session.sessionId,
        });
        let advanced;
        try {
            advanced = await mutateDurableYaml(operations.bindingsPath, (document) => {
                const data = readBindingData(document, operations.options.nowMs());
                const current = data.physicalBindings.get(bindingId);
                if (!current)
                    throw bindingNotFound(bindingId);
                const currentState = assertBindingForConnection(current, connection);
                const replay = currentState.mutationReceipts[requestId];
                if (replay)
                    return { changed: false, value: { ...current, currentSessionId: replay } };
                const next = {
                    ...current,
                    currentSessionId: session.sessionId,
                    updatedAt: nextBindingUpdatedAt(current, operations.options.nowMs()),
                    mutationReceipts: appendReceipt(currentState.mutationReceipts, requestId, session.sessionId),
                };
                data.physicalBindings.set(next.bindingId, next);
                writeBindingData(document, data);
                return { changed: true, value: next };
            });
        }
        catch (error) {
            logAdvanceLifecycle({
                telemetry,
                connection,
                bindingId,
                stage: 'new_cursor_update',
                outcome: 'failed',
                sessionId: session.sessionId,
                code: imAdvanceFailureCode(error, 'CHANNEL_IM_NEW_CURSOR_UPDATE_FAILED'),
            });
            throw error;
        }
        logAdvanceLifecycle({
            telemetry,
            connection,
            bindingId,
            stage: 'new_cursor_update',
            outcome: advanced.currentSessionId === session.sessionId ? 'updated' : 'replayed',
            ...(advanced.currentSessionId ? { sessionId: advanced.currentSessionId } : {}),
        });
        return advanced;
    });
}
/** Creates the first Session only for an empty physical Binding cursor. */
export async function ensureImBindingSession(operations, connection, bindingId) {
    return operations.bindingSessionLane.run(bindingId, async () => {
        const existing = await readBindingForConnection(operations, connection, bindingId);
        if (requireBindingSessionState(existing).currentSessionId)
            return existing;
        const session = await createBindingSession({ operations, connection, binding: existing });
        return mutateDurableYaml(operations.bindingsPath, (document) => {
            const data = readBindingData(document, operations.options.nowMs());
            const current = data.physicalBindings.get(bindingId);
            if (!current)
                throw bindingNotFound(bindingId);
            const currentState = assertBindingForConnection(current, connection);
            if (currentState.currentSessionId)
                return { changed: false, value: current };
            const next = {
                ...current,
                currentSessionId: session.sessionId,
                updatedAt: nextBindingUpdatedAt(current, operations.options.nowMs()),
            };
            data.physicalBindings.set(next.bindingId, next);
            writeBindingData(document, data);
            return { changed: true, value: next };
        });
    });
}
async function readBindingForConnection(operations, connection, bindingId) {
    const data = readBindingData(await readYamlDocument(operations.bindingsPath), operations.options.nowMs());
    const binding = data.physicalBindings.get(bindingId);
    if (!binding)
        throw bindingNotFound(bindingId);
    assertBindingForConnection(binding, connection);
    return binding;
}
function assertBindingForConnection(binding, connection) {
    if (binding.connectionId !== connection.connectionId || binding.channel !== connection.channel) {
        throw invalidImStorage('physicalBindings', binding.bindingId);
    }
    const state = requireBindingSessionState(binding);
    if (state.resolvedProjectKey !== connection.resolvedProjectKey) {
        throw new LocalImConnectionError(409, 'CHANNEL_IM_BINDING_PROJECT_MISMATCH', 'The IM Binding Project does not match its Connection.');
    }
    return state;
}
async function createBindingSession(input) {
    const { operations, connection, binding, telemetry } = input;
    const stage = 'new_session_create';
    const state = assertBindingForConnection(binding, connection);
    const workspace = operations.options.resolveProjectWorkspace(state.resolvedProjectKey);
    logAdvanceLifecycle({
        telemetry,
        connection,
        bindingId: binding.bindingId,
        stage,
        outcome: 'started',
    });
    try {
        const session = await operations.options.createSession({
            agentName: connection.agentName,
            workspaceDir: workspace.workspaceDir,
            isDefaultWorkspace: workspace.isDefaultWorkspace,
            sessionType: 'branch',
            sessionKind: 'channel',
            parentSessionId: null,
            visibility: 'visible',
            purpose: `im_binding:${binding.bindingId}`,
        });
        logAdvanceLifecycle({
            telemetry,
            connection,
            bindingId: binding.bindingId,
            stage,
            outcome: 'created',
            sessionId: session.sessionId,
        });
        return session;
    }
    catch (error) {
        logAdvanceLifecycle({
            telemetry,
            connection,
            bindingId: binding.bindingId,
            stage,
            outcome: 'failed',
            code: imAdvanceFailureCode(error, 'CHANNEL_IM_NEW_SESSION_CREATE_FAILED'),
        });
        throw error;
    }
}
function bindingNotFound(bindingId) {
    return new LocalImConnectionError(409, 'IM_BINDING_NOT_FOUND', `IM Binding not found: ${bindingId}`);
}
function logAdvanceLifecycle(event) {
    const { telemetry, connection, bindingId, stage, outcome, sessionId } = event;
    if (!telemetry)
        return;
    const fields = {
        requestKey: telemetry.requestKey,
        platform: telemetry.platform,
        connectionId: connection.connectionId,
        bindingId,
        ...(sessionId ? { sessionId } : {}),
        stage,
        code: event.code ?? 'IM_BINDING_ADVANCE',
        outcome,
        ...(outcome === 'failed' ? { failureKind: stage } : {}),
    };
    if (outcome === 'failed') {
        logger.warn(fields, 'IM Binding /new lifecycle failed');
    }
    else {
        logger.info(fields, 'IM Binding /new lifecycle');
    }
}
function imAdvanceFailureCode(error, fallback) {
    if (typeof error !== 'object' || error === null)
        return fallback;
    const code = error.code;
    // These codes are locally controlled persistence/Agent contracts. Do not
    // serialize an arbitrary thrown message or third-party transport error.
    return code === 'IM_BINDING_NOT_FOUND' || code === 'AGENT_NOT_FOUND' ? code : fallback;
}
function appendReceipt(receipts, requestId, sessionId) {
    const next = { ...receipts, [requestId]: sessionId };
    const ids = Object.keys(next);
    if (ids.length <= 32)
        return next;
    for (const id of ids.slice(0, ids.length - 32))
        delete next[id];
    return next;
}
//# sourceMappingURL=im-connection-store-conversations.js.map