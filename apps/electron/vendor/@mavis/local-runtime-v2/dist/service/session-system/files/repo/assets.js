import { collectMessageAssetItems } from '@mavis/shared/asset-markup';
import { mkdir, copyFile, lstat, rm, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { and, asc, desc, eq, gt, inArray, lt, notExists, or } from 'drizzle-orm';
import { messageRows, newerSessionAssets, sessionAssetIndexState, sessionAssets, } from '../../../../infra/db/schema/messages.js';
import { decodeDisplayMessage } from '../../messages/repo/codec.js';
import { decodeAssetCursor, encodeAssetCursor } from './cursor.js';
import { markAssetIndexCurrent, reconcileForkDisplayAssets, removeForkDisplayAssets, } from './fork-copy-projection.js';
export function replaceMessageAssets(db, sessionId, message, nowMs) {
    db.delete(sessionAssets)
        .where(and(eq(sessionAssets.sessionId, sessionId), eq(sessionAssets.messageId, message.msgId)))
        .run();
    if (message.role !== 'assistant')
        return;
    const content = messageContent(message.dataJson);
    const wrapperKeys = new Set(collectMessageAssetItems(content, { includeStandaloneMedia: false }).map(assetKey));
    collectMessageAssetItems(content).forEach((asset, assetIndex) => {
        const key = assetKey(asset);
        if (!key)
            return;
        db.insert(sessionAssets)
            .values({
            sessionId,
            messageId: message.msgId,
            role: message.role,
            messageCreatedAtMs: message.createdAtMs,
            assetIndex,
            assetKey: key,
            sourceTag: wrapperKeys.has(key) ? 'deliver-assets' : 'media',
            path: asset.path,
            name: asset.name ?? null,
            assetType: asset.type ?? null,
            artifactId: asset.artifactId ?? null,
            driveNodeId: asset.driveNodeId ?? null,
            dataJson: JSON.stringify(asset),
            createdAtMs: nowMs,
            updatedAtMs: nowMs,
        })
            .run();
    });
}
export function createSessionAssetRepository(options) {
    return new DrizzleSessionAssetRepository(options);
}
class DrizzleSessionAssetRepository {
    options;
    constructor(options) {
        this.options = options;
    }
    async getIndexState(sessionId) {
        const row = this.options.db
            .select()
            .from(sessionAssetIndexState)
            .where(eq(sessionAssetIndexState.sessionId, sessionId))
            .get();
        return row ?? undefined;
    }
    async rebuild(sessionId, nowMs) {
        return this.options.db.transaction((tx) => {
            tx.delete(sessionAssets).where(eq(sessionAssets.sessionId, sessionId)).run();
            const rows = tx
                .select()
                .from(messageRows)
                .where(eq(messageRows.sessionId, sessionId))
                .orderBy(asc(messageRows.id))
                .all();
            for (const row of rows) {
                const message = normalizedFromRow(row);
                replaceMessageAssets(tx, sessionId, message, nowMs);
            }
            const state = {
                sessionId,
                indexVersion: 1,
                indexedThroughMessageRowId: rows.at(-1)?.id ?? 0,
                indexedAtMs: nowMs,
                status: 'ready',
                errorJson: null,
            };
            tx.insert(sessionAssetIndexState)
                .values(state)
                .onConflictDoUpdate({ target: sessionAssetIndexState.sessionId, set: state })
                .run();
            return state;
        });
    }
    async listPage(options) {
        const limit = normalizeLimit(options.limit);
        const cursor = decodeAssetCursor(options.cursor, options.sessionId);
        const all = this.options.db
            .select()
            .from(sessionAssets)
            .where(and(eq(sessionAssets.sessionId, options.sessionId), notExists(this.options.db
            .select({ id: newerSessionAssets.id })
            .from(newerSessionAssets)
            .where(and(eq(newerSessionAssets.sessionId, sessionAssets.sessionId), eq(newerSessionAssets.assetKey, sessionAssets.assetKey), or(gt(newerSessionAssets.messageCreatedAtMs, sessionAssets.messageCreatedAtMs), and(eq(newerSessionAssets.messageCreatedAtMs, sessionAssets.messageCreatedAtMs), gt(newerSessionAssets.id, sessionAssets.id)))))
            .limit(1)), cursor
            ? or(lt(sessionAssets.messageCreatedAtMs, cursor.messageCreatedAtMs), and(eq(sessionAssets.messageCreatedAtMs, cursor.messageCreatedAtMs), lt(sessionAssets.id, cursor.id)))
            : undefined))
            .orderBy(desc(sessionAssets.messageCreatedAtMs), desc(sessionAssets.id))
            .limit(limit + 1)
            .all();
        const hasMore = all.length > limit;
        const rows = all.slice(0, limit);
        const assets = rows.map(assetRecord);
        return {
            assets,
            hasMore,
            ...(hasMore && rows.at(-1)
                ? { nextCursor: encodeAssetCursor(rows.at(-1)) }
                : {}),
        };
    }
    async copyForMessagePrefix(input) {
        const targetRoot = input.mode === 'workspace-copy'
            ? await this.requireOwnedWorkspaceRoot(input.targetSessionId, input.targetWorkspaceDir)
            : undefined;
        const sourceRows = input.messageIds.flatMap((messageId) => this.options.db
            .select()
            .from(sessionAssets)
            .where(and(eq(sessionAssets.sessionId, input.sourceSessionId), eq(sessionAssets.messageId, messageId)))
            .all());
        const existingTargetOwnership = new Set(this.options.db
            .select()
            .from(sessionAssets)
            .where(eq(sessionAssets.sessionId, input.targetSessionId))
            .all()
            .map((row) => assetOwnershipKey(row.messageId, row.assetKey, row.path)));
        const copiedFiles = new Set();
        try {
            const values = [];
            const outcomes = [];
            for (const row of sourceRows) {
                const path = row.path;
                const copy = input.mode === 'records-only'
                    ? { path }
                    : await copyAssetPathBestEffort(row, {
                        sourceRoot: input.sourceWorkspaceDir,
                        targetRoot,
                    }, existingTargetOwnership);
                outcomes.push({
                    messageId: row.messageId,
                    assetKey: row.assetKey,
                    ...(copy ? { targetPath: copy.path } : {}),
                });
                if (!copy)
                    continue;
                if (copy.copiedPath)
                    copiedFiles.add(copy.copiedPath);
                values.push({
                    ...row,
                    id: undefined,
                    sessionId: input.targetSessionId,
                    path: copy.path,
                    dataJson: rewriteAssetPath(row.dataJson, path, copy.path),
                });
            }
            this.options.db.transaction((tx) => {
                if (input.messageIds.length > 0) {
                    tx.delete(sessionAssets)
                        .where(and(eq(sessionAssets.sessionId, input.targetSessionId), inArray(sessionAssets.messageId, [...input.messageIds])))
                        .run();
                }
                for (const value of values)
                    tx.insert(sessionAssets).values(value).onConflictDoNothing().run();
                reconcileForkDisplayAssets(tx, input.targetSessionId, outcomes);
                markAssetIndexCurrent(tx, input.targetSessionId, Date.now());
            }, { behavior: 'immediate' });
            return {
                mode: input.mode,
                ...(targetRoot ? { targetRoot } : {}),
                copiedPaths: [...copiedFiles],
            };
        }
        catch (error) {
            for (const file of copiedFiles)
                await removeFile(file);
            await this.deleteSession(input.targetSessionId);
            throw error;
        }
    }
    async probeCopy(input) {
        const expected = new Set(input.copiedPaths);
        if (expected.size !== input.copiedPaths.length)
            return false;
        const rows = this.options.db
            .select()
            .from(sessionAssets)
            .where(eq(sessionAssets.sessionId, input.sessionId))
            .all();
        if (input.mode === 'records-only') {
            return !input.targetRoot && expected.size === 0 && probeRecordOnlyAssetRows(rows);
        }
        const ownedRoot = await this.ownedAssetRoot(input.sessionId, input.targetRoot, input.mode);
        if (expected.size > 0 && !ownedRoot)
            return false;
        if (!pathsBelongToRoot(expected, ownedRoot))
            return false;
        return input.mode === 'workspace-copy'
            ? probeWorkspaceAssetRows(rows, expected, ownedRoot)
            : probeLegacyAssetRows(rows, expected);
    }
    async compensateCopy(input) {
        this.options.db.transaction((tx) => {
            removeForkDisplayAssets(tx, input.sessionId);
            tx.delete(sessionAssets).where(eq(sessionAssets.sessionId, input.sessionId)).run();
            markAssetIndexCurrent(tx, input.sessionId, Date.now());
        });
        if (input.mode === 'records-only')
            return;
        const ownedRoot = await this.ownedAssetRoot(input.sessionId, input.targetRoot, input.mode);
        const copiedPaths = new Set(input.copiedPaths ?? []);
        if (ownedRoot && pathsBelongToRoot(copiedPaths, ownedRoot)) {
            for (const path of copiedPaths)
                await removeFile(path);
            if (input.mode === undefined)
                await removeEmptyDirectory(ownedRoot);
        }
    }
    async deleteSession(sessionId) {
        this.options.db.transaction((tx) => {
            tx.delete(sessionAssets).where(eq(sessionAssets.sessionId, sessionId)).run();
            tx.delete(sessionAssetIndexState)
                .where(eq(sessionAssetIndexState.sessionId, sessionId))
                .run();
        });
    }
    async ownedAssetRoot(sessionId, claimedRoot, mode) {
        const expectedRoot = mode === 'workspace-copy'
            ? await this.options.resolveSessionWorkspaceRoot?.(sessionId)
            : this.options.resolveLegacySessionAssetRoot?.(sessionId);
        if (!expectedRoot)
            return undefined;
        if (claimedRoot && resolve(claimedRoot) !== resolve(expectedRoot))
            return undefined;
        return expectedRoot;
    }
    async requireOwnedWorkspaceRoot(sessionId, claimedRoot) {
        const expectedRoot = await this.options.resolveSessionWorkspaceRoot?.(sessionId);
        if (!expectedRoot || resolve(claimedRoot) !== resolve(expectedRoot)) {
            throw new Error('Fork asset target does not match the child Session workspace');
        }
        return expectedRoot;
    }
}
async function copyAssetPathBestEffort(row, roots, existingTargetOwnership) {
    try {
        return await copyAssetPath(row, roots, existingTargetOwnership);
    }
    catch {
        return undefined;
    }
}
async function copyAssetPath(row, roots, existingTargetOwnership) {
    const path = row.path.trim();
    if (!isLocalAssetPath(path))
        return { path };
    if (!roots.sourceRoot || !roots.targetRoot) {
        throw new Error('Session asset filesystem roots are unavailable');
    }
    const sourcePath = resolveContainedPath(roots.sourceRoot, path);
    const targetPath = resolveContainedPath(roots.targetRoot, relative(resolve(roots.sourceRoot), sourcePath));
    if (await isExistingRegularAsset(targetPath)) {
        return existingTargetOwnership.has(assetOwnershipKey(row.messageId, row.assetKey, targetPath))
            ? { path: targetPath, copiedPath: targetPath }
            : { path: targetPath };
    }
    try {
        await copyRegularAsset(sourcePath, targetPath);
    }
    catch (error) {
        await removeFile(targetPath);
        throw error;
    }
    return { path: targetPath, copiedPath: targetPath };
}
function pathsBelongToRoot(paths, targetRoot) {
    if (!targetRoot)
        return true;
    const root = resolve(targetRoot);
    return [...paths].every((path) => isContainedRelativePath(relative(root, resolve(path))));
}
function isContainedRelativePath(relativePath) {
    return !relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath);
}
function probeRecordOnlyAssetRows(rows) {
    return rows.every((row) => hasPersistedAssetPath(row.dataJson, row.path));
}
async function probeWorkspaceAssetRows(rows, expectedCopiedPaths, targetRoot) {
    if (!targetRoot)
        return rows.every((row) => !isLocalAssetPath(row.path));
    const projected = new Set();
    for (const row of rows) {
        if (!isLocalAssetPath(row.path))
            continue;
        projected.add(row.path);
        if (!pathsBelongToRoot(new Set([row.path]), targetRoot))
            return false;
        if (!(await isRegularAsset(row.path)))
            return false;
        if (!hasPersistedAssetPath(row.dataJson, row.path))
            return false;
    }
    return [...expectedCopiedPaths].every((path) => projected.has(path));
}
async function probeLegacyAssetRows(rows, expected) {
    const projected = new Set();
    for (const row of rows) {
        if (!isLocalAssetPath(row.path))
            continue;
        projected.add(row.path);
        if (!expected.has(row.path))
            return false;
        if (!(await isRegularAsset(row.path)))
            return false;
        if (!hasPersistedAssetPath(row.dataJson, row.path))
            return false;
    }
    return projected.size === expected.size && [...expected].every((path) => projected.has(path));
}
async function isRegularAsset(path) {
    try {
        const info = await lstat(path);
        return info.isFile() && !info.isSymbolicLink();
    }
    catch {
        return false;
    }
}
async function isExistingRegularAsset(path) {
    try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) {
            throw new Error('Fork asset target must be a regular file');
        }
        return true;
    }
    catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT')
            return false;
        throw error;
    }
}
function isErrnoException(error) {
    return error instanceof Error && 'code' in error;
}
function hasPersistedAssetPath(dataJson, expectedPath) {
    try {
        const data = JSON.parse(dataJson);
        return isRecord(data) && data.path === expectedPath;
    }
    catch {
        return false;
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
async function removeFile(path) {
    try {
        await rm(path, { force: true });
    }
    catch {
        // Compensation is best effort and followed by operation ownership probes.
    }
}
async function removeEmptyDirectory(path) {
    try {
        await rmdir(path);
    }
    catch {
        // A non-empty or already removed operation-owned directory needs no further action.
    }
}
function normalizedFromRow(row) {
    decodeDisplayMessage(row);
    return {
        msgId: row.messageId,
        role: row.role,
        turnId: row.turnId,
        source: row.source,
        sourceContextJson: row.sourceContextJson,
        createdAtMs: row.createdAtMs,
        dataJson: row.dataJson,
    };
}
function assetRecord(row) {
    return {
        id: row.id,
        sessionId: row.sessionId,
        messageId: row.messageId,
        messageCreatedAtMs: row.messageCreatedAtMs,
        assetKey: row.assetKey,
        sourceTag: row.sourceTag,
        path: row.path,
        name: row.name,
        assetType: row.assetType,
        dataJson: row.dataJson,
    };
}
function isLocalAssetPath(path) {
    return (path.length > 0 &&
        !/^https?:\/\//iu.test(path) &&
        !/^data:/iu.test(path) &&
        !path.startsWith('drive://'));
}
function resolveContainedPath(root, assetPath) {
    const candidate = resolve(isAbsolute(assetPath) ? assetPath : join(root, assetPath));
    const base = resolve(root);
    const rel = relative(base, candidate);
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
        throw new Error('Session asset path escapes the owned root');
    }
    return candidate;
}
async function copyRegularAsset(sourcePath, targetPath) {
    const sourceInfo = await lstat(sourcePath);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink())
        throw new Error('Session asset must be a regular file');
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
    await copyFile(sourcePath, targetPath);
}
function rewriteAssetPath(dataJson, sourcePath, targetPath) {
    try {
        const value = JSON.parse(dataJson);
        if (typeof value !== 'object' || value === null || Array.isArray(value))
            return dataJson;
        const copy = { ...value };
        if (copy.path === sourcePath)
            copy.path = targetPath;
        return JSON.stringify(copy);
    }
    catch {
        return dataJson;
    }
}
function assetOwnershipKey(messageId, key, path) {
    return `${messageId}\0${key}\0${path}`;
}
function messageContent(raw) {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' &&
        parsed !== null &&
        'msg_content' in parsed &&
        typeof parsed.msg_content === 'string'
        ? parsed.msg_content
        : '';
}
function normalizeLimit(value) {
    return value && value > 0 ? Math.min(Math.floor(value), 200) : 50;
}
function assetKey(asset) {
    return asset.path.trim() || asset.driveNodeId?.trim() || asset.artifactId?.trim() || '';
}
//# sourceMappingURL=assets.js.map