import electronStore from "electron-store";
import { isSafeSshHost, isValidSshConnectionEndpoint, isSafeAbsoluteRemotePath } from "./config";
const SNAPSHOT_KEY = 'snapshot';
const SNAPSHOT_VERSION = 2;
const LEGACY_SNAPSHOT_VERSION = 1;
const MAX_DISPLAY_NAME_LENGTH = 80;
export class SshConnectionRepositoryError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'SshConnectionRepositoryError';
    }
}

/** Persists product connection identity and validated endpoint metadata, never key contents. */
export class SshConnectionRepository {
    constructor(store, now = Date.now) {
        this.store = store;
        this.now = now;
        this.identityRevisions = new Map();
    }
    list() {
        return this.readConnections().map(cloneConnection);
    }
    get(alias) {
        const connection = this.readConnections().find((candidate) => candidate.alias === alias);
        return connection ? cloneConnection(connection) : null;
    }
    /** Invalidates in-flight work when an alias is removed and later re-added. */
    getIdentityRevision(alias) {
        return this.identityRevisions.get(alias) ?? 0;
    }
    add(value) {
        const input = normalizePersistInput(value);
        if (!input) {
            throw new SshConnectionRepositoryError('invalid_connection', 'Invalid SSH connection.');
        }
        const { alias } = input;
        const connections = this.readConnections();
        if (connections.some((connection) => connection.alias === alias)) {
            throw new SshConnectionRepositoryError('connection_exists', 'This SSH connection already exists.');
        }
        const timestamp = this.now();
        const connection = {
            ...input,
            enabled: true,
            createdAtMs: timestamp,
            updatedAtMs: timestamp,
        };
        this.writeConnections([...connections, connection]);
        this.identityRevisions.set(alias, this.getIdentityRevision(alias) + 1);
        return cloneConnection(connection);
    }
    updateDisplayName(aliasValue, displayNameValue) {
        return this.updateConnection(aliasValue, displayNameValue);
    }
    updateConnection(aliasValue, displayNameValue, endpoint) {
        const alias = aliasValue.trim();
        const displayName = normalizeDisplayName(displayNameValue);
        if (!isSafeSshHost(alias) ||
            !displayName ||
            (endpoint && !isValidSshConnectionEndpoint(endpoint))) {
            throw new SshConnectionRepositoryError('invalid_connection', 'Invalid SSH connection.');
        }
        const connections = this.readConnections();
        const index = connections.findIndex((connection) => connection.alias === alias);
        if (index < 0) {
            throw new SshConnectionRepositoryError('connection_not_found', 'SSH connection not found.');
        }
        const previous = connections[index];
        const nextEndpoint = endpoint ?? previous.endpoint;
        const endpointChanged = JSON.stringify(nextEndpoint) !== JSON.stringify(previous.endpoint);
        const updated = {
            ...previous,
            displayName,
            endpoint: { ...nextEndpoint },
            ...(endpointChanged ? { mcodePath: undefined } : {}),
            updatedAtMs: displayName === previous.displayName && !endpointChanged
                ? previous.updatedAtMs
                : this.now(),
        };
        connections[index] = updated;
        this.writeConnections(connections);
        if (endpointChanged)
            this.identityRevisions.set(alias, this.getIdentityRevision(alias) + 1);
        return cloneConnection(updated);
    }
    setMcodePath(alias, mcodePath) {
        if (!isSafeAbsoluteRemotePath(mcodePath))
            throw new SshConnectionRepositoryError('invalid_connection', 'Invalid remote CLI path.');
        const connections = this.readConnections();
        const connection = connections.find((entry) => entry.alias === alias);
        if (!connection)
            throw new SshConnectionRepositoryError('connection_not_found', 'SSH connection not found.');
        connection.mcodePath = mcodePath;
        this.writeConnections(connections);
    }
    setEnabled(aliasValue, enabled) {
        const alias = aliasValue.trim();
        if (!isSafeSshHost(alias)) {
            throw new SshConnectionRepositoryError('invalid_connection', 'Invalid SSH host alias.');
        }
        const connections = this.readConnections();
        const index = connections.findIndex((connection) => connection.alias === alias);
        if (index < 0) {
            throw new SshConnectionRepositoryError('connection_not_found', 'SSH connection not found.');
        }
        const previous = connections[index];
        const updated = {
            ...previous,
            enabled,
            updatedAtMs: enabled === previous.enabled ? previous.updatedAtMs : this.now(),
        };
        connections[index] = updated;
        this.writeConnections(connections);
        return cloneConnection(updated);
    }
    remove(aliasValue) {
        const alias = aliasValue.trim();
        if (!isSafeSshHost(alias))
            return false;
        const connections = this.readConnections();
        const remaining = connections.filter((connection) => connection.alias !== alias);
        if (remaining.length === connections.length)
            return false;
        this.writeConnections(remaining);
        this.identityRevisions.set(alias, this.getIdentityRevision(alias) + 1);
        return true;
    }
    readConnections() {
        const snapshot = this.store.get(SNAPSHOT_KEY);
        if (!isRecord(snapshot))
            return [];
        if (!Array.isArray(snapshot.connections))
            return [];
        if (snapshot.version === SNAPSHOT_VERSION) {
            return snapshot.connections.filter(isStoredConnection).map(cloneConnection);
        }
        if (snapshot.version === LEGACY_SNAPSHOT_VERSION) {
            return snapshot.connections.filter(isLegacyConnection).map((connection) => ({
                ...connection,
                displayName: connection.alias,
                endpoint: { kind: 'ssh_config', hostAlias: connection.alias },
            }));
        }
        return [];
    }
    writeConnections(connections) {
        this.store.set(SNAPSHOT_KEY, { version: SNAPSHOT_VERSION, connections });
    }
}

