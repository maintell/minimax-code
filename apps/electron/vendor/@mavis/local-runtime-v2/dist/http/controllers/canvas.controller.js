import { CanvasServiceError, } from '../../service/canvas/index.js';
import { CanvasControllerBase } from '../generated/canvas-controller-base.gen.js';
import { AppError, NotImplementedError } from '../errors.js';
export class CanvasController extends CanvasControllerBase {
    service;
    constructor(service) {
        super();
        this.service = service;
    }
    async readCanvas(_ctx, req) {
        try {
            return {
                document: toWireDocument(await this.requireService().read({ sessionId: req.sessionId })),
            };
        }
        catch (error) {
            throw mapCanvasError(error);
        }
    }
    async prepareCanvasFiles(_ctx, req) {
        try {
            const files = await this.requireService().prepareFiles({
                sessionId: req.sessionId,
                targets: req.targets.map(fromWireFileTarget),
            });
            return { files: files.map((file) => ({ ...file })) };
        }
        catch (error) {
            throw mapCanvasError(error);
        }
    }
    async applyCanvasOperation(_ctx, req) {
        try {
            const result = await this.requireService().apply({
                sessionId: req.sessionId,
                operation: {
                    schemaVersion: requireSchemaVersion(req.operation.schemaVersion),
                    operationId: req.operation.operationId,
                    mutations: req.operation.mutations.map(fromWireMutation),
                },
            });
            return { operationId: result.operationId, document: toWireDocument(result.document) };
        }
        catch (error) {
            throw mapCanvasError(error);
        }
    }
    requireService() {
        if (!this.service)
            throw new NotImplementedError('canvas service');
        return this.service;
    }
}
function fromWireFileTarget(target) {
    const id = requireFileTargetId(target.id);
    switch (target.kind) {
        case 'workspace':
            return fromWireWorkspaceTarget(id, target);
        case 'asset':
            return fromWireAssetTarget(id, target);
        case 'session_deliverable':
        case 'external_file':
            return fromWireSourceTarget(id, target, target.kind);
        default:
            throw invalidOperation(`Unsupported Canvas file target: ${target.kind}`);
    }
}
function requireFileTargetId(value) {
    const id = value.trim();
    if (!id)
        throw invalidOperation('Canvas file target id is required');
    return id;
}
function fromWireWorkspaceTarget(id, target) {
    if (target.relativePath === undefined ||
        target.assetId !== undefined ||
        target.sourcePath !== undefined) {
        throw invalidOperation('workspace target requires only relativePath');
    }
    return { id, kind: 'workspace', relativePath: target.relativePath };
}
function fromWireAssetTarget(id, target) {
    if (target.assetId === undefined ||
        target.relativePath !== undefined ||
        target.sourcePath !== undefined) {
        throw invalidOperation('asset target requires only assetId');
    }
    return { id, kind: 'asset', assetId: target.assetId };
}
function fromWireSourceTarget(id, target, kind) {
    if (target.sourcePath === undefined ||
        target.relativePath !== undefined ||
        target.assetId !== undefined) {
        throw invalidOperation(`${kind} target requires only sourcePath`);
    }
    return { id, kind, sourcePath: target.sourcePath };
}
function fromWireMutation(mutation) {
    if (mutation.kind === 'add_annotation' || mutation.kind === 'update_annotation') {
        return fromWireAnnotationMutation(mutation, mutation.kind);
    }
    switch (mutation.kind) {
        case 'add_file':
            return fromWireAddFile(mutation);
        case 'update_layout':
            rejectUnexpectedMutationFields(mutation, ['layout']);
            if (mutation.layout === undefined) {
                throw invalidOperation('update_layout requires layout');
            }
            return {
                kind: 'update_layout',
                nodeId: mutation.nodeId,
                layout: fromWireLayout(mutation.layout),
            };
        case 'remove_node':
            rejectUnexpectedMutationFields(mutation, []);
            return {
                kind: 'remove_node',
                nodeId: mutation.nodeId,
            };
        case 'remove_annotation':
            return fromWireRemoveAnnotation(mutation);
        default:
            throw invalidOperation(`Unsupported Canvas mutation: ${mutation.kind}`);
    }
}
function fromWireAddFile(mutation) {
    rejectUnexpectedMutationFields(mutation, ['relativePath', 'layout', 'assetId']);
    if (mutation.layout === undefined)
        throw invalidOperation('add_file requires layout');
    if ((mutation.relativePath === undefined) === (mutation.assetId === undefined)) {
        throw invalidOperation('add_file requires exactly one file identity');
    }
    const layout = fromWireLayout(mutation.layout);
    if (mutation.assetId !== undefined) {
        return { kind: 'add_file', nodeId: mutation.nodeId, assetId: mutation.assetId, layout };
    }
    if (mutation.relativePath === undefined) {
        throw invalidOperation('add_file requires relativePath');
    }
    return {
        kind: 'add_file',
        nodeId: mutation.nodeId,
        relativePath: mutation.relativePath,
        layout,
    };
}
function fromWireAnnotationMutation(mutation, kind) {
    rejectUnexpectedMutationFields(mutation, ['annotation']);
    if (mutation.annotation === undefined) {
        throw invalidOperation(`${kind} requires annotation`);
    }
    return {
        kind,
        nodeId: mutation.nodeId,
        annotation: fromWireAnnotation(mutation.annotation),
    };
}
function fromWireRemoveAnnotation(mutation) {
    rejectUnexpectedMutationFields(mutation, ['annotationId']);
    if (mutation.annotationId === undefined) {
        throw invalidOperation('remove_annotation requires annotationId');
    }
    return {
        kind: 'remove_annotation',
        nodeId: mutation.nodeId,
        annotationId: mutation.annotationId,
    };
}
const CANVAS_MUTATION_OPTIONAL_FIELDS = [
    'relativePath',
    'layout',
    'annotation',
    'annotationId',
    'assetId',
];
function rejectUnexpectedMutationFields(mutation, allowedFields) {
    for (const field of CANVAS_MUTATION_OPTIONAL_FIELDS) {
        if (mutation[field] !== undefined && !allowedFields.includes(field)) {
            throw invalidOperation(`${mutation.kind} does not allow ${field}`);
        }
    }
}
function fromWireAnnotation(annotation) {
    if (annotation.action !== 'comment' && annotation.action !== 'erase') {
        throw invalidOperation(`Unsupported Canvas annotation action: ${annotation.action}`);
    }
    return {
        id: annotation.id,
        number: annotation.number,
        normalizedRect: { ...annotation.normalizedRect },
        comment: annotation.comment,
        action: annotation.action,
        createdAtMs: annotation.createdAtMs,
    };
}
function fromWireLayout(layout) {
    return {
        x: layout.x,
        y: layout.y,
        width: layout.width,
        height: layout.height,
        zIndex: layout.zIndex,
    };
}
function toWireDocument(document) {
    return {
        schemaVersion: document.schemaVersion,
        canvasId: document.canvasId,
        sessionId: document.sessionId,
        changeSeq: document.changeSeq,
        nodes: document.nodes.map((node) => ({
            id: node.id,
            type: node.type,
            relativePath: node.file.relativePath,
            ...(node.file.assetId ? { assetId: node.file.assetId } : {}),
            ...(node.file.fileName ? { fileName: node.file.fileName } : {}),
            ...(node.file.mimeType ? { mimeType: node.file.mimeType } : {}),
            ...(node.file.sizeBytes !== undefined ? { sizeBytes: node.file.sizeBytes } : {}),
            ...(node.file.sha256 ? { sha256: node.file.sha256 } : {}),
            layout: { ...node.layout },
            annotations: node.annotations.map((annotation) => ({
                ...annotation,
                normalizedRect: { ...annotation.normalizedRect },
            })),
        })),
        updatedAtMs: document.updatedAtMs,
    };
}
function requireSchemaVersion(value) {
    if (value !== 1)
        throw invalidOperation('Unsupported Canvas operation schema version');
    return 1;
}
function invalidOperation(message) {
    return new AppError(400, 'INVALID_OPERATION', message);
}
function mapCanvasError(error) {
    if (!(error instanceof CanvasServiceError))
        return error;
    const status = CANVAS_ERROR_STATUSES[error.code];
    return new AppError(status, error.code, status === 500 ? 'Canvas persistence failed' : error.message);
}
const CANVAS_ERROR_STATUSES = {
    SESSION_NOT_FOUND: 404,
    WORKSPACE_UNAVAILABLE: 409,
    INVALID_OPERATION: 400,
    INVALID_FILE_REFERENCE: 400,
    FILE_ALREADY_ON_CANVAS: 409,
    NODE_ALREADY_EXISTS: 409,
    NODE_NOT_FOUND: 404,
    OPERATION_ID_REUSED: 409,
    PERSISTENCE_FAILED: 500,
};
//# sourceMappingURL=canvas.controller.js.map