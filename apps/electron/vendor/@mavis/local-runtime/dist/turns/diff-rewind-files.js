import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../common/logger.js';
export class LocalTurnDiffRewindPreflightError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'LocalTurnDiffRewindPreflightError';
    }
}
export async function applyFileIfSafe(file) {
    let current;
    try {
        current = await snapshotFile(file);
    }
    catch (error) {
        return skippedFile('workspace-read-failed', error);
    }
    const conflict = workspaceConflictReason(current, file.expected);
    if (conflict)
        return { status: 'skipped', reason: conflict };
    try {
        await writeTarget(file);
        return { status: 'applied', turnIds: file.turnIds ?? [] };
    }
    catch (error) {
        return skippedFile('workspace-write-failed', error);
    }
}
export async function fileMatches(file) {
    try {
        return sameSnapshot(await snapshotFile(file), file.expected);
    }
    catch {
        return false;
    }
}
export function logSkippedFile(input, file, result) {
    logFileSkip({
        operationId: input.operationId,
        sessionId: input.sessionId,
        file: file.file,
        turnIds: file.turnIds ?? [],
        reason: result.reason,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    });
}
export function logFileSkip(fields) {
    try {
        logger.warn(fields, 'Turn diff rewind file skipped');
    }
    catch {
        // Engineering logging is best-effort and cannot affect Rewind.
    }
}
export function planKey(plan) {
    return `${path.resolve(plan.workspaceDir)}\0${plan.file}`;
}
export function requireSafeRelativePath(file) {
    const portable = file.replaceAll('\\', '/');
    const segments = portable.split('/');
    if (!portable ||
        portable.includes('\0') ||
        path.isAbsolute(file) ||
        path.win32.isAbsolute(file) ||
        segments.some((segment) => !segment || segment === '.' || segment === '..')) {
        preflightError('unsafe-path', `Unsafe Turn diff path: ${file}`);
    }
    return segments.join('/');
}
export function assertSnapshotComplete(snapshot, file, requireContent) {
    if (snapshot.file !== file || snapshot.binary || snapshot.oversized) {
        preflightError('snapshot-incomplete', `Turn diff snapshot is incomplete: ${file}`);
    }
    if (snapshot.exists &&
        snapshot.content === undefined &&
        (requireContent || snapshot.hash === undefined)) {
        preflightError('snapshot-incomplete', `Turn diff snapshot content is missing: ${file}`);
    }
}
export function sameSnapshot(left, right) {
    if (left.exists !== right.exists)
        return false;
    if (!left.exists)
        return true;
    return snapshotDigest(left) === snapshotDigest(right);
}
function workspaceConflictReason(current, expected) {
    if (current.exists !== expected.exists) {
        return current.exists ? 'workspace-file-unexpected' : 'workspace-file-missing';
    }
    if (!current.exists)
        return undefined;
    return snapshotDigest(current) === snapshotDigest(expected)
        ? undefined
        : 'workspace-content-changed';
}
function skippedFile(reason, error) {
    const errorCode = readErrorCode(error);
    return { status: 'skipped', reason, ...(errorCode ? { errorCode } : {}) };
}
async function writeTarget(file) {
    const target = resolvePlanPath(file);
    if (!file.target.exists) {
        await rm(target, { force: true });
        return;
    }
    if (file.target.content === undefined) {
        preflightError('snapshot-incomplete', `Turn diff target content is missing: ${file.file}`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.target.content, 'utf8');
}
async function snapshotFile(plan) {
    const target = resolvePlanPath(plan);
    try {
        const content = await readFile(target);
        return {
            file: plan.file,
            exists: true,
            hash: createHash('sha256').update(content).digest('hex'),
            sizeBytes: content.byteLength,
            content: content.toString('utf8'),
        };
    }
    catch (error) {
        if (isMissing(error))
            return { file: plan.file, exists: false };
        throw error;
    }
}
function resolvePlanPath(plan) {
    const file = requireSafeRelativePath(plan.file);
    const root = path.resolve(plan.workspaceDir);
    const absolute = path.resolve(root, file);
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (!absolute.startsWith(prefix))
        preflightError('unsafe-path', `Unsafe Turn diff path: ${file}`);
    return absolute;
}
function snapshotDigest(snapshot) {
    return (snapshot.hash ??
        (snapshot.content === undefined
            ? undefined
            : createHash('sha256').update(snapshot.content).digest('hex')));
}
function preflightError(code, message) {
    throw new LocalTurnDiffRewindPreflightError(code, message);
}
function isMissing(error) {
    return isRecord(error) && error.code === 'ENOENT';
}
function readErrorCode(error) {
    const code = isRecord(error) ? error.code : undefined;
    return typeof code === 'string' ? code : undefined;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
//# sourceMappingURL=diff-rewind-files.js.map