export function createPersistentSshConnectionRepository() {
    const store = new electronStore({
        name: 'ssh-connections',
        defaults: { snapshot: { version: SNAPSHOT_VERSION, connections: [] } },
    });
    return new SshConnectionRepository(store);
}
function isStoredConnection(value) {
    if (!isRecord(value))
        return false;
    return (typeof value.alias === 'string' &&
        isSafeSshHost(value.alias) &&
        typeof value.displayName === 'string' &&
        normalizeDisplayName(value.displayName) === value.displayName &&
        isRecord(value.endpoint) &&
        isValidSshConnectionEndpoint(value.endpoint) &&
        typeof value.enabled === 'boolean' &&
        (value.mcodePath === undefined ||
            (typeof value.mcodePath === 'string' && isSafeAbsoluteRemotePath(value.mcodePath))) &&
        typeof value.createdAtMs === 'number' &&
        Number.isSafeInteger(value.createdAtMs) &&
        typeof value.updatedAtMs === 'number' &&
        Number.isSafeInteger(value.updatedAtMs) &&
        value.updatedAtMs >= value.createdAtMs);
}
function isLegacyConnection(value) {
    if (!isRecord(value))
        return false;
    return (typeof value.alias === 'string' &&
        isSafeSshHost(value.alias) &&
        typeof value.enabled === 'boolean' &&
        typeof value.createdAtMs === 'number' &&
        Number.isSafeInteger(value.createdAtMs) &&
        typeof value.updatedAtMs === 'number' &&
        Number.isSafeInteger(value.updatedAtMs) &&
        value.updatedAtMs >= value.createdAtMs);
}
function normalizePersistInput(value) {
    if (typeof value === 'string') {
        const alias = value.trim();
        return isSafeSshHost(alias)
            ? {
                alias,
                displayName: alias,
                endpoint: { kind: 'ssh_config', hostAlias: alias },
            }
            : null;
    }
    const alias = value.alias.trim();
    const displayName = normalizeDisplayName(value.displayName);
    if (!isSafeSshHost(alias) || !displayName || !isValidSshConnectionEndpoint(value.endpoint)) {
        return null;
    }
    return { alias, displayName, endpoint: { ...value.endpoint } };
}
function normalizeDisplayName(value) {
    const displayName = value.trim();
    if (!displayName || displayName.length > MAX_DISPLAY_NAME_LENGTH)
        return null;
    if (/[\u0000-\u001f\u007f]/u.test(displayName))
        return null;
    return displayName;
}
function cloneConnection(connection) {
    const copy = { ...connection, endpoint: { ...connection.endpoint } };
    Reflect.deleteProperty(copy, 'remoteLoggedOut');
    return copy;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
