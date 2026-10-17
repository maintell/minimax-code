import { createHash, randomUUID } from 'node:crypto';
import { access, copyFile, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { SessionHandoffError } from '../errors.js';
export function createResultWorkspacePort(options) {
    const activeOwnedPaths = new Set();
    const trackPrepared = (prepared) => {
        if (prepared.transferPath)
            activeOwnedPaths.add(prepared.transferPath);
        if (prepared.kind === 'snapshot' && !prepared.published) {
            activeOwnedPaths.add(prepared.workingPath);
        }
        return prepared;
    };
    const cleanupOrphans = (retained = []) => {
        retained.forEach(trackPrepared);
        return cleanupOrphanResultPaths(options.dataDir, activeOwnedPaths);
    };
    return {
        cleanupOrphans,
        prepare: async (record, resultId, attemptId, selection) => {
            await cleanupOrphans();
            return prepareResultWorkspace({
                options,
                record,
                resultId,
                attemptId,
                selection,
                activeOwnedPaths,
                trackPrepared,
            });
        },
        resume: async (input) => {
            if (input.published)
                return input;
            const transferRoot = join(options.dataDir, 'v2', 'session-handoff', 'result-transfers');
            if (!input.transferPath || !pathWithin(transferRoot, input.transferPath)) {
                throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Persisted Result transfer path is outside its owned root');
            }
            await ensureSafeRoot(input.transferPath);
            if (input.kind === 'worktree') {
                if (!input.ownershipToken || !options.worktree.probe) {
                    throw new SessionHandoffError('HANDOFF_UNAVAILABLE', 'Persisted Result worktree ownership cannot be verified');
                }
                const proven = await options.worktree.probe({
                    operationId: input.operationId,
                    workspaceDir: input.workspacePath,
                    ownershipToken: input.ownershipToken,
                    ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}),
                });
                if (resolve(proven.workspaceDir) !== resolve(input.workspacePath)) {
                    throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Persisted Result worktree identity changed');
                }
            }
            else if (await resumeSnapshotResult(options.dataDir, input)) {
                activeOwnedPaths.delete(input.workingPath);
                return trackPrepared({ ...input, published: true });
            }
            return trackPrepared(input);
        },
        applyDownloaded: async (input) => {
            if (input.published)
                return;
            for (const change of input.changes) {
                await applyDownloadedChange(input.workingPath, input.transferPath, change);
            }
            if (input.kind === 'snapshot') {
                await mkdir(resultWorkspaceRoot(options.dataDir), {
                    recursive: true,
                    mode: 0o700,
                });
                await rename(input.workingPath, input.workspacePath);
                activeOwnedPaths.delete(input.workingPath);
            }
        },
        discard: async (input) => {
            const failures = [];
            try {
                await removeOwnedPath(input.transferPath);
            }
            catch (error) {
                failures.push(error);
            }
            finally {
                activeOwnedPaths.delete(input.transferPath);
            }
            if (!input.published) {
                if (input.kind === 'worktree') {
                    try {
                        await options.worktree.cleanup({
                            operationId: input.operationId,
                            workspaceDir: input.workspacePath,
                            ...(input.ownershipToken ? { ownershipToken: input.ownershipToken } : {}),
                        });
                    }
                    catch (error) {
                        failures.push(error);
                    }
                }
                else {
                    try {
                        await removeOwnedPath(input.workingPath);
                    }
                    catch (error) {
                        failures.push(error);
                    }
                    finally {
                        activeOwnedPaths.delete(input.workingPath);
                    }
                }
            }
            if (failures.length > 0) {
                throw new AggregateError(failures, 'Result Workspace cleanup failed');
            }
        },
    };
}
async function resumeSnapshotResult(dataDir, input) {
    const stagingRoot = join(dataDir, 'v2', 'session-handoff', 'result-staging');
    if (!pathWithin(stagingRoot, input.workingPath)) {
        throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Persisted Result staging path is outside its owned root');
    }
    if (!pathWithin(resultWorkspaceRoot(dataDir), input.workspacePath)) {
        throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Persisted Result Workspace path is outside its owned root');
    }
    if (!(await pathExists(input.workingPath)) && (await pathExists(input.workspacePath))) {
        await ensureSafeRoot(input.workspacePath);
        return true;
    }
    await ensureSafeRoot(input.workingPath);
    return false;
}
async function prepareResultWorkspace(input) {
    const source = requireResultSource(await input.options.sessions.get(input.record.localSessionId), input.record);
    const cloudSessionId = requireCloudSessionId(input.record);
    const resultScope = `${cloudSessionId}\0${input.resultId}\0${input.selection}`;
    const operationId = `session-result:${resultSegment(resultScope)}`;
    const transferPath = await prepareTransferPath(input.options.dataDir, resultScope, input.attemptId);
    input.activeOwnedPaths.add(transferPath);
    try {
        return await prepareResultTarget(input.options, input.record, source, {
            resultScope,
            operationId,
            attemptId: input.attemptId,
            transferPath,
            activeOwnedPaths: input.activeOwnedPaths,
            trackPrepared: input.trackPrepared,
        });
    }
    catch (error) {
        try {
            await removeOwnedPath(transferPath);
        }
        catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Result Workspace preparation and transfer cleanup failed');
        }
        finally {
            input.activeOwnedPaths.delete(transferPath);
        }
        throw error;
    }
}
function requireResultSource(source, record) {
    if (!source || source.workspaceDir !== record.workspaceDir) {
        throw new SessionHandoffError('HANDOFF_RECORD_NOT_FOUND', 'Source Local Session Workspace is unavailable');
    }
    return source;
}
function requireCloudSessionId(record) {
    if (!record.cloudSessionId) {
        throw new SessionHandoffError('HANDOFF_RECORD_NOT_FOUND', 'Committed Local Session handoff has no Cloud Session identity');
    }
    return record.cloudSessionId;
}
async function prepareResultTarget(options, record, source, input) {
    if (await options.worktree.isEligible(source)) {
        const prepared = await options.worktree.prepare({
            operationId: input.operationId,
            source,
            allowTargetMutation: true,
        });
        return input.trackPrepared({
            workspacePath: prepared.workspaceDir,
            workingPath: prepared.workspaceDir,
            transferPath: input.transferPath,
            operationId: input.operationId,
            kind: 'worktree',
            ...(prepared.ownershipToken ? { ownershipToken: prepared.ownershipToken } : {}),
            ...(prepared.fingerprint ? { fingerprint: prepared.fingerprint } : {}),
        });
    }
    const snapshot = await prepareSnapshotWorkspace(options, record, input);
    if (snapshot.published) {
        await removeOwnedPath(input.transferPath);
        input.activeOwnedPaths.delete(input.transferPath);
    }
    return input.trackPrepared({
        ...snapshot,
        transferPath: snapshot.published ? '' : input.transferPath,
        operationId: input.operationId,
        kind: 'snapshot',
    });
}
async function cleanupOrphanResultPaths(dataDir, activeOwnedPaths) {
    const roots = [
        join(dataDir, 'v2', 'session-handoff', 'result-staging'),
        join(dataDir, 'v2', 'session-handoff', 'result-transfers'),
    ];
    for (const root of roots) {
        let entries;
        try {
            entries = await readdir(root, { withFileTypes: true });
        }
        catch (error) {
            if (isErrorCode(error, 'ENOENT'))
                continue;
            throw error;
        }
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            const candidate = join(root, entry.name);
            if (activeOwnedPaths.has(candidate))
                continue;
            await rm(candidate, { recursive: true, force: true });
        }
    }
}
async function prepareSnapshotWorkspace(options, record, input) {
    const workspacePath = join(resultWorkspaceRoot(options.dataDir), resultSegment(input.resultScope));
    if (await pathExists(workspacePath)) {
        return { workspacePath, workingPath: workspacePath, published: true };
    }
    const scan = await options.workspace.scan(record.workspaceDir);
    const stage = options.workspace.stage;
    if (!stage) {
        throw new SessionHandoffError('HANDOFF_UNAVAILABLE', 'Workspace staging is unavailable');
    }
    const workingRoot = join(options.dataDir, 'v2', 'session-handoff', 'result-staging');
    const workingPath = join(workingRoot, resultSegment(`${input.resultScope}\0${input.attemptId}`));
    await removeOwnedPath(workingPath);
    const selectedPaths = scan.files.map((file) => file.relativePath);
    const staged = await stage({
        workspaceDir: record.workspaceDir,
        revisionId: scan.revisionId,
        selectedPaths,
        operationId: `${input.operationId}:${input.attemptId}`,
        files: scan.files,
    });
    input.activeOwnedPaths.add(workingPath);
    let renamed = false;
    try {
        await mkdir(workingRoot, { recursive: true, mode: 0o700 });
        await rename(staged.stagingDir, workingPath);
        renamed = true;
        await options.workspace.cleanupStaging?.(staged.stagingDir);
        return { workspacePath, workingPath };
    }
    catch (error) {
        const failures = [error];
        if (!renamed) {
            try {
                await options.workspace.cleanupStaging?.(staged.stagingDir);
            }
            catch (cleanupError) {
                failures.push(cleanupError);
            }
        }
        try {
            await removeOwnedPath(workingPath);
        }
        catch (cleanupError) {
            failures.push(cleanupError);
        }
        finally {
            input.activeOwnedPaths.delete(workingPath);
        }
        if (failures.length > 1) {
            throw new AggregateError(failures, 'Result Workspace snapshot preparation failed');
        }
        throw error;
    }
}
async function prepareTransferPath(dataDir, resultScope, attemptId) {
    const root = join(dataDir, 'v2', 'session-handoff', 'result-transfers');
    const target = join(root, resultSegment(`${resultScope}\0${attemptId}`));
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true, mode: 0o700 });
    return target;
}
async function removeOwnedPath(path) {
    if (!path)
        return;
    await rm(path, { recursive: true, force: true });
}
async function applyDownloadedChange(workspacePath, transferPath, change) {
    await ensureSafeParent(workspacePath, change.relativePath, change.kind !== 'delete');
    const target = safeChild(workspacePath, change.relativePath);
    if (change.kind === 'delete') {
        await rm(target, { recursive: true, force: true });
        return;
    }
    const source = safeChild(transferPath, change.relativePath);
    await ensureSafeParent(transferPath, change.relativePath, false);
    const metadata = await lstat(source);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new SessionHandoffError('HANDOFF_ARTIFACT_INVALID', 'Downloaded Result Workspace entry is not a regular file');
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
        await copyFile(source, temporary);
        await rename(temporary, target);
    }
    finally {
        await rm(temporary, { force: true });
    }
}
function safeChild(root, relativePath) {
    const normalized = relativePath.replaceAll('\\', '/');
    const segments = normalized.split('/');
    if (!relativePath ||
        isAbsolute(relativePath) ||
        segments.some((segment) => ['.git', '.mavis'].includes(segment.toLowerCase()))) {
        throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Result path is unsafe');
    }
    const target = resolve(root, relativePath);
    const rel = relative(resolve(root), target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Result path escaped its root');
    }
    return target;
}
async function ensureSafeParent(root, relativePath, createMissing) {
    const rootPath = resolve(root);
    const rootMetadata = await lstat(rootPath);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
        throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Result Workspace root is unsafe');
    }
    const segments = relativePath.split(/[\\/]+/u).slice(0, -1);
    let current = rootPath;
    for (const segment of segments) {
        current = join(current, segment);
        const metadata = await directoryMetadata(current, createMissing);
        if (!metadata)
            return;
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
            throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Result path traversed a symbolic link or non-directory');
        }
    }
}
async function ensureSafeRoot(root) {
    const metadata = await lstat(resolve(root));
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Persisted Result Workspace root is unsafe');
    }
}
function pathWithin(root, candidate) {
    const scope = relative(resolve(root), resolve(candidate));
    return scope !== '' && scope !== '..' && !scope.startsWith(`..${sep}`) && !isAbsolute(scope);
}
async function directoryMetadata(path, createMissing) {
    try {
        return await lstat(path);
    }
    catch (error) {
        if (!isErrorCode(error, 'ENOENT'))
            throw error;
        if (!createMissing)
            return undefined;
        await createDirectory(path);
        return lstat(path);
    }
}
async function createDirectory(path) {
    try {
        await mkdir(path, { mode: 0o700 });
    }
    catch (error) {
        if (!isErrorCode(error, 'EEXIST'))
            throw error;
    }
}
function resultWorkspaceRoot(dataDir) {
    return join(dataDir, 'v2', 'session-handoff', 'results');
}
function resultSegment(resultId) {
    return createHash('sha256').update(resultId).digest('hex').slice(0, 24);
}
async function pathExists(path) {
    try {
        await access(path);
        return true;
    }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
            return false;
        throw error;
    }
}
function isErrorCode(error, code) {
    return error instanceof Error && 'code' in error && error.code === code;
}
//# sourceMappingURL=result-workspace.js.map