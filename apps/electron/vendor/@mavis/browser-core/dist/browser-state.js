import { abortableDelay } from './operation-timeout.js';
const MAX_RETAINED_BROWSER_SNAPSHOTS = 3;
/**
 * Refs outlive the continuation window. Eval 769392: on unchanged pages
 * (`urlChanged: false`, same generation) models routinely run inspect → click
 * → inspect … and then act on a ref seen 4+ observations earlier; with only
 * three retained snapshots that ref was already evicted and failed as
 * STALE_ELEMENT_REF although the element was still live. Keeping a bounded
 * pool of same-generation snapshots for ref resolution is safe because target
 * execution still re-measures the backend node and reports a detached
 * (re-rendered) node as stale. Navigation still revokes every ref.
 */
const MAX_RETIRED_BROWSER_SNAPSHOTS = 12;
const BROWSER_SNAPSHOT_TTL_MS = 5 * 60 * 1_000;
/**
 * Bound for the issued-ref ledger. Eval 774252: ~20 of 22 "no longer retained"
 * STALE_ELEMENT_REF errors were refs the session never published (`ref-008`,
 * invented ids, or a real id with its generation prefix edited). Telling the
 * model the ref was never issued points it at copying refs verbatim instead of
 * suggesting the harness forgot them.
 */
const MAX_ISSUED_BROWSER_REF_IDS = 20_000;
const BROWSER_REF_PATTERN = /^browser-element:(\d+)-(.+)$/u;
function recordIssuedBrowserRefs(session, snapshot) {
    const issued = (session.issuedRefIds ??= new Map());
    for (const element of snapshot.elements) {
        const match = BROWSER_REF_PATTERN.exec(element.ref);
        if (!match?.[2])
            continue;
        issued.delete(match[2]);
        issued.set(match[2], Number(match[1]));
    }
    while (issued.size > MAX_ISSUED_BROWSER_REF_IDS) {
        const first = issued.keys().next().value;
        if (first === undefined)
            break;
        issued.delete(first);
        session.issuedRefIdsTruncated = true;
    }
}
export function storeBrowserSnapshot(session, snapshot) {
    session.snapshotAuthorityEstablished = true;
    recordIssuedBrowserRefs(session, snapshot);
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
        retireBrowserSnapshot(session, oldest);
    }
    refreshLatestBrowserSnapshot(session, snapshots);
}
function retireBrowserSnapshot(session, snapshot) {
    if (snapshot.generation !== session.generation)
        return;
    const retired = (session.retiredSnapshots ??= new Map());
    retired.set(snapshot.id, snapshot);
    while (retired.size > MAX_RETIRED_BROWSER_SNAPSHOTS) {
        const first = retired.keys().next().value;
        if (first === undefined)
            break;
        retired.delete(first);
    }
}
function pruneRetiredBrowserSnapshots(session) {
    const retired = (session.retiredSnapshots ??= new Map());
    const cutoff = Date.now() - BROWSER_SNAPSHOT_TTL_MS;
    for (const [snapshotId, snapshot] of retired) {
        if (snapshot.generation !== session.generation || snapshotAccessTime(snapshot) < cutoff) {
            retired.delete(snapshotId);
        }
    }
    return retired;
}
/**
 * Explain why an opaque ref no longer resolves. The generation embedded in
 * `browser-element:<generation>-<id>` distinguishes a ref from an earlier page
 * (navigation revoked it) from one that simply aged out of retention.
 */
export function describeUnresolvedBrowserRef(session, ref) {
    const match = BROWSER_REF_PATTERN.exec(ref);
    const generation = match?.[1];
    // Eval 777827: `e1` / `e28` (another tool's ref dialect) were sent before
    // the ledger existed and fell through to "no longer retained". The shape
    // check is a pure message decision made after resolution already failed.
    if (!match) {
        return `STALE_ELEMENT_REF: "${ref}" is not a Browser element ref; refs have the form browser-element:<n>-<id> and must be copied exactly from the latest inspect or query output`;
    }
    const ledger = session.snapshotAuthorityEstablished ? session.issuedRefIds : undefined;
    if (ledger && ledger.size > 0) {
        const issuedGeneration = ledger.get(match[2] ?? '');
        if (issuedGeneration !== undefined && issuedGeneration !== Number(generation)) {
            return `STALE_ELEMENT_REF: element ref was altered: this id was issued as browser-element:${issuedGeneration}-${match[2]}, and refs must be copied verbatim (editing the number does not refresh them); inspect or query the current page and use a new ref`;
        }
        if (issuedGeneration === undefined && !session.issuedRefIdsTruncated) {
            return 'STALE_ELEMENT_REF: element ref was never issued by this Browser session (a tab reset after a timeout also discards earlier refs); copy refs exactly from the latest inspect or query output instead of composing them';
        }
    }
    if (generation !== undefined && Number(generation) !== session.generation) {
        return 'STALE_ELEMENT_REF: element ref is from an earlier page state (the page navigated after it was observed); inspect or query the current page and use a new ref';
    }
    return 'STALE_ELEMENT_REF: element ref is not from the current inspect snapshot (it is no longer retained); inspect or query the current page and use a new ref';
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
    for (const snapshot of [...pruneRetiredBrowserSnapshots(session).values()].reverse()) {
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
    session.retiredSnapshots?.clear();
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
    const snapshots = new Set([
        ...(session.snapshots?.values() ?? []),
        ...(session.retiredSnapshots?.values() ?? []),
    ]);
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
/**
 * CDP reports every thrown page exception with the generic text "Uncaught";
 * the actual error (for example `SyntaxError: ... is not a valid selector`) is
 * in `exception.description`. Surface the real message so callers can classify
 * and correct it instead of seeing only "Uncaught" (eval: 17 query failures).
 */
export function describeCdpException(details, fallback) {
    if (!details || typeof details !== 'object')
        return fallback;
    const record = details;
    const exception = record.exception;
    const described = exception && typeof exception === 'object'
        ? typeof exception.description === 'string' && exception.description.trim()
            ? exception.description
            : typeof exception.value === 'string' && exception.value.trim()
                ? exception.value
                : ''
        : '';
    // description carries a stack trace after the first line; keep the message only.
    const firstLine = described.split('\n')[0]?.trim() ?? '';
    if (firstLine)
        return firstLine.slice(0, 500);
    const text = typeof record.text === 'string' ? record.text.trim() : '';
    return text || fallback;
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
        throw new Error(describeCdpException(payload.exceptionDetails, 'Page evaluation failed'));
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