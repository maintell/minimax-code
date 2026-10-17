/**
 * Migration copy (MR1) of v1 `channels/im-connection-store-binding-operations.ts`.
 */
import { mutateDurableYaml } from '../storage/durable-yaml.js';
import { findBindingForConnection, findBindingForTransportClient, invalidImStorage, nextBindingUpdatedAt, newImEntityId, readBindingData, requiredString, requireBindingSessionState, writeBindingData, } from './im-connection-store-data.js';
import { advanceImBinding, ensureImBindingSession, } from './im-connection-store-conversations.js';
import { assertImBindingRuntimeState, bindingConversationOperations, clearImPendingLegacyMigration, getImAuthorization, getImBindingForConnection, getImBindingForTransportClient, readImBindingState, requireImConnection, sameLegacyRouteKeys, normalizeLegacyRouteKeys, } from './im-connection-store-operations.js';
import { LocalImConnectionError, } from '../im-connection-types.js';
/** Read one physical Binding with the Connection that owns its live cursor. */
export async function getImBindingSnapshot(operations, bindingId) {
    const normalizedBindingId = requiredString(bindingId, 'bindingId');
    const { bindingData } = await readImBindingState(operations);
    const binding = bindingData.physicalBindings.get(normalizedBindingId);
    if (!binding)
        return undefined;
    const connection = bindingData.connections.get(binding.connectionId);
    if (!connection)
        throw invalidImStorage('physicalBindings', binding.bindingId);
    assertImBindingRuntimeState(binding, connection);
    return { connection, binding };
}
/**
 * Desktop `/new` cursor transition. This accepts only the exact physical
 * Binding observed by the caller and never revives an empty historical
 * cursor. The Binding timestamp is the durable generation CAS.
 */
export async function moveImBindingSessionIfCurrent(operations, input) {
    const bindingId = requiredString(input.bindingId, 'bindingId');
    const connectionId = requiredString(input.connectionId, 'connectionId');
    const expectedCurrentSessionId = requiredString(input.expectedCurrentSessionId, 'expectedCurrentSessionId');
    const nextSessionId = requiredString(input.nextSessionId, 'nextSessionId');
    const agentName = requiredString(input.agentName, 'agentName');
    const projectKey = requiredString(input.projectKey, 'projectKey');
    if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) {
        throw new LocalImConnectionError(400, 'VALIDATION_ERROR', 'expectedGeneration must be a non-negative integer.');
    }
    if (!operations.options.validateTargetSession) {
        throw new LocalImConnectionError(503, 'CHANNEL_IM_TARGET_VALIDATOR_UNAVAILABLE', 'The IM Binding target Session validator is unavailable.');
    }
    return operations.connectionLane.run(connectionId, async () => {
        // Keep the established Connection -> external Binding lane order used by
        // bind, disconnect, and delete. The durable mutation below rechecks all
        // of these facts after it owns the cursor lane.
        const expectedBinding = await getImBindingForConnection(operations, connectionId);
        if (!expectedBinding || expectedBinding.bindingId !== bindingId) {
            throw new LocalImConnectionError(404, 'IM_BINDING_NOT_FOUND', 'The IM Binding is no longer available.');
        }
        const transportKey = `${expectedBinding.channel}\u0000${expectedBinding.clientName}`;
        return operations.bindingLane.run(transportKey, () => operations.bindingSessionLane.run(bindingId, async () => {
            await operations.options.validateTargetSession({
                sessionId: nextSessionId,
                agentName,
                projectKey,
            });
            return applyValidatedCursorMove(operations, {
                bindingId,
                connectionId,
                agentName,
                projectKey,
                expectedGeneration: input.expectedGeneration,
                expectedCurrentSessionId,
                nextSessionId,
            });
        }));
    });
}
/**
 * Durable half of the cursor move: recheck every fact under the mutation lane
 * (binding identity, owner, cursor CAS) and persist the new cursor. Extracted
 * from the inline mutation callback so the lane nesting stays readable and
 * within the callback-depth budget.
 */
