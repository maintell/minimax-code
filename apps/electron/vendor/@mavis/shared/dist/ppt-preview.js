/** Generator-neutral, complete-PPTX publication contract. */
export const PPT_PREVIEW_SCHEMA = 'minimax.ppt-preview';
export const PPT_PREVIEW_LIMITS = Object.freeze({
    maxSourceBytes: 64 * 1024 * 1024,
    maxPages: 200,
    maxVersions: 100,
    maxQueuedVersions: 8,
});
export class PptPreviewError extends Error {
    code;
    field;
    constructor(code, message, field) {
        super(message);
        this.code = code;
        this.field = field;
        this.name = 'PptPreviewError';
    }
}
const actions = new Set([
    'capabilities',
    'start',
    'publish',
    'progress',
    'status',
    'complete',
    'cancel',
    'list',
    'events',
]);
const keys = new Set([
    'schema',
    'action',
    'requestId',
    'artifactKey',
    'title',
    'aspectRatio',
    'expectedPages',
    'artifactId',
    'generationId',
    'previousGenerationId',
    'fromSnapshotId',
    'adoptArtifactId',
    'expectedGenerationId',
    'expectedRevision',
    'baseRevision',
    'pptx',
    'pages',
    'phase',
    'message',
    'snapshotId',
    'queryRequestId',
    'eventCursor',
]);
function fail(field, message) {
    throw new PptPreviewError('INVALID_REQUEST', message, field);
}
export function decodePptPreviewRequest(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        fail('request', 'Expected an object');
    const v = value;
    for (const key of Object.keys(v))
        if (!keys.has(key))
            fail(key, 'Unknown request field');
    if (!actions.has(v.action))
        fail('action', 'Unknown preview action');
    if (v.schema !== `${PPT_PREVIEW_SCHEMA}.${v.action}.v1`)
        throw new PptPreviewError('PROTOCOL_MISMATCH', 'Unsupported PPT preview schema', 'schema');
    for (const key of [
        'requestId',
        'artifactKey',
        'title',
        'artifactId',
        'generationId',
        'previousGenerationId',
        'fromSnapshotId',
        'adoptArtifactId',
        'expectedGenerationId',
        'pptx',
        'phase',
        'message',
        'snapshotId',
        'queryRequestId',
    ]) {
        if (v[key] !== undefined &&
            (typeof v[key] !== 'string' || !v[key].trim() || v[key].length > 4096))
            fail(key, 'Expected a nonempty bounded string');
    }
    for (const key of ['expectedPages', 'expectedRevision', 'baseRevision', 'eventCursor']) {
        if (v[key] !== undefined && (!Number.isSafeInteger(v[key]) || Number(v[key]) < 0))
            fail(key, 'Expected a nonnegative integer');
    }
    if (v.aspectRatio !== undefined &&
        (typeof v.aspectRatio !== 'number' ||
            !Number.isFinite(v.aspectRatio) ||
            v.aspectRatio < 0.25 ||
            v.aspectRatio > 4))
        fail('aspectRatio', 'Invalid aspect ratio');
    if (Number(v.expectedPages ?? 0) > PPT_PREVIEW_LIMITS.maxPages)
        throw new PptPreviewError('LIMIT_EXCEEDED', 'Too many pages', 'expectedPages');
    if (['start', 'publish', 'progress', 'complete', 'cancel'].includes(String(v.action)) &&
        !v.requestId)
        fail('requestId', 'Write requests require requestId');
    if (['publish', 'progress', 'complete', 'cancel'].includes(String(v.action)) &&
        (!v.artifactId || !v.generationId))
        fail('artifactId', 'artifactId and generationId are required');
    if (v.action === 'start') {
        const modes = [
            Boolean(v.artifactKey),
            Boolean(v.artifactId),
            Boolean(v.adoptArtifactId),
        ].filter(Boolean).length;
        if (modes !== 1)
            fail('artifactKey', 'Choose initial creation, revision or adoption');
        if (v.artifactId && !v.previousGenerationId)
            fail('previousGenerationId', 'Revision requires previousGenerationId');
        if (v.adoptArtifactId && (!v.expectedGenerationId || v.expectedRevision === undefined))
            fail('expectedRevision', 'Adoption requires expected generation and revision');
    }
    if (v.action === 'publish') {
        if (!v.pptx || v.baseRevision === undefined)
            fail('pptx', 'publish requires pptx and baseRevision');
        if (!Array.isArray(v.pages) || !v.pages.length || v.pages.length > PPT_PREVIEW_LIMITS.maxPages)
            fail('pages', 'Expected a bounded complete page manifest');
        const ids = new Set();
        const slides = new Set();
        for (const [i, p] of v.pages.entries()) {
            if (!p || typeof p !== 'object' || Array.isArray(p))
                fail(`pages.${i}`, 'Invalid page');
            for (const k of Object.keys(p))
                if (!['pageId', 'sourceSlide', 'title', 'contentState'].includes(k))
                    fail(`pages.${i}.${k}`, 'Unknown page field');
            if (typeof p.pageId !== 'string' ||
                !p.pageId.trim() ||
                p.pageId.length > 256 ||
                !Number.isSafeInteger(p.sourceSlide) ||
                p.sourceSlide < 1 ||
                !['draft', 'ready'].includes(p.contentState) ||
                (p.title !== undefined && (typeof p.title !== 'string' || p.title.length > 1024)))
                fail(`pages.${i}`, 'Invalid page metadata');
            if (ids.has(p.pageId) || slides.has(p.sourceSlide))
                throw new PptPreviewError('PAGE_MAP_INVALID', 'Duplicate page identity or source slide', `pages.${i}`);
            ids.add(p.pageId);
            slides.add(p.sourceSlide);
        }
    }
    if (v.action === 'complete' && (!v.snapshotId || v.expectedRevision === undefined))
        fail('snapshotId', 'complete requires snapshotId and expectedRevision');
    return structuredClone(v);
}
//# sourceMappingURL=ppt-preview.js.map