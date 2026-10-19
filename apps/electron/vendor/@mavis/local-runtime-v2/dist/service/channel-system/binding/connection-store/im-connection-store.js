/**
 * Migration copy (MR1) of v1 `channels/im-connection-store.ts`.
 */
import { join } from 'node:path';
import { KeyedOperationLane } from '@mavis/shared/keyed-operation-lane';
import { advanceImRoute, bindImConnection, deleteImBinding, getImBindingSnapshot, moveImBindingSessionIfCurrent, peekImRoute, resolveImRoute, } from './im-connection-store-binding-operations.js';
import { beginImAuthorization, cancelImAuthorization, deleteImConnection, expireImAuthorization, findImConnection, listImConnectionViews, markImAuthorizationError, prepareImConnection, } from './im-connection-store-connection-operations.js';
import { migrateImLegacyConnections, } from './im-connection-store-legacy-operations.js';
import { findImAuthorizationByPlatformSession, getImAuthorization, getImConnection, } from './im-connection-store-operations.js';
import {} from '../im-connection-types.js';
export {} from '../im-connection-types.js';
/**
 * Durable IM Connection and physical Binding facts. `channel-bindings.yaml.bindings`
 * remains a legacy per-chat route cache; online cursors live only on
 * `physicalBindings`, while `channel-routes.yaml.imConversations` is retained
 * as historical evidence for one-time transfer.
 */
export class LocalImConnectionStore {
    options;
    /** Serializes mutations for one durable Connection. */
    connectionLane = new KeyedOperationLane();
    /** Serializes binds/unbinds of one external transport account. */
    bindingLane = new KeyedOperationLane();
    /** Serializes cursor mutation for one physical Binding. */
    bindingSessionLane = new KeyedOperationLane();
    authorizations = new Map();
    constructor(options) {
        this.options = options;
    }
    async prepare(input) {
        return prepareImConnection(this.operations, input);
    }
    async getConnection(connectionId) {
        return getImConnection(this.operations, connectionId);
    }
    /** Read one physical Binding with the Connection that owns its live cursor. */
    async getBindingSnapshot(bindingId) {
        return getImBindingSnapshot(this.operations, bindingId);
    }
    async moveBindingSessionIfCurrent(input) {
        return moveImBindingSessionIfCurrent(this.operations, input);
    }
    async findConnection(agentName, channel) {
        return findImConnection(this.operations, agentName, channel);
    }
    async beginAuthorization(input) {
        return beginImAuthorization(this.operations, input);
    }
    getAuthorization(connectionId) {
        return getImAuthorization(this.operations, connectionId);
    }
    findAuthorizationByPlatformSession(channel, platformSessionId) {
        return findImAuthorizationByPlatformSession(this.operations, channel, platformSessionId);
    }
    async cancelAuthorization(connectionId) {
        return cancelImAuthorization(this.operations, connectionId);
    }
    async expireAuthorization(connectionId) {
        return expireImAuthorization(this.operations, connectionId);
    }
    async markAuthorizationError(connectionId, channel, errorCode) {
        return markImAuthorizationError(this.operations, connectionId, channel, errorCode);
    }
    async bind(input) {
        return bindImConnection(this.operations, input);
    }
    async deleteBinding(connectionId) {
        return deleteImBinding(this.operations, connectionId);
    }
    /** Permanently delete one IM Bot while retaining its historical Sessions. */
    async deleteConnection(connectionId, beforeDelete) {
        return deleteImConnection(this.operations, connectionId, beforeDelete);
    }
    async listViews(channelFilter) {
        return listImConnectionViews(this.operations, channelFilter);
    }
    async resolveRoute(ctx) {
        return resolveImRoute(this.operations, ctx);
    }
    /** Reads a physical IM route without creating a Session for an empty cursor. */
    async peekRoute(ctx) {
        return peekImRoute(this.operations, ctx);
    }
    async advance(ctx, requestId, telemetry) {
        return advanceImRoute(this.operations, ctx, requestId, telemetry);
    }
    async migrateLegacy(input) {
        return migrateImLegacyConnections(this.operations, input, {
            findConnection: (agentName, channel) => this.findConnection(agentName, channel),
            prepareConnection: (prepared) => this.prepare(prepared),
            bindConnection: (binding) => this.bind(binding),
        });
    }
    get operations() {
        return {
            bindingsPath: join(this.options.dataDir(), 'channel-bindings.yaml'),
            routesPath: join(this.options.dataDir(), 'channel-routes.yaml'),
            connectionLane: this.connectionLane,
            bindingLane: this.bindingLane,
            bindingSessionLane: this.bindingSessionLane,
            authorizations: this.authorizations,
            options: this.options,
        };
    }
}
//# sourceMappingURL=im-connection-store.js.map