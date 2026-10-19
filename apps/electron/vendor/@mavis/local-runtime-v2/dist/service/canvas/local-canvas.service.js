import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { decodeSessionDeliverableCanvasReference, getCanvasAssetRelativePath, } from '@mavis/shared/asset-markup';
import { supportsCanvasImageAnnotation } from '@mavis/shared/media-asset-meta';
import { and, eq } from 'drizzle-orm';
import { canvasAssetReferences, canvasDocuments, canvasOperations, } from '../../infra/db/schema/canvas.js';
import { CanvasServiceError, } from './contracts.js';
export class LocalCanvasService {
    options;
    nowMs;
    sessionQueues = new Map();
    constructor(options) {
        this.options = options;
        this.nowMs = options.nowMs ?? Date.now;
    }
    async read(input) {
        const context = await this.resolveContext(input.sessionId);
        await ignoreFailure(this.sessionQueues.get(context.sessionId));
        const document = readDocument(this.options.db, context) ?? emptyDocument(context, this.nowMs());
        syncAssetReferencesIfNeeded(this.options.db, document);
        await ensureAssetProjections(context, document, this.options.assets);
        return document;
    }
    async prepareFiles(input) {
        if (input.targets.length === 0 || input.targets.length > 100) {
            throw new CanvasServiceError('INVALID_OPERATION', 'Canvas file target count is invalid');
        }
        const context = await this.resolveContext(input.sessionId);
        return this.enqueue(context.sessionId, async () => {
            const prepared = [];
            for (const target of input.targets) {
                prepared.push(await prepareCanvasFile(context, target, this.options.assets));
            }
            return prepared;
        });
    }
    async apply(input) {
        validateOperation(input.operation);
        const context = await this.resolveContext(input.sessionId);
        return this.enqueue(context.sessionId, async () => {
            const fingerprint = operationFingerprint(input.operation);
            try {
                const duplicate = applyResultFromReceipt(this.options.db, context, input.operation.operationId, fingerprint);
                if (duplicate)
                    return duplicate;
            }
            catch (error) {
                if (error instanceof CanvasServiceError)
                    throw error;
                throw new CanvasServiceError('PERSISTENCE_FAILED', 'Canvas operation could not be read', {
                    cause: errorMessage(error),
                });
            }
            const operation = await validateFileReferences(context, input.operation, this.options.assets);
            return this.applySerialized(context, operation, fingerprint);
        });
    }
    async deleteSession(sessionId) {
        await this.enqueue(sessionId, () => {
            try {
                this.options.db.transaction((transaction) => {
                    const db = transaction;
                    db.delete(canvasAssetReferences)
                        .where(eq(canvasAssetReferences.sessionId, sessionId))
                        .run();
                    db.delete(canvasOperations).where(eq(canvasOperations.sessionId, sessionId)).run();
                    db.delete(canvasDocuments).where(eq(canvasDocuments.sessionId, sessionId)).run();
                }, { behavior: 'immediate' });
            }
            catch (error) {
                throw new CanvasServiceError('PERSISTENCE_FAILED', 'Canvas could not be deleted', {
                    cause: errorMessage(error),
                });
            }
        });
    }
    async resolveContext(sessionId) {
        const session = await this.options.sessions.get(sessionId);
        if (!session)
            throw new CanvasServiceError('SESSION_NOT_FOUND', 'Session not found');
        const configuredWorkspace = session.workspaceDir.trim();
        if (!configuredWorkspace) {
            throw new CanvasServiceError('WORKSPACE_UNAVAILABLE', 'Session workspace is unavailable');
        }
        let workspaceDir;
        try {
            workspaceDir = await realpath(resolve(configuredWorkspace));
        }
        catch (error) {
            throw new CanvasServiceError('WORKSPACE_UNAVAILABLE', 'Session workspace is unavailable', {
                cause: errorMessage(error),
            });
        }
        return {
            sessionId,
            workspaceDir,
            canvasId: `canvas_${createHash('sha256').update(sessionId).digest('hex').slice(0, 24)}`,
        };
    }
    async applySerialized(context, operation, fingerprint = operationFingerprint(operation)) {
        try {
            const transactionResult = this.options.db.transaction((transaction) => {
                const db = transaction;
                const duplicate = applyResultFromReceipt(db, context, operation.operationId, fingerprint);
                if (duplicate)
                    return duplicate;
                const current = readDocument(db, context) ?? emptyDocument(context, this.nowMs());
                const document = applyMutations(current, operation.mutations, this.nowMs());
                const applyResult = {
                    operationId: operation.operationId,
                    document,
                };
                writeDocument(db, document);
                if (operationChangesAssetReferences(operation))
                    writeAssetReferences(db, document);
                db.insert(canvasOperations)
                    .values({
                    sessionId: context.sessionId,
                    operationId: operation.operationId,
                    fingerprint,
                    appliedChangeSeq: document.changeSeq,
                    createdAtMs: document.updatedAtMs,
                })
                    .run();
                return applyResult;
            }, { behavior: 'immediate' });
            return transactionResult;
        }
        catch (error) {
            if (error instanceof CanvasServiceError)
                throw error;
            throw new CanvasServiceError('PERSISTENCE_FAILED', 'Canvas operation could not be saved', {
                cause: errorMessage(error),
            });
        }
    }
    async enqueue(sessionId, operation) {
        const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve();
        const current = runAfter(previous, operation);
        const completion = ignoreFailure(current);
        this.sessionQueues.set(sessionId, completion);
        try {
            return await current;
        }
        finally {
            if (this.sessionQueues.get(sessionId) === completion)
                this.sessionQueues.delete(sessionId);
        }
    }
}
async function prepareCanvasFile(context, target, assets) {
    requireCanvasFileTargetId(target.id);
    if (target.kind === 'workspace') {
        return prepareWorkspaceCanvasFile(context.workspaceDir, target);
    }
    const asset = await resolveCanvasFileAsset(context.sessionId, target, assets);
    const sourceIdentity = getCanvasFileTargetIdentity(target);
    if (!asset)
        throw invalidFileReference(sourceIdentity);
    return materializePreparedCanvasFile(context.workspaceDir, target.id, sourceIdentity, asset);
}
function requireCanvasFileTargetId(value) {
    if (!value.trim()) {
        throw new CanvasServiceError('INVALID_OPERATION', 'Canvas file target id is required');
    }
}
async function prepareWorkspaceCanvasFile(workspaceDir, target) {
    const prepared = await validateWorkspaceFileReference(workspaceDir, {
        kind: 'add_file',
        nodeId: target.id,
        relativePath: target.relativePath,
        layout: { x: 0, y: 0, width: 1, height: 1, zIndex: 0 },
    });
    return { id: target.id, relativePath: prepared.relativePath };
}
async function resolveCanvasFileAsset(sessionId, target, assets) {
    switch (target.kind) {
        case 'asset':
            return assets.resolve({ sessionId, assetId: target.assetId });
        case 'session_deliverable':
            return assets.importDeliverable({ sessionId, path: target.sourcePath });
        case 'external_file':
            return assets.importExternal({ sessionId, path: target.sourcePath });
    }
}
function getCanvasFileTargetIdentity(target) {
    return target.kind === 'asset' ? target.assetId : target.sourcePath;
}
async function materializePreparedCanvasFile(workspaceDir, id, sourceIdentity, asset) {
    try {
        const relativePath = await materializeCanvasAsset(workspaceDir, asset, sourceIdentity);
        return {
            id,
            relativePath,
            assetId: asset.assetId,
            fileName: asset.fileName,
            mimeType: asset.mimeType,
            sizeBytes: asset.bytes,
            sha256: asset.sha256,
        };
    }
    catch (error) {
        if (error instanceof CanvasServiceError)
            throw error;
        throw invalidFileReference(sourceIdentity);
    }
}
function operationChangesAssetReferences(operation) {
    return operation.mutations.some((mutation) => mutation.kind === 'add_file' || mutation.kind === 'remove_node');
}
async function validateFileReferences(context, operation, assets) {
    const mutations = await Promise.all(operation.mutations.map((mutation) => validateFileReference(context, mutation, assets)));
    return { ...operation, mutations };
}
async function validateFileReference(context, mutation, assets) {
    if (mutation.kind !== 'add_file')
        return mutation;
    if ('assetId' in mutation && mutation.assetId) {
        const asset = await assets.resolve({
            sessionId: context.sessionId,
            assetId: mutation.assetId,
        });
        if (!asset)
            throw invalidFileReference(mutation.assetId);
        return prepareAssetMutation(context, mutation, asset, mutation.assetId);
    }
    const requestPath = mutation.relativePath;
    if (requestPath === undefined)
        throw invalidFileReference(requestPath);
    const deliverablePath = decodeSessionDeliverableCanvasReference(requestPath);
    if (deliverablePath) {
        const asset = await assets.importDeliverable({
            sessionId: context.sessionId,
            path: deliverablePath,
        });
        if (!asset)
            throw invalidFileReference(requestPath);
        return prepareAssetMutation(context, mutation, asset, requestPath);
    }
    return validateWorkspaceFileReference(context.workspaceDir, mutation);
}
async function prepareAssetMutation(context, mutation, asset, reference) {
    return {
        kind: 'add_file',
        nodeId: mutation.nodeId,
        layout: mutation.layout,
        relativePath: await materializeCanvasAsset(context.workspaceDir, asset, reference),
        asset,
    };
}
async function validateWorkspaceFileReference(workspaceDir, mutation) {
    const requestPath = mutation.relativePath;
    if (requestPath === undefined || isAbsolute(requestPath))
        throw invalidFileReference(requestPath);
    if (requestPath.trim().length === 0)
        throw invalidFileReference(requestPath);
    const canonicalFile = await resolveCanonicalFile(resolve(workspaceDir, requestPath), requestPath);
    const relativePath = workspaceRelativePath(workspaceDir, canonicalFile);
    if (!relativePath)
        throw invalidFileReference(requestPath);
    return { kind: 'add_file', nodeId: mutation.nodeId, layout: mutation.layout, relativePath };
}
async function materializeCanvasAsset(workspaceDir, asset, reference) {
    const canonicalSource = await resolveCanonicalFile(asset.absolutePath, reference);
    const relativePath = getCanvasAssetRelativePath(asset.assetId, asset.fileName);
    try {
        return await materializeAssetProjection(workspaceDir, canonicalSource, {
            relativePath,
            expectedBytes: asset.bytes,
            reference,
        });
    }
    catch (error) {
        if (error instanceof CanvasServiceError)
            throw error;
        throw invalidFileReference(reference);
    }
}
async function resolveCanonicalFile(path, reference) {
    try {
        const canonicalFile = await realpath(path);
        if (!(await stat(canonicalFile)).isFile())
            throw invalidFileReference(reference);
        return canonicalFile;
    }
    catch (error) {
        if (error instanceof CanvasServiceError)
            throw error;
        throw invalidFileReference(reference);
    }
}
async function materializeAssetProjection(workspaceDir, canonicalSource, options) {
    const { expectedBytes, reference, relativePath } = options;
    const targetPath = resolve(workspaceDir, relativePath);
    const targetDirectory = dirname(targetPath);
    await mkdir(targetDirectory, { recursive: true });
    const canonicalTargetDirectory = await realpath(targetDirectory);
    if (!isWithinWorkspace(workspaceDir, canonicalTargetDirectory)) {
        throw invalidFileReference(reference);
    }
    const canonicalTargetPath = resolve(canonicalTargetDirectory, basename(targetPath));
    const existingRelativePath = await existingAssetProjection(workspaceDir, canonicalTargetPath, expectedBytes);
    if (existingRelativePath)
        return existingRelativePath;
    const tempPath = resolve(canonicalTargetDirectory, `.${randomUUID()}.canvas-import`);
    try {
        await replaceProjectedFile(canonicalSource, tempPath, canonicalTargetPath);
    }
    finally {
        await removeFileIfPresent(tempPath);
    }
    const materializedRelativePath = workspaceRelativePath(workspaceDir, await realpath(canonicalTargetPath));
    if (!materializedRelativePath)
        throw invalidFileReference(reference);
    return materializedRelativePath;
}
async function existingAssetProjection(workspaceDir, targetPath, expectedBytes) {
    try {
        const info = await lstat(targetPath);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== expectedBytes)
            return undefined;
        return workspaceRelativePath(workspaceDir, await realpath(targetPath));
    }
    catch {
        return undefined;
    }
}
async function replaceProjectedFile(sourcePath, tempPath, targetPath) {
    // COPYFILE_FICLONE keeps the workspace projection on copy-on-write storage
    // where supported, without sharing a mutable inode with the immutable asset.
    await copyFile(sourcePath, tempPath, constants.COPYFILE_FICLONE);
    try {
        await rename(tempPath, targetPath);
    }
    catch {
        await rm(targetPath, { force: true });
        await rename(tempPath, targetPath);
    }
}
async function ensureAssetProjections(context, document, assets) {
    for (const node of document.nodes) {
        const assetId = node.file.assetId;
        if (!assetId)
            continue;
        const asset = await assets.resolve({ sessionId: context.sessionId, assetId });
        if (!asset)
            throw invalidFileReference(assetId);
        await materializeCanvasAsset(context.workspaceDir, asset, assetId);
    }
}
async function removeFileIfPresent(path) {
    try {
        await rm(path, { force: true });
    }
    catch {
        // Best-effort cleanup for a temporary import path.
    }
}
function workspaceRelativePath(workspaceDir, candidate) {
    const relativePath = relative(workspaceDir, candidate);
    if (!relativePath)
        return undefined;
    if (isAbsolute(relativePath))
        return undefined;
    if (relativePath === '..')
        return undefined;
    if (relativePath.startsWith(`..${sep}`))
        return undefined;
    return relativePath.split(sep).join('/');
}
function isWithinWorkspace(workspaceDir, candidate) {
    const relativePath = relative(workspaceDir, candidate);
    if (isAbsolute(relativePath))
        return false;
    if (relativePath === '..')
        return false;
    return !relativePath.startsWith(`..${sep}`);
}
function applyMutations(current, mutations, updatedAtMs) {
    let nodes = current.nodes.map(cloneNode);
    for (const mutation of mutations) {
        const nodeIndex = nodes.findIndex((node) => node.id === mutation.nodeId);
        if (mutation.kind === 'add_file') {
            if (nodeIndex >= 0) {
                throw new CanvasServiceError('NODE_ALREADY_EXISTS', `Canvas node already exists: ${mutation.nodeId}`);
            }
            nodes.push({
                id: mutation.nodeId,
                type: 'file_ref',
                file: mutation.asset
                    ? {
                        relativePath: mutation.relativePath,
                        assetId: mutation.asset.assetId,
                        fileName: mutation.asset.fileName,
                        mimeType: mutation.asset.mimeType,
                        sizeBytes: mutation.asset.bytes,
                        sha256: mutation.asset.sha256,
                    }
                    : { relativePath: mutation.relativePath },
                layout: { ...mutation.layout },
                annotations: [],
            });
            continue;
        }
        if (nodeIndex < 0) {
            throw new CanvasServiceError('NODE_NOT_FOUND', `Canvas node not found: ${mutation.nodeId}`);
        }
        const node = nodes[nodeIndex];
        if (!node) {
            throw new CanvasServiceError('NODE_NOT_FOUND', `Canvas node not found: ${mutation.nodeId}`);
        }
        if (mutation.kind === 'remove_node') {
            nodes = nodes.filter((candidate) => candidate.id !== mutation.nodeId);
            continue;
        }
        if ('annotation' in mutation) {
            nodes[nodeIndex] = applyAnnotationMutation(node, mutation);
            continue;
        }
        if (mutation.kind === 'remove_annotation') {
            nodes[nodeIndex] = removeAnnotation(node, mutation.annotationId);
            continue;
        }
        nodes[nodeIndex] = {
            ...node,
            layout: { ...mutation.layout },
        };
    }
    return {
        ...current,
        changeSeq: current.changeSeq + 1,
        nodes,
        updatedAtMs,
    };
}
function applyAnnotationMutation(node, mutation) {
    return mutation.kind === 'add_annotation'
        ? appendAnnotation(node, mutation.annotation)
        : updateAnnotation(node, mutation.annotation);
}
function removeAnnotation(node, annotationId) {
    if (!node.annotations.some((annotation) => annotation.id === annotationId)) {
        throw new CanvasServiceError('INVALID_OPERATION', 'Canvas annotation does not exist');
    }
    return {
        ...node,
        annotations: node.annotations.filter((annotation) => annotation.id !== annotationId),
    };
}
function appendAnnotation(node, annotation) {
    if (!supportsCanvasImageAnnotation(node.file.fileName ?? node.file.relativePath)) {
        throw new CanvasServiceError('INVALID_OPERATION', 'Canvas annotations are supported only for JPEG or PNG image nodes');
    }
    const identityExists = node.annotations.some((candidate) => candidate.id === annotation.id || candidate.number === annotation.number);
    if (identityExists) {
        throw new CanvasServiceError('INVALID_OPERATION', 'Canvas annotation identity is invalid');
    }
    return {
        ...node,
        annotations: [...node.annotations, cloneAnnotation(annotation)],
    };
}
function updateAnnotation(node, annotation) {
    const annotationIndex = node.annotations.findIndex((candidate) => candidate.id === annotation.id);
    if (annotationIndex < 0) {
        throw new CanvasServiceError('INVALID_OPERATION', 'Canvas annotation does not exist');
    }
    const numberConflict = node.annotations.some((candidate, index) => index !== annotationIndex && candidate.number === annotation.number);
    if (numberConflict) {
        throw new CanvasServiceError('INVALID_OPERATION', 'Canvas annotation identity is invalid');
    }
    const annotations = node.annotations.map((candidate, index) => index === annotationIndex ? cloneAnnotation(annotation) : candidate);
    return { ...node, annotations };
}
function validateOperation(operation) {
    if (operation.schemaVersion !== 1 ||
        operation.operationId.trim().length === 0 ||
        operation.mutations.length === 0) {
        throw new CanvasServiceError('INVALID_OPERATION', 'Canvas operation is invalid');
    }
    for (const mutation of operation.mutations) {
        validateMutation(mutation);
    }
}
function validateMutation(mutation) {
    if (mutation.nodeId.trim().length === 0) {
        throw new CanvasServiceError('INVALID_OPERATION', 'Canvas mutation node identity is invalid');
    }
    if (mutation.kind === 'add_file')
        validateAddFileIdentity(mutation);
    if ('layout' in mutation)
        validateLayout(mutation.layout);
    if (mutation.kind === 'add_annotation' || mutation.kind === 'update_annotation') {
        validateAnnotation(mutation.annotation);
    }
    if (mutation.kind === 'remove_annotation' && mutation.annotationId.trim().length === 0) {
        throw new CanvasServiceError('INVALID_OPERATION', 'Canvas annotation identity is invalid');
    }
}
function validateAddFileIdentity(mutation) {
    const hasRelativePath = 'relativePath' in mutation &&
        typeof mutation.relativePath === 'string' &&
        mutation.relativePath.trim().length > 0;
    const hasAssetId = 'assetId' in mutation &&
        typeof mutation.assetId === 'string' &&
        mutation.assetId.trim().length > 0;
    if (hasRelativePath === hasAssetId) {
        throw new CanvasServiceError('INVALID_OPERATION', 'Canvas add_file requires exactly one file identity');
    }
}
function validateAnnotation(annotation) {
    if (!isValidAnnotationMetadata(annotation) || !isValidNormalizedRect(annotation.normalizedRect)) {
        throw new CanvasServiceError('INVALID_OPERATION', 'Canvas annotation is invalid');
    }
}
function isValidAnnotationMetadata(annotation) {
    return (annotation.id.trim().length > 0 &&
        Number.isSafeInteger(annotation.number) &&
        annotation.number > 0 &&
        (annotation.action === 'comment' || annotation.action === 'erase') &&
        annotation.comment.trim().length > 0 &&
        Number.isSafeInteger(annotation.createdAtMs) &&
        annotation.createdAtMs >= 0);
}
function isValidNormalizedRect(rect) {
    return ([rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
        rect.x >= 0 &&
        rect.y >= 0 &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.x + rect.width <= 1 &&
        rect.y + rect.height <= 1);
}
function validateLayout(layout) {
    const values = [layout.x, layout.y, layout.width, layout.height, layout.zIndex];
    if (values.some((value) => !Number.isFinite(value)) ||
        layout.width <= 0 ||
        layout.height <= 0 ||
        !Number.isSafeInteger(layout.zIndex)) {
        throw new CanvasServiceError('INVALID_OPERATION', 'Canvas node layout is invalid');
    }
}
function readDocument(db, context) {
    const row = db
        .select({ documentJson: canvasDocuments.documentJson })
        .from(canvasDocuments)
        .where(eq(canvasDocuments.sessionId, context.sessionId))
        .get();
    return row ? parseDocument(row.documentJson, context) : undefined;
}
function readOperation(db, sessionId, operationId) {
    return db
        .select({
        fingerprint: canvasOperations.fingerprint,
        appliedChangeSeq: canvasOperations.appliedChangeSeq,
    })
        .from(canvasOperations)
        .where(and(eq(canvasOperations.sessionId, sessionId), eq(canvasOperations.operationId, operationId)))
        .get();
}
function applyResultFromReceipt(db, context, operationId, fingerprint) {
    const receipt = readOperation(db, context.sessionId, operationId);
    if (!receipt)
        return undefined;
    if (receipt.fingerprint !== fingerprint) {
        throw new CanvasServiceError('OPERATION_ID_REUSED', 'operationId was already used for a different operation');
    }
    const document = readDocument(db, context);
    if (!document ||
        !Number.isSafeInteger(receipt.appliedChangeSeq) ||
        receipt.appliedChangeSeq <= 0 ||
        document.changeSeq < receipt.appliedChangeSeq) {
        throw new CanvasServiceError('PERSISTENCE_FAILED', 'Canvas operation receipt is inconsistent with the current document', {
            operationId,
            appliedChangeSeq: receipt.appliedChangeSeq,
            currentChangeSeq: document?.changeSeq,
        });
    }
    return { operationId, document };
}
function writeDocument(db, document) {
    db.insert(canvasDocuments)
        .values({
        sessionId: document.sessionId,
        canvasId: document.canvasId,
        documentJson: JSON.stringify(document),
        changeSeq: document.changeSeq,
        updatedAtMs: document.updatedAtMs,
    })
        .onConflictDoUpdate({
        target: canvasDocuments.sessionId,
        set: {
            documentJson: JSON.stringify(document),
            changeSeq: document.changeSeq,
            updatedAtMs: document.updatedAtMs,
        },
    })
        .run();
}
function syncAssetReferencesIfNeeded(db, document) {
    const expected = document.nodes.flatMap((node) => node.file.assetId ? [{ nodeId: node.id, assetId: node.file.assetId }] : []);
    const current = db
        .select({ nodeId: canvasAssetReferences.nodeId, assetId: canvasAssetReferences.assetId })
        .from(canvasAssetReferences)
        .where(eq(canvasAssetReferences.sessionId, document.sessionId))
        .all();
    if (current.length === expected.length &&
        current.every((row) => expected.some((candidate) => candidate.nodeId === row.nodeId && candidate.assetId === row.assetId))) {
        return;
    }
    db.transaction((transaction) => writeAssetReferences(transaction, document), {
        behavior: 'immediate',
    });
}
function writeAssetReferences(db, document) {
    db.delete(canvasAssetReferences)
        .where(eq(canvasAssetReferences.sessionId, document.sessionId))
        .run();
    const references = document.nodes.flatMap((node) => node.file.assetId
        ? [
            {
                sessionId: document.sessionId,
                nodeId: node.id,
                assetId: node.file.assetId,
                createdAtMs: document.updatedAtMs,
            },
        ]
        : []);
    if (references.length > 0)
        db.insert(canvasAssetReferences).values(references).run();
}
function emptyDocument(context, updatedAtMs) {
    return {
        schemaVersion: 1,
        canvasId: context.canvasId,
        sessionId: context.sessionId,
        changeSeq: 0,
        nodes: [],
        updatedAtMs,
    };
}
function parseDocument(raw, context) {
    const document = JSON.parse(raw);
    if (document.schemaVersion !== 1 ||
        document.canvasId !== context.canvasId ||
        document.sessionId !== context.sessionId ||
        !Number.isSafeInteger(document.changeSeq) ||
        !Array.isArray(document.nodes)) {
        throw new Error('Stored Canvas document is invalid');
    }
    return {
        ...document,
        nodes: document.nodes.map((node) => ({
            ...node,
            annotations: Array.isArray(node.annotations) ? node.annotations.map(cloneAnnotation) : [],
        })),
    };
}
function operationFingerprint(operation) {
    return createHash('sha256').update(JSON.stringify(operation)).digest('hex');
}
function cloneNode(node) {
    return {
        ...node,
        file: { ...node.file },
        layout: { ...node.layout },
        annotations: node.annotations.map(cloneAnnotation),
    };
}
function cloneAnnotation(annotation) {
    return {
        ...annotation,
        normalizedRect: { ...annotation.normalizedRect },
    };
}
function invalidFileReference(relativePath) {
    return new CanvasServiceError('INVALID_FILE_REFERENCE', 'File reference is outside the workspace or unavailable', {
        relativePath: relativePath ?? '',
    });
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
async function runAfter(previous, operation) {
    await ignoreFailure(previous);
    return operation();
}
async function ignoreFailure(promise) {
    try {
        await promise;
    }
    catch {
        // One failed operation must not poison later operations in the same Session Canvas.
    }
}
//# sourceMappingURL=local-canvas.service.js.map