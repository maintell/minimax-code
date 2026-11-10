import { APP_SERVER_PROTOCOL_VERSION } from './constants.js';
export const APP_SERVER_PROTOCOL_MISMATCH_KIND = 'protocolMismatch';
export const APP_SERVER_TRANSPORT_MISMATCH_KIND = 'transportProtocolMismatch';
export function evaluateAppServerTransportCompatibility(options) {
    const clientVersion = readProtocolVersion(options.clientTransportProtocolVersion);
    const serverVersion = readProtocolVersion(options.serverTransportProtocolVersion);
    if (serverVersion === undefined) {
        throw new Error('The server RuntimeTransport protocol version must be a positive integer.');
    }
    if (clientVersion === serverVersion) {
        return { compatible: true, transportProtocolVersion: serverVersion };
    }
    if (clientVersion === undefined) {
        return transportMismatch(options.clientTransportProtocolVersion === undefined ||
            options.clientTransportProtocolVersion === null
            ? 'clientTransportProtocolMissing'
            : 'clientTransportProtocolInvalid', 'upgradeClient', null, serverVersion);
    }
    return clientVersion < serverVersion
        ? transportMismatch('clientTransportProtocolTooOld', 'upgradeClient', clientVersion, serverVersion)
        : transportMismatch('serverTransportProtocolTooOld', 'upgradeRemoteCli', clientVersion, serverVersion);
}
export function formatAppServerTransportMismatch(data) {
    const versions = `(client transport ${formatVersion(data.clientTransportProtocolVersion)}, server transport ${data.serverTransportProtocolVersion})`;
    return data.recommendedAction === 'upgradeClient'
        ? `MCode RuntimeTransport protocol mismatch ${versions}. Upgrade the MCode client and reconnect.`
        : `MCode RuntimeTransport protocol mismatch ${versions}. Upgrade MCode CLI on the SSH host and reconnect.`;
}
/**
 * Compares exact protocol versions without attempting a wire downgrade.
 * Version numbers are monotonic, so the older side is the side to upgrade.
 */
export function evaluateAppServerProtocolCompatibility(options) {
    const clientProtocolVersion = readProtocolVersion(options.clientProtocolVersion);
    const serverProtocolVersion = readProtocolVersion(options.serverProtocolVersion);
    if (clientProtocolVersion === undefined) {
        return mismatch(options.clientProtocolVersion === undefined || options.clientProtocolVersion === null
            ? 'clientProtocolMissing'
            : 'clientProtocolInvalid', 'upgradeClient', null, serverProtocolVersion ?? null, options);
    }
    if (serverProtocolVersion === undefined) {
        return mismatch(options.serverProtocolVersion === undefined || options.serverProtocolVersion === null
            ? 'serverProtocolMissing'
            : 'serverProtocolInvalid', 'upgradeRemoteCli', clientProtocolVersion, null, options);
    }
    if (clientProtocolVersion === serverProtocolVersion) {
        return { compatible: true, protocolVersion: clientProtocolVersion };
    }
    if (clientProtocolVersion < serverProtocolVersion) {
        return mismatch('clientProtocolTooOld', 'upgradeClient', clientProtocolVersion, serverProtocolVersion, options);
    }
    return mismatch('serverProtocolTooOld', 'upgradeRemoteCli', clientProtocolVersion, serverProtocolVersion, options);
}
/**
 * Client-side guard for an untrusted `initialize.result`. A missing version is
 * an old server and must lead to the remote-CLI upgrade path.
 */
export function evaluateAppServerInitializeResult(result, options = {}) {
    const resultRecord = readRecord(result);
    const serverInfo = readRecord(resultRecord?.serverInfo);
    return evaluateAppServerProtocolCompatibility({
        clientProtocolVersion: options.clientProtocolVersion ?? APP_SERVER_PROTOCOL_VERSION,
        serverProtocolVersion: resultRecord?.protocolVersion,
        ...(options.clientVersion ? { clientVersion: options.clientVersion } : {}),
        ...(typeof serverInfo?.version === 'string' ? { serverVersion: serverInfo.version } : {}),
    });
}
export function isAppServerProtocolMismatchData(value) {
    const record = readRecord(value);
    if (!record || record.kind !== APP_SERVER_PROTOCOL_MISMATCH_KIND)
        return false;
    if (!isMismatchReason(record.reason))
        return false;
    const expectedAction = upgradeActionForReason(record.reason);
    return (isNullableProtocolVersion(record.clientProtocolVersion) &&
        isNullableProtocolVersion(record.serverProtocolVersion) &&
        (record.clientVersion === undefined || typeof record.clientVersion === 'string') &&
        (record.serverVersion === undefined || typeof record.serverVersion === 'string') &&
        record.recommendedAction === expectedAction);
}
export function formatAppServerProtocolMismatch(data) {
    const versions = `(client protocol ${formatVersion(data.clientProtocolVersion)}, server protocol ${formatVersion(data.serverProtocolVersion)})`;
    return data.recommendedAction === 'upgradeClient'
        ? `MCode SSH app-server protocol mismatch ${versions}. Upgrade the MCode client and reconnect.`
        : `MCode SSH app-server protocol mismatch ${versions}. Upgrade MCode CLI on the SSH host and reconnect.`;
}
function mismatch(reason, recommendedAction, clientProtocolVersion, serverProtocolVersion, versions) {
    return {
        compatible: false,
        mismatch: {
            kind: APP_SERVER_PROTOCOL_MISMATCH_KIND,
            reason,
            clientProtocolVersion,
            serverProtocolVersion,
            ...(versions.clientVersion ? { clientVersion: versions.clientVersion } : {}),
            ...(versions.serverVersion ? { serverVersion: versions.serverVersion } : {}),
            recommendedAction,
        },
    };
}
function transportMismatch(reason, recommendedAction, clientTransportProtocolVersion, serverTransportProtocolVersion) {
    return {
        compatible: false,
        mismatch: {
            kind: APP_SERVER_TRANSPORT_MISMATCH_KIND,
            reason,
            clientTransportProtocolVersion,
            serverTransportProtocolVersion,
            recommendedAction,
        },
    };
}
function readProtocolVersion(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function isNullableProtocolVersion(value) {
    return value === null || readProtocolVersion(value) !== undefined;
}
function isMismatchReason(value) {
    return (value === 'clientProtocolMissing' ||
        value === 'clientProtocolInvalid' ||
        value === 'clientProtocolTooOld' ||
        value === 'serverProtocolMissing' ||
        value === 'serverProtocolInvalid' ||
        value === 'serverProtocolTooOld');
}
function upgradeActionForReason(reason) {
    return reason.startsWith('client') ? 'upgradeClient' : 'upgradeRemoteCli';
}
function readRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function formatVersion(version) {
    return version === null ? 'unknown' : String(version);
}
//# sourceMappingURL=compatibility.js.map