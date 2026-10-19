import { copyFile, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { KeyedOperationLane } from '@mavis/shared/keyed-operation-lane';
import { createSessionHistoryLocationResolver, } from '../../messages/history/session-history-location.js';
const PLAN_ARTIFACT_DIRECTORY = 'artifacts';
const PLAN_DOCUMENT_NAME = 'plan.md';
const PLAN_BACKUP_NAME = '.plan.md.plan-entry-backup';
export class PlanDocumentError extends Error {
    reason;
    constructor(reason, message, options) {
        super(message, options);
        this.reason = reason;
        this.name = 'PlanDocumentError';
    }
}
export function createPlanDocumentOwner(options) {
    if (!isAbsolute(options.dataDir)) {
        throw new PlanDocumentError('unsafe-path', 'Plan document dataDir must be absolute');
    }
    const locations = options.locations ??
        createSessionHistoryLocationResolver({ dataDir: options.dataDir, sessions: options.sessions });
    let preparationLanes = new KeyedOperationLane();
    const resolveAndEnsure = async (sessionId) => {
        const session = await options.sessions.get(sessionId);
        if (!session) {
            throw new PlanDocumentError('session-not-found', `Session not found: ${sessionId}`);
        }
        const paths = await locations.ensure(session);
        const artifactsDir = join(paths.sessionDir, PLAN_ARTIFACT_DIRECTORY);
        const canonicalPath = join(artifactsDir, PLAN_DOCUMENT_NAME);
        const backupPath = join(artifactsDir, PLAN_BACKUP_NAME);
        await ensureSafeArtifactPaths(paths.sessionDir, artifactsDir, canonicalPath, backupPath);
        return { canonicalPath };
    };
    const prepareNewDraft = async (sessionId) => {
        const release = await preparationLanes.acquire(sessionId);
        try {
            const { canonicalPath } = await resolveAndEnsure(sessionId);
            const backupPath = join(dirname(canonicalPath), PLAN_BACKUP_NAME);
            if (await pathExists(backupPath)) {
                throw new PlanDocumentError('preparation-conflict', `Unreconciled Plan draft backup exists for ${sessionId}`);
            }
            const replacedExistingDraft = await pathExists(canonicalPath);
            if (replacedExistingDraft)
                await rename(canonicalPath, backupPath);
            let state = 'open';
            let inFlight;
            let restoreFailure;
            const settle = async (action) => {
                if (state === 'committed' || state === 'restored')
                    return Promise.resolve();
                if (state === 'restore-failed')
                    return restoreFailure ?? Promise.reject(new Error('restore failed'));
                if (inFlight) {
                    if (inFlight.action === action)
                        return inFlight.promise;
                    try {
                        await inFlight.promise;
                    }
                    catch {
                        // A failed commit deliberately falls through to the compensating restore.
                    }
                    return settle(action);
                }
                const promise = (async () => {
                    try {
                        if (action === 'commit') {
                            await rm(backupPath, { force: true });
                            state = 'committed';
                        }
                        else if (replacedExistingDraft) {
                            await rm(canonicalPath, { force: true });
                            await rename(backupPath, canonicalPath);
                            state = 'restored';
                        }
                        else {
                            await rm(canonicalPath, { force: true });
                            state = 'restored';
                        }
                    }
                    catch (error) {
                        if (action === 'restore')
                            state = 'restore-failed';
                        throw error;
                    }
                    finally {
                        inFlight = undefined;
                        if (action === 'restore' || state === 'committed')
                            release();
                    }
                })();
                inFlight = { action, promise };
                if (action === 'restore')
                    restoreFailure = promise;
                return promise;
            };
            return {
                canonicalPath,
                replacedExistingDraft,
                commit: () => settle('commit'),
                restore: () => settle('restore'),
            };
        }
        catch (error) {
            release();
            throw error;
        }
    };
    const readFrozenSnapshot = async (sessionId, maxBytes) => {
        if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
            throw new PlanDocumentError('invalid-limit', 'Plan snapshot maxBytes must be positive');
        }
        const { canonicalPath } = await resolveAndEnsure(sessionId);
        let handle;
        try {
            handle = await open(canonicalPath, 'r');
        }
        catch (error) {
            if (isFsError(error, 'ENOENT')) {
                throw new PlanDocumentError('not-found', `Plan document not found: ${canonicalPath}`);
            }
            throw error;
        }
        try {
            const info = await handle.stat();
            if (!info.isFile()) {
                throw new PlanDocumentError('unsafe-path', `Plan document is not a regular file`);
            }
            const readSize = Math.min(info.size, maxBytes + 4);
            const buffer = Buffer.alloc(readSize);
            const { bytesRead } = await handle.read(buffer, 0, readSize, 0);
            const limited = buffer.subarray(0, Math.min(bytesRead, maxBytes));
            const markdown = decodeUtf8Prefix(limited);
            if (!markdown.trim()) {
                throw new PlanDocumentError('empty', `Plan document is empty: ${canonicalPath}`);
            }
            return {
                canonicalPath,
                markdown,
                truncated: info.size > maxBytes,
                sourceBytes: info.size,
            };
        }
        finally {
            await handle.close();
        }
    };
    const reconcilePreparedDrafts = async () => {
        // Startup reconciliation belongs to the new runtime graph and must not
        // inherit unsettled in-memory handles from a previous graph/test owner.
        preparationLanes = new KeyedOperationLane();
        const { candidates, failures } = await preparedDraftCandidates(locations, await options.sessions.listHistoryIdentities());
        for (const { sessionId } of candidates) {
            try {
                const mode = await options.modes.get(sessionId);
                if (mode === undefined)
                    continue;
                const { canonicalPath } = await resolveAndEnsure(sessionId);
                const backupPath = join(dirname(canonicalPath), PLAN_BACKUP_NAME);
                if (!(await pathExists(backupPath)))
                    continue;
                if (mode === 'plan') {
                    await rm(backupPath, { force: true });
                }
                else {
                    await rm(canonicalPath, { force: true });
                    await rename(backupPath, canonicalPath);
                }
            }
            catch (error) {
                failures.push(error);
            }
        }
        if (failures.length > 0) {
            throw new AggregateError(failures, 'One or more Plan draft backups could not be reconciled');
        }
    };
    const copyForFork = async (input) => {
        const [source, target] = await Promise.all([
            resolveAndEnsure(input.sourceSessionId),
            resolveAndEnsure(input.targetSessionId),
        ]);
        try {
            await copyFile(source.canonicalPath, target.canonicalPath);
            return { canonicalPath: target.canonicalPath, copied: true };
        }
        catch (error) {
            if (isFsError(error, 'ENOENT')) {
                return { canonicalPath: target.canonicalPath, copied: false };
            }
            throw error;
        }
    };
    return {
        resolveAndEnsure,
        prepareNewDraft,
        readFrozenSnapshot,
        copyForFork,
        reconcilePreparedDrafts,
    };
}
async function preparedDraftCandidates(locations, identities) {
    const matches = new Array(identities.length);
    const failures = [];
    let nextIndex = 0;
    const workerCount = Math.min(16, identities.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
        for (;;) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= identities.length)
                return;
            const identity = identities[index];
            if (!identity)
                continue;
            try {
                const paths = await locations.inspect(identity);
                const backupPath = join(paths.sessionDir, PLAN_ARTIFACT_DIRECTORY, PLAN_BACKUP_NAME);
                if (await pathExists(backupPath))
                    matches[index] = identity;
            }
            catch (error) {
                failures.push(error);
            }
        }
    }));
    return { candidates: matches.filter((value) => value !== undefined), failures };
}
async function ensureSafeArtifactPaths(sessionDir, artifactsDir, canonicalPath, backupPath) {
    const sessionInfo = await lstat(sessionDir);
    if (!sessionInfo.isDirectory() || sessionInfo.isSymbolicLink()) {
        throw new PlanDocumentError('unsafe-path', `Unsafe Session history directory: ${sessionDir}`);
    }
    try {
        await mkdir(artifactsDir, { recursive: false, mode: 0o700 });
    }
    catch (error) {
        if (!isFsError(error, 'EEXIST'))
            throw error;
    }
    const artifactInfo = await lstat(artifactsDir);
    if (!artifactInfo.isDirectory() || artifactInfo.isSymbolicLink()) {
        throw new PlanDocumentError('unsafe-path', `Unsafe Plan artifact directory: ${artifactsDir}`);
    }
    const realSessionDir = await realpath(sessionDir);
    const realArtifactsDir = await realpath(artifactsDir);
    if (realArtifactsDir !== join(realSessionDir, PLAN_ARTIFACT_DIRECTORY)) {
        throw new PlanDocumentError('unsafe-path', `Plan artifact directory escaped Session history`);
    }
    assertDirectChild(artifactsDir, canonicalPath);
    assertDirectChild(artifactsDir, backupPath);
    await assertSafeOptionalFile(canonicalPath, realArtifactsDir);
    await assertSafeOptionalFile(backupPath, realArtifactsDir);
}
async function assertSafeOptionalFile(path, realParent) {
    try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) {
            throw new PlanDocumentError('unsafe-path', `Unsafe Plan artifact target: ${path}`);
        }
        const resolved = await realpath(path);
        if (resolved !== join(realParent, basename(path))) {
            throw new PlanDocumentError('unsafe-path', `Plan artifact target escaped canonical path`);
        }
    }
    catch (error) {
        if (isFsError(error, 'ENOENT'))
            return;
        throw error;
    }
}
function assertDirectChild(parent, target) {
    const child = relative(parent, target);
    if (!child ||
        child.startsWith('..') ||
        isAbsolute(child) ||
        child.includes('/') ||
        child.includes('\\')) {
        throw new PlanDocumentError('unsafe-path', `Unsafe Plan artifact target: ${target}`);
    }
}
function decodeUtf8Prefix(buffer) {
    for (let length = buffer.length; length >= Math.max(0, buffer.length - 3); length -= 1) {
        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
        }
        catch {
            // A truncated code point can occupy at most four UTF-8 bytes.
        }
    }
    throw new PlanDocumentError('invalid-utf8', 'Plan document is not valid UTF-8');
}
async function pathExists(path) {
    try {
        await lstat(path);
        return true;
    }
    catch (error) {
        if (isFsError(error, 'ENOENT'))
            return false;
        throw error;
    }
}
function isFsError(error, code) {
    return (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        Reflect.get(error, 'code') === code);
}
//# sourceMappingURL=plan-document.js.map