async function applyValidatedCursorMove(operations, move) {
    return mutateDurableYaml(operations.bindingsPath, (document) => {
        const data = readBindingData(document, operations.options.nowMs());
        const binding = data.physicalBindings.get(move.bindingId);
        if (!binding || binding.connectionId !== move.connectionId) {
            throw new LocalImConnectionError(404, 'IM_BINDING_NOT_FOUND', 'The IM Binding is no longer available.');
        }
        const connection = data.connections.get(move.connectionId);
        if (!connection)
            throw invalidImStorage('physicalBindings', binding.bindingId);
        const state = assertImBindingRuntimeState(binding, connection);
        if (connection.agentName !== move.agentName ||
            connection.resolvedProjectKey !== move.projectKey) {
            throw new LocalImConnectionError(409, 'CHANNEL_IM_BINDING_TARGET_MISMATCH', 'The IM Binding does not belong to the requested Agent and Project.');
        }
        if (!state.currentSessionId) {
            throw new LocalImConnectionError(409, 'CHANNEL_IM_BINDING_CURSOR_EMPTY', 'An unbound IM history cannot be moved to a new Session.');
        }
        if (binding.updatedAt !== move.expectedGeneration ||
            state.currentSessionId !== move.expectedCurrentSessionId) {
            throw new LocalImConnectionError(409, 'CHANNEL_IM_BINDING_CURSOR_CONFLICT', 'The IM Binding cursor changed before the new Session could be selected.');
        }
        const next = {
            ...binding,
            currentSessionId: move.nextSessionId,
            updatedAt: nextBindingUpdatedAt(binding, operations.options.nowMs()),
        };
        data.physicalBindings.set(move.bindingId, next);
        writeBindingData(document, data);
        return { changed: true, value: { connection, binding: next } };
    });
}
export async function bindImConnection(operations, input) {
    const connection = await requireImConnection(operations, input.connectionId);
    const clientName = requiredString(input.clientName, 'clientName');
    const suppliedSessionId = input.currentSessionId?.trim() ?? '';
    if (input.emptyCursor === true && suppliedSessionId) {
        throw new LocalImConnectionError(400, 'CHANNEL_CONNECTION_MIGRATION_INVALID', 'An empty IM Binding cursor cannot carry a Session.');
    }
    const expectedPendingLegacyRouteKeys = input.expectedPendingLegacyRouteKeys
        ? normalizeLegacyRouteKeys(input.expectedPendingLegacyRouteKeys)
        : undefined;
    const transportKey = `${connection.channel}\u0000${clientName}`;
    return operations.connectionLane.run(connection.connectionId, () => operations.bindingLane.run(transportKey, async () => {
        const current = await requireImConnection(operations, connection.connectionId);
        const existing = await checkBindPreconditions(operations, {
            current,
            clientName,
            expectedPendingLegacyRouteKeys,
            migration: input.migration === true,
        });
        if (existing)
            return existing;
        return persistNewImBinding(operations, {
            connectionId: current.connectionId,
            clientName,
            suppliedSessionId,
            expectedPendingLegacyRouteKeys,
            migratedLegacyRouteKeys: input.migratedLegacyRouteKeys,
        });
    }));
}
/**
 * Lane-held bind pre-checks (v1 inline block). Returns the already-bound
 * Binding for the idempotent replay case; throws on every conflict.
 */
