import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, writeFile, } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import JSZip from 'jszip';
import { SessionHandoffError } from '../errors.js';
import { safeRelativePath } from '../admission/recommendation.js';
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_DOWNLOAD_COLLISIONS = 10_000;
export function createResultDeliveryPort(options) {
    const journalRoot = join(options.dataDir ?? options.downloadsDir, 'v2', 'session-handoff', 'overwrite-journals');
    return {
        recoverPending: () => recoverPendingJournals(journalRoot),
        download: (input) => downloadResult(options.downloadsDir, input),
        overwrite: (input) => overwriteResult(journalRoot, input),
    };
}
async function downloadResult(downloadsDir, input) {
    const files = normalizedChanges(input.changes).filter((change) => change.kind !== 'delete');
    if (files.length === 0) {
        throw new SessionHandoffError('RESULT_DOWNLOAD_EMPTY', 'Result has no downloadable files');
    }
    const sourceRoot = await realDirectory(input.sourceWorkspacePath);
    await mkdir(downloadsDir, { recursive: true, mode: DIRECTORY_MODE });
    if (files.length === 1) {
        const file = files[0];
        if (!file)
            throw new SessionHandoffError('RESULT_DOWNLOAD_EMPTY', 'Result has no file');
        const source = await regularSourceFile(sourceRoot, file.relativePath);
        const target = await writeUniqueDownload(downloadsDir, portableDownloadName(basename(file.relativePath)), await readFile(source));
        return { downloadPath: target, archive: false };
    }
    const archive = new JSZip();
    for (const change of files) {
        const source = await regularSourceFile(sourceRoot, change.relativePath);
        archive.file(change.relativePath, await readFile(source));
    }
    const archiveName = portableDownloadName(`session-result-${safeIdentifier(input.resultId)}.zip`);
    const body = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const target = await writeUniqueDownload(downloadsDir, archiveName, body);
    return { downloadPath: target, archive: true };
}
async function overwriteResult(journalRoot, input) {
    const sourceRoot = await realDirectory(input.sourceWorkspacePath);
    const targetRoot = await realDirectory(input.targetWorkspacePath);
    const operationToken = createHash('sha256').update(input.operationId).digest('hex').slice(0, 20);
    const journal = await buildOverwriteJournal(sourceRoot, targetRoot, operationToken, normalizedChanges(input.changes));
    const journalPath = join(journalRoot, `${operationToken}.json`);
    await mkdir(journalRoot, { recursive: true, mode: DIRECTORY_MODE });
    await writeJournal(journalPath, journal);
    try {
        await applyOverwriteJournal(journalPath, journal);
        return input.targetWorkspacePath;
    }
    catch (error) {
        if (journal.state !== 'committed')
            await rollbackJournal(journalPath, journal);
        throw error;
    }
}
async function buildOverwriteJournal(sourceRoot, targetRoot, operationToken, changes) {
    const createdDirectories = new Set();
    const entries = [];
    for (const change of changes) {
        entries.push(await buildOverwriteJournalEntry({
            sourceRoot,
            targetRoot,
            operationToken,
            change,
            createdDirectories,
        }));
    }
    return {
        schema: 'mavis.session.result.overwrite.v2',
        targetWorkspacePath: targetRoot,
        createdDirectories: [...createdDirectories].sort((left, right) => left.length - right.length),
        entries,
        state: 'applying',
    };
}
async function buildOverwriteJournalEntry(input) {
    const targetPath = workspacePath(input.targetRoot, input.change.relativePath);
    await assertSafeParentChain(input.targetRoot, dirname(targetPath), input.createdDirectories);
    const targetMetadata = await optionalLstat(targetPath);
    if (targetMetadata?.isSymbolicLink() || (targetMetadata && !targetMetadata.isFile())) {
        throw new SessionHandoffError('HANDOFF_ARTIFACT_INVALID', `Result target is not a regular file: ${input.change.relativePath}`);
    }
    const sourcePath = input.change.kind === 'delete'
        ? undefined
        : await regularSourceFile(input.sourceRoot, input.change.relativePath);
    const name = portableDownloadName(basename(input.change.relativePath));
    const pathToken = createHash('sha256')
        .update(input.change.relativePath)
        .digest('hex')
        .slice(0, 16);
    return {
        kind: input.change.kind,
        targetPath,
        ...(sourcePath ? { sourcePath } : {}),
        backupPath: join(dirname(targetPath), `.${name}.${pathToken}.mavis-backup-${input.operationToken}`),
        temporaryPath: join(dirname(targetPath), `.${name}.${pathToken}.mavis-new-${input.operationToken}`),
        hadTarget: targetMetadata !== undefined,
        applied: false,
    };
}
async function applyOverwriteJournal(path, journal) {
    for (const directory of journal.createdDirectories) {
        await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    }
    for (const entry of journal.entries) {
        await applyOverwriteJournalEntry(path, journal, entry);
    }
    journal.state = 'committed';
    await writeJournal(path, journal);
    await cleanupCommittedJournal(path, journal);
}
async function applyOverwriteJournalEntry(path, journal, entry) {
    await rm(entry.backupPath, { force: true });
    await rm(entry.temporaryPath, { force: true });
    if (entry.sourcePath)
        await copyFile(entry.sourcePath, entry.temporaryPath);
    if (entry.hadTarget)
        await rename(entry.targetPath, entry.backupPath);
    if (entry.sourcePath)
        await rename(entry.temporaryPath, entry.targetPath);
    entry.applied = true;
    await writeJournal(path, journal);
}
async function recoverPendingJournals(journalRoot) {
    let names;
    try {
        names = await readdir(journalRoot);
    }
    catch (error) {
        if (isErrorCode(error, 'ENOENT'))
            return;
        throw error;
    }
    for (const name of names) {
        if (!name.endsWith('.json'))
            continue;
        const path = join(journalRoot, name);
        const value = await validateOverwriteJournal(JSON.parse(await readFile(path, 'utf8')));
        if (value.state === 'committed') {
            await cleanupCommittedJournal(path, value);
        }
        else {
            await rollbackJournal(path, value);
        }
    }
}
async function validateOverwriteJournal(value) {
    const journal = requireOverwriteJournalShape(value);
    const targetRoot = await realDirectory(journal.targetWorkspacePath);
    for (const directory of journal.createdDirectories) {
        await validateJournalDirectory(targetRoot, directory);
    }
    for (const entry of journal.entries) {
        requireOverwriteJournalEntryShape(entry);
        await validateJournalEntryPaths(targetRoot, entry);
    }
    return journal;
}
function requireOverwriteJournalShape(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw invalidOverwriteJournal();
    }
    const journal = value;
    if (journal.schema !== 'mavis.session.result.overwrite.v2' ||
        typeof journal.targetWorkspacePath !== 'string' ||
        !Array.isArray(journal.createdDirectories) ||
        !Array.isArray(journal.entries) ||
        !['applying', 'committed'].includes(journal.state ?? '')) {
        throw invalidOverwriteJournal();
    }
    return journal;
}
async function validateJournalDirectory(targetRoot, directory) {
    if (typeof directory !== 'string' ||
        !pathWithin(targetRoot, await canonicalJournalPath(directory))) {
        throw invalidOverwriteJournal();
    }
}
function requireOverwriteJournalEntryShape(value) {
    const entry = value;
    if (typeof entry !== 'object' ||
        entry === null ||
        !['add', 'modify', 'delete'].includes(entry.kind ?? '') ||
        typeof entry.targetPath !== 'string' ||
        typeof entry.backupPath !== 'string' ||
        typeof entry.temporaryPath !== 'string' ||
        typeof entry.hadTarget !== 'boolean' ||
        typeof entry.applied !== 'boolean') {
        throw invalidOverwriteJournal();
    }
}
async function validateJournalEntryPaths(targetRoot, entry) {
    const targetPath = await canonicalJournalPath(entry.targetPath);
    const backupPath = await canonicalJournalPath(entry.backupPath);
    const temporaryPath = await canonicalJournalPath(entry.temporaryPath);
    if (!pathWithin(targetRoot, targetPath) ||
        !pathWithin(targetRoot, backupPath) ||
        !pathWithin(targetRoot, temporaryPath) ||
        dirname(backupPath) !== dirname(targetPath) ||
        dirname(temporaryPath) !== dirname(targetPath)) {
        throw invalidOverwriteJournal();
    }
}
function invalidOverwriteJournal() {
    return new Error('session_result_overwrite_journal_invalid');
}
function pathWithin(root, candidate) {
    const scope = relative(root, resolve(candidate));
    return scope !== '' && scope !== '..' && !scope.startsWith(`..${sep}`);
}
async function canonicalJournalPath(path, suffix = []) {
    const candidate = resolve(path);
    try {
        return join(await realpath(candidate), ...suffix);
    }
    catch (error) {
        if (!isErrorCode(error, 'ENOENT'))
            throw error;
        const parent = dirname(candidate);
        if (parent === candidate)
            throw error;
        return canonicalJournalPath(parent, [basename(candidate), ...suffix]);
    }
}
async function rollbackJournal(path, journal) {
    const failures = [];
    for (const entry of [...journal.entries].reverse()) {
        await captureRollbackFailure(failures, () => rollbackJournalEntry(entry));
    }
    for (const directory of [...journal.createdDirectories].sort((a, b) => b.length - a.length)) {
        await captureRollbackFailure(failures, () => removeCreatedDirectory(directory));
    }
    await captureRollbackFailure(failures, () => rm(path, { force: true }));
    if (failures.length > 0) {
        throw new AggregateError(failures, 'Result overwrite rollback failed');
    }
}
async function rollbackJournalEntry(entry) {
    const backupExists = (await optionalLstat(entry.backupPath)) !== undefined;
    const temporaryExists = (await optionalLstat(entry.temporaryPath)) !== undefined;
    if (entry.applied || backupExists || (!entry.hadTarget && !temporaryExists)) {
        await rm(entry.targetPath, { force: true });
    }
    if (backupExists)
        await rename(entry.backupPath, entry.targetPath);
    await rm(entry.temporaryPath, { force: true });
}
async function removeCreatedDirectory(directory) {
    try {
        await rmdir(directory);
    }
    catch (error) {
        if (!isErrorCode(error, 'ENOENT') && !isErrorCode(error, 'ENOTEMPTY'))
            throw error;
    }
}
async function captureRollbackFailure(failures, operation) {
    try {
        await operation();
    }
    catch (error) {
        failures.push(error);
    }
}
async function cleanupCommittedJournal(path, journal) {
    for (const entry of journal.entries) {
        await rm(entry.backupPath, { force: true });
        await rm(entry.temporaryPath, { force: true });
    }
    await rm(path, { force: true });
}
async function writeJournal(path, journal) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(journal), { mode: FILE_MODE });
    await rename(temporary, path);
}
function normalizedChanges(changes) {
    const unique = new Map();
    for (const change of changes) {
        const relativePath = change.relativePath.replaceAll('\\', '/');
        if (!safeRelativePath(relativePath)) {
            throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Result path is unsafe');
        }
        const existing = unique.get(relativePath);
        if (existing && existing.kind !== change.kind) {
            throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Result path has conflicting kinds');
        }
        unique.set(relativePath, { relativePath, kind: change.kind });
    }
    return [...unique.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
async function regularSourceFile(root, relativePath) {
    const path = workspacePath(root, relativePath);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new SessionHandoffError('HANDOFF_ARTIFACT_INVALID', `Result source is not a regular file: ${relativePath}`);
    }
    const physical = await realpath(path);
    if (!pathWithin(root, physical)) {
        throw new SessionHandoffError('HANDOFF_ARTIFACT_INVALID', 'Result source escaped Workspace');
    }
    return physical;
}
function workspacePath(root, relativePath) {
    if (!safeRelativePath(relativePath)) {
        throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Result path is unsafe');
    }
    const target = resolve(root, relativePath);
    const scope = relative(root, target);
    if (scope === '..' || scope.startsWith(`..${sep}`) || resolve(target) === resolve(root)) {
        throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Result path escaped Workspace');
    }
    return target;
}
async function assertSafeParentChain(root, parent, createdDirectories) {
    const scope = relative(root, parent);
    if (scope === '..' || scope.startsWith(`..${sep}`)) {
        throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Result parent escaped Workspace');
    }
    let current = root;
    for (const segment of scope.split(sep).filter(Boolean)) {
        current = join(current, segment);
        const metadata = await optionalLstat(current);
        if (!metadata) {
            createdDirectories.add(current);
            continue;
        }
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
            throw new SessionHandoffError('HANDOFF_ARTIFACT_INVALID', 'Result parent is not a directory');
        }
    }
}
async function writeUniqueDownload(directory, requestedName, body) {
    const extension = extname(requestedName);
    const stem = requestedName.slice(0, requestedName.length - extension.length) || 'result';
    for (let index = 0; index < MAX_DOWNLOAD_COLLISIONS; index += 1) {
        const name = index === 0 ? `${stem}${extension}` : `${stem} (${index})${extension}`;
        const candidate = join(directory, name);
        try {
            await writeFile(candidate, body, { flag: 'wx', mode: FILE_MODE });
            return candidate;
        }
        catch (error) {
            if (!isErrorCode(error, 'EEXIST'))
                throw error;
        }
    }
    throw new Error('result_download_name_exhausted');
}
function portableDownloadName(value) {
    const normalized = value.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').trim();
    return normalized === '' || normalized === '.' || normalized === '..' ? 'result' : normalized;
}
function safeIdentifier(value) {
    return value.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 96) || 'result';
}
async function realDirectory(path) {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new SessionHandoffError('HANDOFF_ARTIFACT_INVALID', 'Result Workspace is invalid');
    }
    return realpath(path);
}
async function optionalLstat(path) {
    try {
        return await lstat(path);
    }
    catch (error) {
        if (isErrorCode(error, 'ENOENT'))
            return undefined;
        throw error;
    }
}
function isErrorCode(error, code) {
    return error instanceof Error && 'code' in error && error.code === code;
}
//# sourceMappingURL=result-delivery.js.map