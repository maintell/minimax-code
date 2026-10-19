import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { ensureResolvedSessionHistoryPaths, resolveLegacyLocalSessionHistoryPaths, resolveSessionHistoryPaths, resolveSessionHistoryPathsFromRelativeDir, utcSessionHistoryRelativeDir, } from './session-history-paths.js';
const MANIFEST_SCAN_CONCURRENCY = 16;
const HISTORY_KIND_PRIORITY = { canonical: 2, legacy: 1, manifest: 0 };
/** Resolves legacy layouts once, then persists the selected relative directory. */
export function createSessionHistoryLocationResolver(options) {
    const inFlight = new Map();
    let manifestIndex;
    const resolve = async (session) => resolveBoundOrTrack(session, () => resolveUnbound(session));
    const allocate = async (session) => ensureResolvedSessionHistoryPaths(await resolveBoundOrTrack(session, () => bindRelativeDir(session, utcSessionHistoryRelativeDir(session.sessionId, session.createdAtMs))), session);
    const ensure = async (session) => ensureResolvedSessionHistoryPaths(await resolve(session), session);
    const inspect = async (session) => session.historyRelativeDir
        ? resolveSessionHistoryPaths(options.dataDir, session)
        : resolveSessionHistoryPathsFromRelativeDir(options.dataDir, await selectUnboundRelativeDir(session));
    const inspectSession = async (sessionId) => {
        const session = await options.sessions.get(sessionId);
        if (!session)
            return undefined;
        return { session, paths: await inspect(session) };
    };
    const resolveSession = async (sessionId) => {
        const session = await options.sessions.get(sessionId);
        if (!session)
            return undefined;
        return { session, paths: await resolve(session) };
    };
    function resolveBoundOrTrack(identity, operation) {
        if (identity.historyRelativeDir) {
            return Promise.resolve(resolveSessionHistoryPaths(options.dataDir, identity));
        }
        const pending = inFlight.get(identity.sessionId);
        if (pending)
            return pending;
        const task = runTracked(identity.sessionId, operation);
        inFlight.set(identity.sessionId, task);
        return task;
    }
    async function runTracked(sessionId, operation) {
        try {
            return await operation();
        }
        finally {
            inFlight.delete(sessionId);
        }
    }
    async function resolveUnbound(identity) {
        const relativeDir = await selectUnboundRelativeDir(identity);
        return bindRelativeDir(identity, relativeDir);
    }
    async function selectUnboundRelativeDir(identity) {
        return ((await discoverLegacyRelativeDir(identity)) ??
            utcSessionHistoryRelativeDir(identity.sessionId, identity.createdAtMs));
    }
    async function bindRelativeDir(identity, relativeDir) {
        resolveSessionHistoryPathsFromRelativeDir(options.dataDir, relativeDir);
        const bound = options.sessions.bindHistoryRelativeDir
            ? await options.sessions.bindHistoryRelativeDir(identity.sessionId, relativeDir)
            : relativeDir;
        if (!bound)
            throw new Error(`Session not found while binding history: ${identity.sessionId}`);
        return resolveSessionHistoryPathsFromRelativeDir(options.dataDir, bound);
    }
    async function discoverLegacyRelativeDir(session) {
        const legacyPaths = resolveLegacyLocalSessionHistoryPaths(options.dataDir, session);
        const direct = await readManifestCandidate(options.dataDir, legacyPaths.manifest);
        const index = await loadManifestIndex();
        const indexed = index.get(manifestKey(session)) ?? [];
        const candidates = uniqueCandidates(direct && matchesSession(direct, session) ? [direct, ...indexed] : indexed);
        return selectCandidate(candidates, session)?.relativeDir;
    }
    async function loadManifestIndex() {
        manifestIndex ??= buildManifestIndex(options.dataDir);
        try {
            return await manifestIndex;
        }
        catch (error) {
            manifestIndex = undefined;
            throw error;
        }
    }
    return { resolve, allocate, ensure, inspect, inspectSession, resolveSession };
}
async function buildManifestIndex(dataDir) {
    const root = join(dataDir, 'v2', 'sessions');
    const manifests = await listManifestPaths(root);
    const candidates = (await mapWithConcurrency(manifests, MANIFEST_SCAN_CONCURRENCY, (path) => readManifestCandidate(dataDir, path))).filter((candidate) => candidate !== undefined);
    return candidates.reduce((index, candidate) => {
        const key = manifestKey(candidate);
        index.set(key, [...(index.get(key) ?? []), candidate]);
        return index;
    }, new Map());
}
async function listManifestPaths(root) {
    const years = await safeReadDirectories(root);
    const months = await pathsAtDepth(root, years);
    const days = await pathsAtDepth(root, months);
    const sessions = await pathsAtDepth(root, days);
    return sessions.map((sessionDir) => join(root, sessionDir, 'manifest.json'));
}
async function pathsAtDepth(root, parents) {
    const children = await mapWithConcurrency(parents, MANIFEST_SCAN_CONCURRENCY, async (parent) => (await safeReadDirectories(join(root, parent))).map((child) => join(parent, child)));
    return children.flat();
}
async function safeReadDirectories(path) {
    try {
        return (await readdir(path, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
            .map(({ name }) => name);
    }
    catch (error) {
        if (hasCode(error, 'ENOENT'))
            return [];
        throw error;
    }
}
async function readManifestCandidate(dataDir, manifestPath) {
    try {
        return await readExistingManifestCandidate(dataDir, manifestPath);
    }
    catch (error) {
        if (isIgnorableManifestError(error))
            return undefined;
        throw error;
    }
}
async function readExistingManifestCandidate(dataDir, manifestPath) {
    const info = await lstat(manifestPath);
    if (!info.isFile() || info.isSymbolicLink())
        return undefined;
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (!isManifestIdentity(parsed))
        return undefined;
    const sessionDir = dirname(manifestPath);
    const root = join(dataDir, 'v2', 'sessions');
    const relativeDir = relative(root, sessionDir).split(sep).join('/');
    const paths = resolveSessionHistoryPathsFromRelativeDir(dataDir, relativeDir);
    const [canonicalTargetModifiedAtMs, ledgerModifiedAtMs, snapshotModifiedAtMs] = await Promise.all([
        regularFileModifiedAtMs(paths.messages),
        regularFileModifiedAtMs(join(paths.sessionDir, 'ledger.jsonl')),
        regularFileModifiedAtMs(join(paths.sessionDir, 'snapshot.json')),
    ]);
    const historyArtifactModifiedAtMs = latestModifiedAtMs([
        canonicalTargetModifiedAtMs,
        ledgerModifiedAtMs,
        snapshotModifiedAtMs,
    ]);
    return {
        sessionId: parsed.sessionId,
        createdAtMs: parsed.createdAtMs,
        relativeDir,
        historyKind: candidateHistoryKind(canonicalTargetModifiedAtMs, historyArtifactModifiedAtMs),
        modifiedAtMs: canonicalTargetModifiedAtMs ?? historyArtifactModifiedAtMs ?? info.mtimeMs,
    };
}
function candidateHistoryKind(canonicalTargetModifiedAtMs, historyArtifactModifiedAtMs) {
    if (canonicalTargetModifiedAtMs !== undefined)
        return 'canonical';
    if (historyArtifactModifiedAtMs !== undefined)
        return 'legacy';
    return 'manifest';
}
function isIgnorableManifestError(error) {
    return (hasCode(error, 'ENOENT') ||
        error instanceof SyntaxError ||
        (error instanceof Error && /Session history relative directory/u.test(error.message)));
}
function selectCandidate(candidates, session) {
    if (candidates.length <= 1)
        return candidates[0];
    const first = candidates[0];
    if (!first)
        return undefined;
    const utcRelativeDir = utcSessionHistoryRelativeDir(session.sessionId, session.createdAtMs);
    // Duplicate manifests must not block a Turn: prefer stronger history, then recent activity.
    return candidates
        .slice(1)
        .reduce((selected, candidate) => compareCandidates(candidate, selected, utcRelativeDir) < 0 ? candidate : selected, first);
}
function compareCandidates(left, right, utcRelativeDir) {
    const leftPriority = HISTORY_KIND_PRIORITY[left.historyKind];
    const rightPriority = HISTORY_KIND_PRIORITY[right.historyKind];
    if (leftPriority !== rightPriority) {
        return leftPriority > rightPriority ? -1 : 1;
    }
    if (left.modifiedAtMs !== right.modifiedAtMs) {
        return left.modifiedAtMs > right.modifiedAtMs ? -1 : 1;
    }
    const leftIsUtc = left.relativeDir === utcRelativeDir;
    const rightIsUtc = right.relativeDir === utcRelativeDir;
    if (leftIsUtc !== rightIsUtc)
        return leftIsUtc ? -1 : 1;
    if (left.relativeDir === right.relativeDir)
        return 0;
    return left.relativeDir < right.relativeDir ? -1 : 1;
}
function uniqueCandidates(candidates) {
    return [...new Map(candidates.map((candidate) => [candidate.relativeDir, candidate])).values()];
}
function matchesSession(candidate, session) {
    return (candidate?.sessionId === session.sessionId && candidate.createdAtMs === session.createdAtMs);
}
function manifestKey(identity) {
    return `${identity.sessionId}\u0000${String(identity.createdAtMs)}`;
}
function isManifestIdentity(value) {
    return (typeof value === 'object' &&
        value !== null &&
        typeof Reflect.get(value, 'sessionId') === 'string' &&
        typeof Reflect.get(value, 'createdAtMs') === 'number' &&
        Number.isSafeInteger(Reflect.get(value, 'createdAtMs')));
}
async function regularFileModifiedAtMs(path) {
    try {
        const info = await lstat(path);
        return info.isFile() && !info.isSymbolicLink() ? info.mtimeMs : undefined;
    }
    catch (error) {
        if (hasCode(error, 'ENOENT'))
            return undefined;
        throw error;
    }
}
function latestModifiedAtMs(values) {
    const present = values.filter((value) => value !== undefined);
    return present.length > 0 ? Math.max(...present) : undefined;
}
async function mapWithConcurrency(values, concurrency, mapper) {
    const results = new Array(values.length);
    let nextIndex = 0;
    const worker = async () => {
        while (nextIndex < values.length) {
            const index = nextIndex;
            nextIndex += 1;
            const value = values[index];
            if (value !== undefined)
                results[index] = await mapper(value);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => worker()));
    return results;
}
function hasCode(error, code) {
    return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code;
}
//# sourceMappingURL=session-history-location.js.map