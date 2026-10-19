import { abortableDelay } from './operation-timeout.js';
const MAX_RETAINED_BROWSER_SNAPSHOTS = 3;
const BROWSER_SNAPSHOT_TTL_MS = 5 * 60 * 1_000;
export function storeBrowserSnapshot(session, snapshot) {
    session.snapshotAuthorityEstablished = true;
    const snapshots = browserSnapshotStore(session);
    pruneBrowserSnapshots(session, snapshots);
    snapshot.lastAccessedAt = Date.now();
    snapshots.set(snapshot.id, snapshot);
    session.snapshot = snapshot;
    while (snapshots.size > MAX_RETAINED_BROWSER_SNAPSHOTS) {
        const oldest = [...snapshots.values()].reduce((candidate, current) => !candidate || snapshotAccessTime(current) < snapshotAccessTime(candidate)
            ? current
            : candidate, undefined);
        if (!oldest)
            break;
        snapshots.delete(oldest.id);
    }
    refreshLatestBrowserSnapshot(session, snapshots);
}
export function getBrowserSnapshot(session, snapshotId) {
    const snapshots = browserSnapshotStore(session);
    pruneBrowserSnapshots(session, snapshots);
    const snapshot = snapshots.get(snapshotId);
    if (!snapshot ||
        snapshot.generation !== session.generation ||
        snapshot.continuationInvalidated === true) {
        return undefined;
    }
    snapshot.lastAccessedAt = Date.now();
    return snapshot;
}
export function resolveBrowserSnapshotElement(session, ref) {
    const snapshots = browserSnapshotStore(session);
    pruneBrowserSnapshots(session, snapshots);
    for (const snapshot of [...snapshots.values()].reverse()) {
        if (snapshot.generation !== session.generation)
            continue;
        const element = snapshot.elements.find((candidate) => candidate.ref === ref);
        if (!element)
            continue;
        snapshot.lastAccessedAt = Date.now();
        return { snapshot, element };
    }
    return undefined;
}
export function clearBrowserSnapshots(session) {
    session.snapshots?.clear();
    session.snapshot = undefined;
}
export function captureBrowserFrameEpochs(session) {
    return new Map(session.frameEpochs);
}
export function browserElementFrameIsCurrent(session, baseline, element) {
    const epochs = session.frameEpochs;
    if (!epochs)
        return true;
    return frameIdentityKeys(element).every((key) => (epochs.get(key) ?? 0) === (baseline.get(key) ?? 0));
}
/** Revoke only refs owned by a replaced child document while preserving stable main-page refs. */
export function invalidateBrowserFrame(session, identity) {
    const keys = frameIdentityKeys(identity);
    if (keys.length === 0)
        return;
    const epochs = (session.frameEpochs ??= new Map());
    for (const key of keys)
        epochs.set(key, (epochs.get(key) ?? 0) + 1);
    const snapshots = new Set(session.snapshots?.values() ?? []);
    if (session.snapshot)
        snapshots.add(session.snapshot);
    for (const snapshot of snapshots) {
        const retained = snapshot.elements.filter((element) => !frameIdentityMatches(element, identity));
        if (retained.length === snapshot.elements.length)
            continue;
        snapshot.elements = retained;
        snapshot.continuationInvalidated = true;
        if (identity.frameId)
            snapshot.frameRefs?.delete(identity.frameId);
        if (snapshot.editableQuery) {
            snapshot.editableQuery.elements = snapshot.editableQuery.elements.filter((element) => !frameIdentityMatches(element, identity));
        }
    }
    session.elementMap.replaceOpaqueRefs(session.snapshot?.elements ?? []);
    if (session.keyboardContinuationTarget &&
        frameIdentityMatches(session.keyboardContinuationTarget, identity)) {
        session.keyboardContinuationTarget = undefined;
    }
}
/**
 * Keep opaque targets addressable after ordinary page mutations, while
 * preventing callers from paging through an observation captured before the
 * mutation. Target execution still has to re-resolve the live backend node.
 */
export function invalidateBrowserObservations(session) {
    const snapshots = session.snapshots;
    if (!snapshots) {
        if (session.snapshot)
            session.snapshot.continuationInvalidated = true;
        return;
    }
    for (const snapshot of snapshots.values()) {
        snapshot.continuationInvalidated = true;
    }
}
function browserSnapshotStore(session) {
    const snapshots = (session.snapshots ??= new Map());
    if (session.snapshot && !snapshots.has(session.snapshot.id)) {
        session.snapshotAuthorityEstablished = true;
        snapshots.set(session.snapshot.id, session.snapshot);
    }
    return snapshots;
}
function frameIdentityKeys(identity) {
    return [
        ...(identity.frameId ? [`frame:${identity.frameId}`] : []),
        ...(identity.commandSessionId ? [`session:${identity.commandSessionId}`] : []),
    ];
}
function frameIdentityMatches(element, identity) {
    return Boolean((identity.frameId && element.frameId === identity.frameId) ||
        (identity.commandSessionId && element.commandSessionId === identity.commandSessionId));
}
function pruneBrowserSnapshots(session, snapshots) {
    const cutoff = Date.now() - BROWSER_SNAPSHOT_TTL_MS;
    for (const [snapshotId, snapshot] of snapshots) {
        if (snapshot.generation !== session.generation || snapshotAccessTime(snapshot) < cutoff) {
            snapshots.delete(snapshotId);
        }
    }
    refreshLatestBrowserSnapshot(session, snapshots);
}
function refreshLatestBrowserSnapshot(session, snapshots) {
    if (session.snapshot && snapshots.has(session.snapshot.id))
        return;
    session.snapshot = [...snapshots.values()].at(-1);
}
function snapshotAccessTime(snapshot) {
    return snapshot.lastAccessedAt ?? snapshot.createdAt;
}
export function cdp(session, method, params) {
    const commandSessionId = method.startsWith('Input.') ? undefined : session.commandSessionId;
    return session.transport.send(method, params, commandSessionId, {
        ...(session.commandSignal ? { signal: session.commandSignal } : {}),
        ...(session.commandTimeoutMs ? { timeoutMs: session.commandTimeoutMs } : {}),
    });
}
export function inputCoordinateScale(session) {
    const requestedScale = session.inputCoordinateScaleProvider?.() ?? 1;
    return Number.isFinite(requestedScale) && requestedScale > 0 ? requestedScale : 1;
}
export function inputCoordinate(session, point) {
    const scale = inputCoordinateScale(session);
    return {
        x: Math.round(point.x * scale),
        y: Math.round(point.y * scale),
    };
}
export async function evaluate(session, expression) {
    const options = {
        ...(session.commandSignal ? { signal: session.commandSignal } : {}),
        ...(session.commandTimeoutMs ? { timeoutMs: session.commandTimeoutMs } : {}),
    };
    if (!session.commandSessionId) {
        return session.transport.evaluate(expression, options);
    }
    const payload = await session.transport.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
    }, session.commandSessionId, options);
    if (payload.exceptionDetails) {
        throw new Error(payload.exceptionDetails.text ?? 'Page evaluation failed');
    }
    if (payload.result && 'value' in payload.result)
        return payload.result.value;
    if (payload.result?.unserializableValue === 'undefined')
        return undefined;
    return payload.result?.description;
}
export function asString(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}
export function asNumber(value, fallback = 0) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
export function stringArray(value) {
    return Array.isArray(value)
        ? value.filter((item) => typeof item === 'string')
        : [];
}
export function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function byteLength(value) {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
export function delay(ms, signal) {
    return abortableDelay(ms, signal);
}
//# sourceMappingURL=browser-state.js.map