async function checkBindPreconditions(operations, check) {
    const { current, clientName, expectedPendingLegacyRouteKeys } = check;
    assertLegacyRouteKeysUnchanged(current.pendingLegacyRouteKeys, expectedPendingLegacyRouteKeys);
    const existing = await getImBindingForConnection(operations, current.connectionId);
    if (existing) {
        if (existing.clientName !== clientName) {
            throw new LocalImConnectionError(409, 'CHANNEL_CONNECTION_ALREADY_BOUND', 'The Channel Connection already has a different physical Binding.');
        }
        assertLegacyRouteKeysUnchanged(existing.migratedLegacyRouteKeys, expectedPendingLegacyRouteKeys);
        return existing;
    }
    const authorization = getImAuthorization(operations, current.connectionId);
    if (!check.migration &&
        (!authorization || authorization.channel !== current.channel || authorization.errorCode)) {
        throw new LocalImConnectionError(409, 'CHANNEL_CONNECTION_AUTHORIZATION_REQUIRED', 'The Channel Connection no longer has an active authorization.');
    }
    // Connection lane serializes one Connection; nested transport lane
    // serializes one external account. A new Binding persists an empty
    // cursor first and creates its Session lazily on the first inbound.
    if (await getImBindingForTransportClient(operations, current.channel, clientName)) {
        throw new LocalImConnectionError(409, 'CHANNEL_EXTERNAL_ALREADY_BOUND', 'The external Channel account is already bound.');
    }
    return undefined;
}
/** CAS guard: the caller-observed legacy route keys must still be current. */
function assertLegacyRouteKeysUnchanged(actual, expected) {
    if (expected && !sameLegacyRouteKeys(actual, expected)) {
        throw new LocalImConnectionError(409, 'CHANNEL_CONNECTION_MIGRATION_CONFLICT', 'The pending legacy migration was superseded by current V2 state.');
    }
}
/** Durable half of bind(): full recheck + insert under the mutation lane. */
async function persistNewImBinding(operations, bind) {
    const { connectionId, clientName, suppliedSessionId, expectedPendingLegacyRouteKeys } = bind;
    const binding = await mutateDurableYaml(operations.bindingsPath, (document) => {
        const data = readBindingData(document, operations.options.nowMs());
        const latest = data.connections.get(connectionId);
        if (!latest) {
            throw new LocalImConnectionError(404, 'CHANNEL_CONNECTION_NOT_FOUND', 'Channel Connection not found.');
        }
        const duplicate = findBindingForConnection(data.physicalBindings, latest.connectionId);
        if (duplicate) {
            if (expectedPendingLegacyRouteKeys &&
                !sameLegacyRouteKeys(duplicate.migratedLegacyRouteKeys, expectedPendingLegacyRouteKeys)) {
                throw new LocalImConnectionError(409, 'CHANNEL_CONNECTION_MIGRATION_CONFLICT', 'The pending legacy migration was superseded by current V2 state.');
            }
            return { changed: false, value: duplicate };
        }
        if (expectedPendingLegacyRouteKeys &&
            !sameLegacyRouteKeys(latest.pendingLegacyRouteKeys, expectedPendingLegacyRouteKeys)) {
            throw new LocalImConnectionError(409, 'CHANNEL_CONNECTION_MIGRATION_CONFLICT', 'The pending legacy migration was superseded by current V2 state.');
        }
        if (findBindingForTransportClient(data.physicalBindings, latest.channel, clientName)) {
            throw new LocalImConnectionError(409, 'CHANNEL_EXTERNAL_ALREADY_BOUND', 'The external Channel account is already bound.');
        }
        const now = operations.options.nowMs();
        const inserted = {
            bindingId: newImEntityId('binding'),
            connectionId: latest.connectionId,
            channel: latest.channel,
            clientName,
            currentSessionId: suppliedSessionId,
            resolvedProjectKey: latest.resolvedProjectKey,
            mutationReceipts: {},
            createdAt: now,
            updatedAt: now,
            ...(bind.migratedLegacyRouteKeys?.length
                ? { migratedLegacyRouteKeys: [...bind.migratedLegacyRouteKeys] }
                : {}),
        };
        if (latest.pendingLegacyRouteKeys?.length) {
            data.connections.set(latest.connectionId, {
                ...latest,
                pendingLegacyRouteKeys: undefined,
                updatedAt: operations.options.nowMs(),
            });
        }
        data.physicalBindings.set(inserted.bindingId, inserted);
        writeBindingData(document, data);
        return { changed: true, value: inserted };
    });
    // The authorization handshake is consumed exactly once by a successful bind.
    operations.authorizations.delete(connectionId);
    return binding;
}
export async function deleteImBinding(operations, connectionId) {
    // Uses the same outer Connection then transport/client lane as bind().
    return operations.connectionLane.run(connectionId, async () => {
        const connection = await requireImConnection(operations, connectionId);
        const expected = await getImBindingForConnection(operations, connection.connectionId);
        await operations.options.onDeleteBindingSnapshot?.({
            connectionId,
            ...(expected ? { bindingId: expected.bindingId } : {}),
        });
        if (!expected) {
            // An explicit unbind/cancel of a configured migration Connection is a
            // user takeover. Keep the Connection visible but never let an old
            // route resume its pending import.
            await clearImPendingLegacyMigration(operations, connection.connectionId);
            return false;
        }
        const transportKey = `${expected.channel}\u0000${expected.clientName}`;
        return operations.bindingLane.run(transportKey, () => mutateDurableYaml(operations.bindingsPath, (document) => {
            const data = readBindingData(document, operations.options.nowMs());
            const binding = findBindingForConnection(data.physicalBindings, connectionId);
            if (!binding || binding.bindingId !== expected.bindingId) {
                return { changed: false, value: false };
            }
            data.physicalBindings.delete(binding.bindingId);
            const latest = data.connections.get(connectionId);
            if (latest?.pendingLegacyRouteKeys?.length) {
                data.connections.set(connectionId, {
                    ...latest,
                    pendingLegacyRouteKeys: undefined,
                    updatedAt: operations.options.nowMs(),
                });
            }
            writeBindingData(document, data);
            return { changed: true, value: true };
        }));
    });
}
async function resolveImBindingAndConnection(operations, ctx) {
    const { bindingData } = await readImBindingState(operations);
    const binding = [...bindingData.physicalBindings.values()].find((candidate) => candidate.channel === ctx.platform && candidate.clientName === ctx.clientName);
    if (!binding)
        return undefined;
    const connection = bindingData.connections.get(binding.connectionId);
    if (!connection)
        throw invalidImStorage('physicalBindings', binding.bindingId);
    assertImBindingRuntimeState(binding, connection);
    return { binding, connection };
}
export async function resolveImRoute(operations, ctx) {
    const resolved = await resolveImBindingAndConnection(operations, ctx);
    if (!resolved)
        return undefined;
    const binding = requireBindingSessionState(resolved.binding).currentSessionId
        ? resolved.binding
        : await ensureImBindingSession(bindingConversationOperations(operations), resolved.connection, resolved.binding.bindingId);
    return toPinnedRoute(resolved.connection, binding);
}
/** Reads a physical IM route without creating a Session for an empty cursor. */
export async function peekImRoute(operations, ctx) {
    const resolved = await resolveImBindingAndConnection(operations, ctx);
    return resolved ? toPinnedRoute(resolved.connection, resolved.binding) : undefined;
}
export async function advanceImRoute(operations, ctx, requestId, telemetry) {
    const resolved = await resolveImBindingAndConnection(operations, ctx);
    if (!resolved)
        return undefined;
    const binding = await advanceImBinding(bindingConversationOperations(operations), {
        connection: resolved.connection,
        bindingId: resolved.binding.bindingId,
        requestId: requiredString(requestId, 'requestId'),
        ...(telemetry
            ? {
                telemetry: {
                    requestKey: telemetry.requestKey,
                    platform: ctx.platform,
                    bindingId: resolved.binding.bindingId,
                },
            }
            : {}),
    });
    return toPinnedRoute(resolved.connection, binding);
}
function toPinnedRoute(connection, binding) {
    const state = requireBindingSessionState(binding);
    const route = {
        blocked: false,
        agentName: connection.agentName,
        sessionId: state.currentSessionId,
        strategy: 'pin',
        ruleId: null,
        sessionTitle: '',
        imRoute: {
            connectionId: connection.connectionId,
            bindingId: binding.bindingId,
            ...(binding.imConversationId ? { imConversationId: binding.imConversationId } : {}),
        },
    };
    // These identifiers are for in-process validation and observability only;
    // adapter HTTP responses may serialize the resolved route.
    Object.defineProperty(route, 'imRoute', {
        value: route.imRoute,
        enumerable: false,
        configurable: true,
    });
    return route;
}
//# sourceMappingURL=im-connection-store-binding-operations.js.map