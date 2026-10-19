/** Versioned contracts shared by document preview hosts and renderers. */
import { PPTX_PREVIEW_LIMITS_V1 } from './pptx-preview-limits.generated.js';
export { PPTX_PREVIEW_LIMITS_SCHEMA_V1, PPTX_PREVIEW_LIMITS_VERSION_V1, PPTX_PREVIEW_LIMITS_V1, } from './pptx-preview-limits.generated.js';
/** Product-owned identity for the renderer that exposes PPTX as selectable DOM. */
export const PPTX_DOM_BACKEND_ID_V1 = 'pptx-dom';
export const PPTX_CORE_BACKEND_ID_V1 = 'pptx-core';
/** Product contract version; it is intentionally independent of vendor package versions. */
export const PPTX_DOM_BACKEND_VERSION_V1 = 'pptx-dom.v1';
/**
 * Canonical origin for every renderer-facing preview capability.  Keeping the
 * origin in the shared contract avoids the store, Electron protocol handler,
 * PDF.js presenter, and validators silently drifting to different hosts.
 */
export const PREVIEW_ARTIFACT_PROTOCOL_NAME_V1 = 'mavis-preview';
export const PREVIEW_ARTIFACT_SCHEME_V1 = `${PREVIEW_ARTIFACT_PROTOCOL_NAME_V1}:`;
export const PREVIEW_ARTIFACT_HOST_V1 = 'preview';
export const PREVIEW_ARTIFACT_ORIGIN_V1 = `${PREVIEW_ARTIFACT_SCHEME_V1}//${PREVIEW_ARTIFACT_HOST_V1}`;
export const PREVIEW_ARTIFACT_RESOURCE_URL_V1 = /^mavis-preview:\/\/preview\/artifact\/[a-f0-9]{32}\/(?!\.{1,2}$)[A-Za-z0-9._~-]+$/u;
const PREVIEW_ARTIFACT_ID_V1 = /^[a-f0-9]{32}$/u;
const PREVIEW_ARTIFACT_RESOURCE_ID_V1 = /^[A-Za-z0-9_-]{1,128}$/u;
/** Build the only URL form that may cross the main/renderer preview boundary. */
export function buildPreviewArtifactResourceUrlV1(previewId, resourceId) {
    if (!PREVIEW_ARTIFACT_ID_V1.test(previewId))
        throw new TypeError('invalid preview id');
    if (!PREVIEW_ARTIFACT_RESOURCE_ID_V1.test(resourceId))
        throw new TypeError('invalid preview resource id');
    return `${PREVIEW_ARTIFACT_ORIGIN_V1}/artifact/${previewId}/${resourceId}`;
}
export function isPreviewArtifactResourceUrlV1(value) {
    return typeof value === 'string' && PREVIEW_ARTIFACT_RESOURCE_URL_V1.test(value);
}
const SAFE_PREVIEW_DIAGNOSTICS = {
    invalid_request: 'Invalid document preview request',
    invalid_source_archive: 'The document archive is invalid',
    unsupported_package_feature: 'The document uses an unsupported package feature',
    resource_limit_exceeded: 'The document exceeds the preview resource limit',
    source_not_found: 'The document preview source is unavailable',
    source_outside_workspace: 'The document preview source is outside the workspace',
    source_too_large: 'The document is too large to preview',
    backend_unavailable: 'The document preview backend is unavailable',
    component_unavailable: 'The optional preview component is unavailable',
    component_verification_failed: 'The optional preview component could not be verified',
    cancelled: 'Document preview was cancelled',
    timeout: 'Document preview timed out',
    render_failed: 'The document could not be rendered',
    transform_failed: 'The document could not be transformed',
    artifact_invalid: 'The generated preview artifact is invalid',
    source_mutated: 'The document changed while it was being previewed',
    internal: 'Document preview failed',
};
/**
 * Renderer-facing diagnostics are deliberately boring.  Native process
 * stderr, local paths, URLs, and stack text remain main-process diagnostics;
 * they must never cross the IPC boundary as a user-visible message.
 */
export function safePreviewDiagnosticV1(code, message) {
    // `message` is intentionally ignored. It remains available to the main
    // process logger, while the renderer receives one stable diagnostic per
    // error code and cannot use this boundary as a data-exfiltration sink.
    void message;
    return SAFE_PREVIEW_DIAGNOSTICS[code] ?? SAFE_PREVIEW_DIAGNOSTICS.internal;
}
/**
 * Renderer/adaptor diagnostics are main-process observability only.  Every
 * outward PPTX failure uses this product-owned diagnostic rather than trying
 * to recognize implementation names or versions in arbitrary error text.
 */
export function sanitizePptxRendererMessageV1(message) {
    void message;
    return 'PPTX DOM renderer failed';
}
const ARTIFACT_KINDS = new Set([
    'html-document.v1',
    'pdf.v1',
    'paged-raster.v1',
    'workbook-grid.v1',
]);
const BACKENDS = new Set([
    'docx-preview',
    'sheetjs-grid',
    PPTX_DOM_BACKEND_ID_V1,
    PPTX_CORE_BACKEND_ID_V1,
    'libreoffice-native',
    'quicklook-raster',
    'quicklook-html',
]);
/**
 * Decode a renderer-provided backend id into the stable product contract.
 */
export function normalizePreviewBackendIdV1(value) {
    return typeof value === 'string' && BACKENDS.has(value)
        ? value
        : undefined;
}
function isPreviewBackendInputIdV1(value) {
    return normalizePreviewBackendIdV1(value) !== undefined;
}
function isPreviewBackendIdV1(value) {
    return typeof value === 'string' && BACKENDS.has(value);
}
function isPreviewFallbackTargetIdV1(value) {
    return typeof value === 'string' && FALLBACK_TARGETS.has(value);
}
const CAPABILITIES = new Set([
    'region-selection',
    'semantic-elements',
    'text-selection',
    'search',
    'high-fidelity-static',
]);
const ERROR_CODES = new Set([
    'invalid_request',
    'invalid_source_archive',
    'unsupported_package_feature',
    'resource_limit_exceeded',
    'source_not_found',
    'source_outside_workspace',
    'source_too_large',
    'backend_unavailable',
    'component_unavailable',
    'component_verification_failed',
    'cancelled',
    'timeout',
    'render_failed',
    'transform_failed',
    'artifact_invalid',
    'source_mutated',
    'internal',
]);
const FALLBACK_TARGETS = new Set([...BACKENDS, 'system-open']);
const PROGRESS_STAGES = new Set([
    'queued',
    'preflight',
    'installing',
    'transforming',
    'ready',
    'failed',
    'cancelled',
]);
const PPTX_FEATURE_SEVERITIES = Object.freeze({
    animation: 'info',
    'speaker-notes': 'info',
    ole: 'fallback',
    'emf-wmf': 'fallback',
    'external-relationship': 'info',
    'embedded-font': 'info',
    formula: 'fallback',
    'unknown-graphic-frame': 'fallback',
});
const PPTX_FEATURE_KINDS = new Set(Object.keys(PPTX_FEATURE_SEVERITIES));
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
// URL-looking strings are allowed in public diagnostics, but local paths and
// data payloads are not. The scanner below first recognizes a strict HTTP or
// versioned preview URL authority, then validates the whole token before
// masking it. In particular, a raw backslash or a punctuation-delimited local
// path makes the candidate invalid, so the normal path scanners can still see
// and reject the payload. This is deliberately implemented with string/RegExp
// primitives only: this module is shared by browser and native hosts.
const HTTP_URL_AUTHORITY = /https?:\/\/(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::\d{1,5})?/giu;
const MAVIS_PREVIEW_URL_AUTHORITY = /mavis-preview:\/\/preview\/artifact\/[a-f0-9]{32}\/(?!\.{1,2}(?:[/?#]|$))[A-Za-z0-9._~-]+/giu;
const WINDOWS_OR_UNC_PATH = /(?:^|[^\p{L}\p{N}])(?:[A-Za-z]:[\\/]|\\\\)/u;
const UNIX_ABSOLUTE_PATH = /(?:^|[^\p{L}\p{N}])\/(?!\/)/u;
const NETWORK_PATH = /\/\/{1,}(?=[^/\s])/u;
const LOCAL_DATA_URI = /(?:^|[^\p{L}\p{N}])(?:file|data):/iu;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/u;
function isAlphaNumeric(value) {
    return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}
function isTokenTerminator(value) {
    return value === undefined || /\s|[<>"'`]/u.test(value);
}
function hasNestedSchemeBefore(value, index) {
    return /(?:https?|mavis-preview):$/iu.test(value.slice(0, index));
}
function isAllowedQueryNetworkMarker(value, index) {
    const before = value.slice(0, index);
    if (!/[?#]/u.test(before) || !/[?&#=]$/u.test(before))
        return false;
    return /^server(?:[&#=]|$)/iu.test(value.slice(index + 2));
}
function hasDelimitedUnixPath(value) {
    for (let index = 0; index < value.length; index += 1) {
        if (value[index] !== '/')
            continue;
        const next = value[index + 1];
        if (next === '/') {
            // A nested URL's structural `//` and the exact `//server` query marker
            // are not local paths. Every other raw double slash fails closed.
            if (hasNestedSchemeBefore(value, index) || isAllowedQueryNetworkMarker(value, index)) {
                index += 1;
                continue;
            }
            return true;
        }
        if (index === 0)
            continue; // the URL's ordinary leading path slash
        const previous = value[index - 1];
        if (!isAlphaNumeric(previous))
            return true;
    }
    return false;
}
function hasForbiddenDataMarker(value) {
    const marker = /(?:file|data):/giu;
    let match;
    while ((match = marker.exec(value)) !== null) {
        if (match[0].toLowerCase() === 'file:')
            return true;
        const index = match.index;
        const before = value.slice(0, index);
        // `data:` is allowed as a URL path/query marker, but not as a
        // punctuation-delimited payload outside the query/fragment.
        if (/[?#]/u.test(before))
            continue;
        if (value[index - 1] === '/')
            continue;
        if (!isAlphaNumeric(value[index - 1]))
            return true;
    }
    return false;
}
function hasForbiddenBase64Marker(value) {
    const marker = /base64,/giu;
    let match;
    while ((match = marker.exec(value)) !== null) {
        const index = match.index;
        const before = value.slice(0, index);
        if (/[?#]/u.test(before))
            continue;
        if (value[index - 1] === '/')
            continue;
        if (!isAlphaNumeric(value[index - 1]))
            return true;
    }
    return false;
}
function candidateEnd(value, start) {
    let end = start;
    while (!isTokenTerminator(value[end]))
        end += 1;
    return end;
}
function candidateIsSafe(value, candidate) {
    const token = value.slice(candidate.start, candidate.end);
    if (token.includes('\\'))
        return false;
    const rest = value.slice(candidate.authorityEnd, candidate.end);
    if (WINDOWS_OR_UNC_PATH.test(rest))
        return false;
    if (hasForbiddenDataMarker(rest))
        return false;
    if (hasForbiddenBase64Marker(rest))
        return false;
    if (hasDelimitedUnixPath(rest))
        return false;
    return true;
}
function collectUrlCandidates(value, pattern) {
    const candidates = [];
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(value)) !== null) {
        const start = match.index;
        const authorityEnd = start + match[0].length;
        candidates.push({ start, authorityEnd, end: candidateEnd(value, authorityEnd) });
    }
    return candidates;
}
function fail(message) {
    throw new Error(message);
}
function object(value, name) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        fail(`${name} must be an object`);
    return value;
}
function exactKeys(value, name, allowed) {
    const allowedKeys = new Set(allowed);
    for (const key of Reflect.ownKeys(value)) {
        if (!Object.prototype.propertyIsEnumerable.call(value, key))
            continue;
        if (typeof key !== 'string' || !allowedKeys.has(key))
            fail(`${name} contains a forbidden field`);
    }
}
function boundedString(value, name, max) {
    if (typeof value !== 'string' || value.length > max)
        fail(`${name} must be a bounded string`);
    return value;
}
function maskAllowedUrlSpans(value) {
    const candidates = [
        ...collectUrlCandidates(value, HTTP_URL_AUTHORITY),
        ...collectUrlCandidates(value, MAVIS_PREVIEW_URL_AUTHORITY),
    ].filter((candidate) => candidateIsSafe(value, candidate));
    if (candidates.length === 0)
        return value;
    const masked = value.split('');
    for (const candidate of candidates) {
        for (let index = candidate.start; index < candidate.end; index += 1)
            masked[index] = ' ';
    }
    return masked.join('');
}
function string(value, name, max = 1024) {
    if (typeof value !== 'string' || value.length === 0 || value.length > max)
        fail(`${name} must be a non-empty string`);
    const scanValue = maskAllowedUrlSpans(value);
    if (WINDOWS_OR_UNC_PATH.test(scanValue) ||
        UNIX_ABSOLUTE_PATH.test(scanValue) ||
        NETWORK_PATH.test(scanValue) ||
        LOCAL_DATA_URI.test(scanValue) ||
        /base64,/iu.test(scanValue) ||
        scanValue.includes('<'))
        fail(`${name} contains a forbidden path, data, or XML value`);
    return value;
}
function opaque(value, name, max = 256) {
    const result = string(value, name, max);
    if (!OPAQUE_ID.test(result))
        fail(`${name} must be opaque`);
    return result;
}
function fileName(value, name) {
    const result = string(value, name, 256);
    if (/[\\/]/u.test(result))
        fail(`${name} must be a file name`);
    return result;
}
function integer(value, name, max = Number.MAX_SAFE_INTEGER) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max)
        fail(`${name} must be a non-negative integer`);
    return value;
}
function array(value, name, max) {
    if (!Array.isArray(value) || value.length > max)
        fail(`${name} must be an array of at most ${max} items`);
    return value;
}
function finiteRange(value, name, min, max) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
        fail(`${name} must be between ${min} and ${max}`);
    return value;
}
export function assertPreviewSourceV1(value) {
    const v = object(value, 'source');
    if (v.schema !== 'mavis.preview_source.v1')
        fail('source schema must be mavis.preview_source.v1');
    opaque(v.sourceId, 'sourceId');
    if (v.lineageId !== undefined &&
        (typeof v.lineageId !== 'string' || !/^lineage\.v1\.[a-f0-9]{64}$/u.test(v.lineageId))) {
        fail('lineageId must be a product-owned immutable lineage digest');
    }
    if (v.lineageScopeId !== undefined &&
        (typeof v.lineageScopeId !== 'string' ||
            !/^lineage_scope\.v1\.[a-f0-9]{64}$/u.test(v.lineageScopeId))) {
        fail('lineageScopeId must be a product-owned lineage scope digest');
    }
    fileName(v.fileName, 'fileName');
    string(v.mimeType, 'mimeType', 256);
    integer(v.sizeBytes, 'sizeBytes', PPTX_PREVIEW_LIMITS_V1.maxInputBytes);
    integer(v.modifiedAtMs, 'modifiedAtMs');
    if (typeof v.contentSha256 !== 'string' || !SHA256.test(v.contentSha256))
        fail('contentSha256 must be a SHA-256 digest');
}
export function assertPreviewSystemOpenClaimV1(value) {
    const v = object(value, 'systemOpenClaim');
    const allowedKeys = v.kind === 'source'
        ? new Set(['kind', 'sourceId', 'sessionId', 'contentSha256', 'generation', 'nonce'])
        : v.kind === 'asset'
            ? new Set(['kind', 'assetId', 'sessionId'])
            : null;
    if (!allowedKeys)
        fail('invalid system-open claim kind');
    for (const key of Reflect.ownKeys(v)) {
        if (typeof key !== 'string' || !allowedKeys.has(key))
            fail('system-open claim contains a forbidden field');
    }
    opaque(v.sessionId, 'systemOpenClaim.sessionId');
    if (v.kind === 'source') {
        opaque(v.sourceId, 'systemOpenClaim.sourceId');
        if (typeof v.contentSha256 !== 'string' || !SHA256.test(v.contentSha256))
            fail('systemOpenClaim.contentSha256 must be a SHA-256 digest');
        const generation = integer(v.generation, 'systemOpenClaim.generation');
        if (generation < 0)
            fail('systemOpenClaim.generation must be non-negative');
        opaque(v.nonce, 'systemOpenClaim.nonce');
        return;
    }
    opaque(v.assetId, 'systemOpenClaim.assetId');
}
export function assertPreviewErrorV1(value) {
    const v = object(value, 'error');
    if (v.schema !== 'mavis.preview_error.v1')
        fail('error schema must be mavis.preview_error.v1');
    if (typeof v.code !== 'string' || !ERROR_CODES.has(v.code))
        fail('invalid error code');
    string(v.message, 'message');
    if (typeof v.retryable !== 'boolean')
        fail('retryable must be boolean');
    if (v.backendId !== undefined && !isPreviewBackendIdV1(v.backendId))
        fail('invalid error backendId');
}
export function assertPreviewProgressEventV1(value) {
    const v = object(value, 'progress');
    if (v.schema !== 'mavis.preview_progress.v1')
        fail('progress schema must be mavis.preview_progress.v1');
    opaque(v.requestId, 'requestId');
    if (typeof v.stage !== 'string' ||
        !PROGRESS_STAGES.has(v.stage))
        fail('invalid progress stage');
    if (v.progress !== undefined)
        finiteRange(v.progress, 'progress', 0, 1);
    if (v.backendId !== undefined && !isPreviewBackendIdV1(v.backendId))
        fail('invalid progress backendId');
}
export function assertPreviewPptxPreflightMetadataV1(value) {
    const v = object(value, 'pptxPreflight');
    const features = array(v.features, 'pptxPreflight.features', PPTX_FEATURE_KINDS.size);
    const kinds = new Set();
    let hasFallback = false;
    let externalRelationshipCount = 0;
    for (const feature of features) {
        const item = object(feature, 'pptxPreflight.feature');
        if (typeof item.kind !== 'string' ||
            !PPTX_FEATURE_KINDS.has(item.kind)) {
            fail('pptxPreflight feature kind is invalid');
        }
        const kind = item.kind;
        if (kinds.has(kind))
            fail('pptxPreflight feature kind is duplicate');
        kinds.add(kind);
        const expectedSeverity = PPTX_FEATURE_SEVERITIES[kind];
        if (item.severity !== expectedSeverity)
            fail(`pptxPreflight feature severity for ${kind} must be ${expectedSeverity}`);
        const count = integer(item.count, 'pptxPreflight feature count');
        if (count === 0)
            fail('pptxPreflight feature count must be positive');
        if (expectedSeverity === 'fallback')
            hasFallback = true;
        if (kind === 'external-relationship')
            externalRelationshipCount = count;
    }
    for (const warning of array(v.warnings, 'pptxPreflight.warnings', 64))
        string(warning, 'pptxPreflight.warning');
    if (typeof v.requiresFidelityFallback !== 'boolean')
        fail('pptxPreflight requiresFidelityFallback must be boolean');
    if (v.requiresFidelityFallback !== hasFallback)
        fail('pptxPreflight fallback decision is inconsistent with feature severity');
    const declaredExternalCount = integer(v.externalRelationshipCount, 'pptxPreflight.externalRelationshipCount');
    if (declaredExternalCount !== externalRelationshipCount)
        fail('pptxPreflight externalRelationshipCount is inconsistent with features');
}
function assertPreviewSourceCounters(value, name) {
    const removed = integer(value.removedExternalRelationshipCount, `${name}.removedExternalRelationshipCount`);
    integer(value.rejectedEmbeddedResourceCount, `${name}.rejectedEmbeddedResourceCount`);
    if (value.pptxPreflight !== undefined) {
        assertPreviewPptxPreflightMetadataV1(value.pptxPreflight);
        if (value.pptxPreflight.externalRelationshipCount !== removed)
            fail(`${name}.pptxPreflight externalRelationshipCount must match removed relationships`);
    }
}
export function assertPreviewReadSourceValueV1(value) {
    const v = object(value, 'readSource');
    if (!(v.bytes instanceof Uint8Array))
        fail('readSource.bytes must be a Uint8Array');
    if (v.bytes.byteLength > PPTX_PREVIEW_LIMITS_V1.maxArtifactBytes)
        fail('readSource.bytes exceeds the preview artifact budget');
    assertPreviewSourceCounters(v, 'readSource');
    if (v.systemOpenClaim !== undefined) {
        assertPreviewSystemOpenClaimV1(v.systemOpenClaim);
        if (v.systemOpenClaim.kind !== 'source')
            fail('readSource.systemOpenClaim must be a source claim');
    }
}
export function assertPreviewStageSourceValueV1(value) {
    const v = object(value, 'stageSource');
    const allowedKeys = new Set([
        'removedExternalRelationshipCount',
        'rejectedEmbeddedResourceCount',
        'pptxPreflight',
        'systemOpenClaim',
    ]);
    for (const key of Reflect.ownKeys(v)) {
        if (!Object.prototype.propertyIsEnumerable.call(v, key))
            continue;
        if (typeof key === 'symbol')
            fail('stageSource enumerable symbol key is forbidden');
        if (!allowedKeys.has(key))
            fail(`stageSource.${key} is forbidden at the metadata boundary`);
    }
    assertPreviewSourceCounters(v, 'stageSource');
    if (v.systemOpenClaim !== undefined) {
        assertPreviewSystemOpenClaimV1(v.systemOpenClaim);
        if (v.systemOpenClaim.kind !== 'source')
            fail('stageSource.systemOpenClaim must be a source claim');
    }
}
export function assertPreviewRequestV1(value) {
    const v = object(value, 'request');
    if (v.schema !== 'mavis.preview_request.v1')
        fail('request schema must be mavis.preview_request.v1');
    opaque(v.requestId, 'requestId');
    opaque(v.sourceId, 'sourceId');
    if (v.intent !== 'view' && v.intent !== 'high-fidelity')
        fail('invalid intent');
    for (const capability of array(v.requiredCapabilities, 'requiredCapabilities', 32))
        if (typeof capability !== 'string' || !CAPABILITIES.has(capability))
            fail('invalid preview capability');
    for (const kind of array(v.preferredArtifactKinds, 'preferredArtifactKinds', 16))
        if (typeof kind !== 'string' || !ARTIFACT_KINDS.has(kind))
            fail('invalid artifact kind');
    const policy = object(v.policy, 'policy');
    if (typeof policy.allowComponentDownload !== 'boolean')
        fail('allowComponentDownload must be boolean');
    integer(policy.timeoutMs, 'timeoutMs', PPTX_PREVIEW_LIMITS_V1.nativeConversionTimeoutMs);
    integer(policy.maxInputBytes, 'maxInputBytes', PPTX_PREVIEW_LIMITS_V1.maxInputBytes);
    integer(policy.maxArtifactBytes, 'maxArtifactBytes', PPTX_PREVIEW_LIMITS_V1.maxArtifactBytes);
}
function assertSelection(value) {
    const v = object(value, 'selection');
    if (v.schema !== 'mavis.preview_selection.v1')
        fail('invalid selection schema');
    integer(v.pageIndex, 'selection.pageIndex');
    const rect = object(v.normalizedRect, 'selection.normalizedRect');
    for (const key of ['x', 'y', 'width', 'height']) {
        if (typeof rect[key] !== 'number' ||
            !Number.isFinite(rect[key]) ||
            rect[key] < 0 ||
            rect[key] > 1)
            fail('selection rectangle must be normalized');
    }
    if (rect.x + rect.width > 1 ||
        rect.y + rect.height > 1)
        fail('selection rectangle exceeds page');
    string(v.text, 'selection.text');
    if (v.semanticRef !== undefined) {
        const ref = object(v.semanticRef, 'selection.semanticRef');
        if (ref.scheme !== PPTX_DOM_BACKEND_VERSION_V1 && ref.scheme !== 'mavis-ppt-map.v1')
            fail('invalid semantic reference scheme');
        string(ref.nodeId, 'selection.nodeId');
        if (ref.nodeType !== undefined)
            string(ref.nodeType, 'selection.nodeType');
    }
}
export function assertPreviewArtifactManifestV1(value) {
    const v = object(value, 'manifest');
    if (v.schema !== 'mavis.preview_artifact.v1')
        fail('manifest schema must be mavis.preview_artifact.v1');
    const previewId = opaque(v.previewId, 'previewId');
    if (!PREVIEW_ARTIFACT_ID_V1.test(previewId))
        fail('previewId must be a 128-bit capability id');
    opaque(v.sourceId, 'sourceId');
    if (!isPreviewBackendIdV1(v.backendId))
        fail('invalid backendId');
    string(v.backendVersion, 'backendVersion');
    if (typeof v.kind !== 'string' || !ARTIFACT_KINDS.has(v.kind))
        fail('invalid artifact kind');
    if (v.pageCount !== undefined)
        integer(v.pageCount, 'pageCount');
    if (v.slideCount !== undefined)
        integer(v.slideCount, 'slideCount');
    const resources = array(v.resources, 'resources', 128);
    if ((v.kind === 'pdf.v1' || v.kind === 'paged-raster.v1') && resources.length === 0)
        fail(`${v.kind} requires an opaque preview resource URL`);
    let totalResourceBytes = 0;
    const resourceIds = new Set();
    for (const resource of resources) {
        const r = object(resource, 'resource');
        const resourceId = opaque(r.resourceId, 'resource.resourceId', 256);
        if (!PREVIEW_ARTIFACT_RESOURCE_ID_V1.test(resourceId))
            fail('resource.resourceId must be an opaque path segment');
        if (resourceIds.has(resourceId))
            fail('resource.resourceId must be unique');
        resourceIds.add(resourceId);
        fileName(r.name, 'resource.name');
        string(r.mediaType, 'resource.mediaType', 256);
        if (!isPreviewArtifactResourceUrlV1(r.url) ||
            r.url !== buildPreviewArtifactResourceUrlV1(previewId, resourceId))
            fail('invalid opaque preview resource URL');
        const sizeBytes = integer(r.sizeBytes, 'resource.sizeBytes', PPTX_PREVIEW_LIMITS_V1.maxArtifactBytes);
        totalResourceBytes += sizeBytes;
        if (totalResourceBytes > PPTX_PREVIEW_LIMITS_V1.maxArtifactBytes)
            fail('resources exceed max artifact bytes');
    }
    if (v.selectionSidecar !== undefined) {
        for (const selection of array(v.selectionSidecar, 'selectionSidecar', 4096))
            assertSelection(selection);
    }
    for (const warning of array(v.warnings, 'warnings', 64))
        string(warning, 'warning');
    for (const trace of array(v.fallbackTrace, 'fallbackTrace', 16)) {
        const t = object(trace, 'fallbackTrace');
        if (!isPreviewFallbackTargetIdV1(t.backendId))
            fail('invalid fallback backendId');
        if (t.outcome !== 'skipped' &&
            t.outcome !== 'unavailable' &&
            t.outcome !== 'failed' &&
            t.outcome !== 'cancelled')
            fail('invalid fallback outcome');
        if (typeof t.reasonCode !== 'string' || !ERROR_CODES.has(t.reasonCode))
            fail('invalid fallback reasonCode');
        string(t.message, 'fallbackTrace.message');
        integer(t.elapsedMs, 'fallbackTrace.elapsedMs');
    }
    integer(v.createdAtMs, 'createdAtMs');
}
function canonicalBackendId(value, field) {
    const backendId = normalizePreviewBackendIdV1(value);
    if (!backendId)
        fail(`invalid ${field}`);
    return backendId;
}
function canonicalFallbackTargetId(value) {
    if (value === 'system-open')
        return value;
    return canonicalBackendId(value, 'fallback backendId');
}
function canonicalPreviewErrorCode(value, field) {
    if (typeof value !== 'string' || !ERROR_CODES.has(value)) {
        fail(`invalid ${field}`);
    }
    return value;
}
function canonicalPreviewDiagnostic(value, field, code, backendId) {
    const message = string(value, field);
    return backendId === PPTX_DOM_BACKEND_ID_V1
        ? sanitizePptxRendererMessageV1(message)
        : safePreviewDiagnosticV1(code, message);
}
/** Decode selection input into the strict product-owned output contract. */
export function decodePreviewSelectionV1(value) {
    const v = object(value, 'selection');
    const rect = object(v.normalizedRect, 'selection.normalizedRect');
    const semanticRef = v.semanticRef === undefined
        ? undefined
        : (() => {
            const ref = object(v.semanticRef, 'selection.semanticRef');
            return {
                scheme: ref.scheme,
                nodeId: ref.nodeId,
                ...(ref.nodeType === undefined ? {} : { nodeType: ref.nodeType }),
            };
        })();
    const decoded = {
        schema: v.schema,
        pageIndex: v.pageIndex,
        normalizedRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        text: v.text,
        ...(semanticRef === undefined ? {} : { semanticRef }),
    };
    assertSelection(decoded);
    return decoded;
}
function decodePptxSelectionRect(value, name, requirePositiveSize) {
    const rect = object(value, name);
    exactKeys(rect, name, ['x', 'y', 'width', 'height']);
    const x = finiteRange(rect.x, `${name}.x`, 0, Number.MAX_SAFE_INTEGER);
    const y = finiteRange(rect.y, `${name}.y`, 0, Number.MAX_SAFE_INTEGER);
    const width = finiteRange(rect.width, `${name}.width`, 0, Number.MAX_SAFE_INTEGER);
    const height = finiteRange(rect.height, `${name}.height`, 0, Number.MAX_SAFE_INTEGER);
    if (requirePositiveSize && (width === 0 || height === 0))
        fail(`${name} must have positive size`);
    return { x, y, width, height };
}
function decodePptxMapRect(value, name, normalized) {
    const rect = object(value, name);
    exactKeys(rect, name, ['x', 'y', 'w', 'h']);
    const max = normalized ? 1 : Number.MAX_SAFE_INTEGER;
    const x = finiteRange(rect.x, `${name}.x`, 0, max);
    const y = finiteRange(rect.y, `${name}.y`, 0, max);
    const w = finiteRange(rect.w, `${name}.w`, 0, max);
    const h = finiteRange(rect.h, `${name}.h`, 0, max);
    if (normalized && (x + w > 1 || y + h > 1))
        fail(`${name} exceeds slide bounds`);
    return { x, y, w, h };
}
function decodePptxLocatorSourceRef(value) {
    const ref = object(value, 'resolvedElement.sourceRef');
    exactKeys(ref, 'resolvedElement.sourceRef', ['file', 'method']);
    const decoded = {};
    if (ref.file !== undefined) {
        const file = boundedString(ref.file, 'resolvedElement.sourceRef.file', 512);
        const normalized = file.replaceAll('\\', '/');
        if (!normalized ||
            normalized.startsWith('/') ||
            /^[A-Za-z]:\//u.test(normalized) ||
            normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..') ||
            /(?:^|[^A-Za-z])(?:https?|file|data):/iu.test(normalized)) {
            fail('resolvedElement.sourceRef.file must be a safe relative locator');
        }
        decoded.file = normalized;
    }
    if (ref.method !== undefined) {
        const method = boundedString(ref.method, 'resolvedElement.sourceRef.method', 128);
        if (!/^[A-Za-z_$][A-Za-z0-9_$.-]*$/u.test(method))
            fail('resolvedElement.sourceRef.method must be an identifier');
        decoded.method = method;
    }
    if (!decoded.file && !decoded.method)
        fail('resolvedElement.sourceRef must contain locator evidence');
    return decoded;
}
export function decodePptxSelectionResolutionRequestV1(value) {
    const request = object(value, 'pptxSelectionResolutionRequest');
    exactKeys(request, 'pptxSelectionResolutionRequest', [
        'schema',
        'sourceId',
        'contentSha256',
        'sourceGeneration',
        'slide',
        'selection',
        'instruction',
    ]);
    if (request.schema !== 'mavis.pptx_selection_resolution_request.v1')
        fail('invalid PPTX selection resolution request schema');
    const sourceId = opaque(request.sourceId, 'pptxSelectionResolutionRequest.sourceId');
    if (typeof request.contentSha256 !== 'string' || !SHA256.test(request.contentSha256))
        fail('pptxSelectionResolutionRequest.contentSha256 must be a SHA-256 digest');
    const sourceGeneration = integer(request.sourceGeneration, 'pptxSelectionResolutionRequest.sourceGeneration');
    const slide = object(request.slide, 'pptxSelectionResolutionRequest.slide');
    exactKeys(slide, 'pptxSelectionResolutionRequest.slide', ['index', 'number', 'width', 'height']);
    const index = integer(slide.index, 'pptxSelectionResolutionRequest.slide.index');
    const number = integer(slide.number, 'pptxSelectionResolutionRequest.slide.number');
    if (number === 0)
        fail('pptxSelectionResolutionRequest.slide.number must be positive');
    const width = finiteRange(slide.width, 'pptxSelectionResolutionRequest.slide.width', Number.MIN_VALUE, Number.MAX_SAFE_INTEGER);
    const height = finiteRange(slide.height, 'pptxSelectionResolutionRequest.slide.height', Number.MIN_VALUE, Number.MAX_SAFE_INTEGER);
    const selection = object(request.selection, 'pptxSelectionResolutionRequest.selection');
    exactKeys(selection, 'pptxSelectionResolutionRequest.selection', ['slideRect', 'text']);
    const slideRect = decodePptxSelectionRect(selection.slideRect, 'pptxSelectionResolutionRequest.selection.slideRect', true);
    if (slideRect.x + slideRect.width > width || slideRect.y + slideRect.height > height)
        fail('pptxSelectionResolutionRequest selection exceeds slide bounds');
    return {
        schema: request.schema,
        sourceId,
        contentSha256: request.contentSha256,
        sourceGeneration,
        slide: { index, number, width, height },
        selection: {
            slideRect,
            text: boundedString(selection.text, 'pptxSelectionResolutionRequest.selection.text', 20_000),
        },
        instruction: boundedString(request.instruction, 'pptxSelectionResolutionRequest.instruction', 20_000),
    };
}
const PPTX_ELEMENT_MAP_LOOKUP_OUTCOMES = new Set([
    'not-applicable',
    'missing',
    'too-large',
    'unsupported-schema',
    'invalid',
    'slide-missing',
    'no-match',
    'resolved',
]);
export function decodePptxSelectionResolutionV1(value) {
    const resolution = object(value, 'pptxSelectionResolution');
    exactKeys(resolution, 'pptxSelectionResolution', [
        'schema',
        'sourceId',
        'contentSha256',
        'sourceGeneration',
        'slideIndex',
        'elementMapLookup',
        'resolvedElement',
    ]);
    if (resolution.schema !== 'mavis.pptx_selection_resolution.v1')
        fail('invalid PPTX selection resolution schema');
    const sourceId = opaque(resolution.sourceId, 'pptxSelectionResolution.sourceId');
    if (typeof resolution.contentSha256 !== 'string' || !SHA256.test(resolution.contentSha256))
        fail('pptxSelectionResolution.contentSha256 must be a SHA-256 digest');
    const sourceGeneration = integer(resolution.sourceGeneration, 'pptxSelectionResolution.sourceGeneration');
    const slideIndex = integer(resolution.slideIndex, 'pptxSelectionResolution.slideIndex');
    const lookup = object(resolution.elementMapLookup, 'pptxSelectionResolution.elementMapLookup');
    exactKeys(lookup, 'pptxSelectionResolution.elementMapLookup', [
        'attempted',
        'outcome',
        'schema',
        'slideFound',
    ]);
    if (typeof lookup.attempted !== 'boolean')
        fail('elementMapLookup.attempted must be boolean');
    if (typeof lookup.outcome !== 'string' ||
        !PPTX_ELEMENT_MAP_LOOKUP_OUTCOMES.has(lookup.outcome)) {
        fail('elementMapLookup.outcome is invalid');
    }
    const elementMapLookup = {
        attempted: lookup.attempted,
        outcome: lookup.outcome,
        ...(lookup.schema === undefined
            ? {}
            : { schema: string(lookup.schema, 'elementMapLookup.schema', 128) }),
        ...(lookup.slideFound === undefined
            ? {}
            : typeof lookup.slideFound === 'boolean'
                ? { slideFound: lookup.slideFound }
                : fail('elementMapLookup.slideFound must be boolean')),
    };
    if (resolution.resolvedElement === undefined) {
        if (elementMapLookup.outcome === 'resolved')
            fail('resolved lookup requires an element');
        return {
            schema: resolution.schema,
            sourceId,
            contentSha256: resolution.contentSha256,
            sourceGeneration,
            slideIndex,
            elementMapLookup,
        };
    }
    if (elementMapLookup.outcome !== 'resolved')
        fail('resolved element requires resolved lookup');
    const element = object(resolution.resolvedElement, 'pptxSelectionResolution.resolvedElement');
    exactKeys(element, 'pptxSelectionResolution.resolvedElement', [
        'source',
        'elementId',
        'confidence',
        'score',
        'matchReasons',
        'slideNumber',
        'slideId',
        'slideTitle',
        'kind',
        'role',
        'text',
        'rectIn',
        'normalizedRect',
        'pptShapeId',
        'sourceRef',
        'selectionRectIn',
        'normalizedSelectionRect',
    ]);
    if (element.source !== 'mavis-ppt-map')
        fail('resolvedElement.source is invalid');
    if (element.confidence !== 'high' &&
        element.confidence !== 'medium' &&
        element.confidence !== 'low')
        fail('resolvedElement.confidence is invalid');
    const matchReasons = array(element.matchReasons, 'resolvedElement.matchReasons', 16).map((reason) => string(reason, 'resolvedElement.matchReason', 128));
    const pptShapeId = element.pptShapeId;
    if (pptShapeId !== undefined &&
        !((typeof pptShapeId === 'string' && pptShapeId.length > 0 && pptShapeId.length <= 128) ||
            (typeof pptShapeId === 'number' && Number.isSafeInteger(pptShapeId) && pptShapeId >= 0))) {
        fail('resolvedElement.pptShapeId is invalid');
    }
    const resolvedElement = {
        source: 'mavis-ppt-map',
        elementId: opaque(element.elementId, 'resolvedElement.elementId', 512),
        confidence: element.confidence,
        score: finiteRange(element.score, 'resolvedElement.score', 0, 1),
        matchReasons,
        slideNumber: integer(element.slideNumber, 'resolvedElement.slideNumber'),
        kind: string(element.kind, 'resolvedElement.kind', 128),
        ...(element.slideId === undefined
            ? {}
            : { slideId: opaque(element.slideId, 'resolvedElement.slideId', 256) }),
        ...(element.slideTitle === undefined
            ? {}
            : { slideTitle: boundedString(element.slideTitle, 'resolvedElement.slideTitle', 512) }),
        ...(element.role === undefined
            ? {}
            : { role: string(element.role, 'resolvedElement.role', 128) }),
        ...(element.text === undefined
            ? {}
            : { text: boundedString(element.text, 'resolvedElement.text', 2_000) }),
        ...(element.rectIn === undefined
            ? {}
            : { rectIn: decodePptxMapRect(element.rectIn, 'resolvedElement.rectIn', false) }),
        ...(element.normalizedRect === undefined
            ? {}
            : {
                normalizedRect: decodePptxMapRect(element.normalizedRect, 'resolvedElement.normalizedRect', true),
            }),
        ...(pptShapeId === undefined ? {} : { pptShapeId: pptShapeId }),
        ...(element.sourceRef === undefined
            ? {}
            : { sourceRef: decodePptxLocatorSourceRef(element.sourceRef) }),
        ...(element.selectionRectIn === undefined
            ? {}
            : {
                selectionRectIn: decodePptxMapRect(element.selectionRectIn, 'resolvedElement.selectionRectIn', false),
            }),
        ...(element.normalizedSelectionRect === undefined
            ? {}
            : {
                normalizedSelectionRect: decodePptxMapRect(element.normalizedSelectionRect, 'resolvedElement.normalizedSelectionRect', true),
            }),
    };
    return {
        schema: resolution.schema,
        sourceId,
        contentSha256: resolution.contentSha256,
        sourceGeneration,
        slideIndex,
        elementMapLookup,
        resolvedElement,
    };
}
/** Decode renderer errors without allowing dependency identity in output types. */
export function decodePreviewErrorV1(value) {
    const v = object(value, 'error');
    const code = canonicalPreviewErrorCode(v.code, 'error code');
    const backendId = v.backendId === undefined ? undefined : canonicalBackendId(v.backendId, 'error backendId');
    const decoded = {
        schema: v.schema,
        code,
        message: canonicalPreviewDiagnostic(v.message, 'message', code, backendId),
        retryable: v.retryable,
        ...(backendId === undefined ? {} : { backendId }),
    };
    assertPreviewErrorV1(decoded);
    return decoded;
}
/** Decode progress input into a fresh canonical event. */
export function decodePreviewProgressEventV1(value) {
    const v = object(value, 'progress');
    const decoded = {
        schema: v.schema,
        requestId: v.requestId,
        stage: v.stage,
        ...(v.progress === undefined ? {} : { progress: v.progress }),
        ...(v.backendId === undefined
            ? {}
            : { backendId: canonicalBackendId(v.backendId, 'progress backendId') }),
    };
    assertPreviewProgressEventV1(decoded);
    return decoded;
}
/** Decode one fallback entry; the returned object is always canonical. */
export function decodePreviewFallbackTraceEntryV1(value) {
    const v = object(value, 'fallbackTrace');
    const backendId = canonicalFallbackTargetId(v.backendId);
    const reasonCode = canonicalPreviewErrorCode(v.reasonCode, 'fallback reasonCode');
    const decoded = {
        backendId,
        outcome: v.outcome,
        reasonCode,
        message: canonicalPreviewDiagnostic(v.message, 'fallbackTrace.message', reasonCode, backendId),
        elapsedMs: v.elapsedMs,
    };
    if (decoded.outcome !== 'skipped' &&
        decoded.outcome !== 'unavailable' &&
        decoded.outcome !== 'failed' &&
        decoded.outcome !== 'cancelled')
        fail('invalid fallback outcome');
    string(decoded.message, 'fallbackTrace.message');
    integer(decoded.elapsedMs, 'fallbackTrace.elapsedMs');
    return decoded;
}
/** Decode a persisted/in-flight manifest into a deep canonical clone. */
export function decodePreviewArtifactManifestV1(value) {
    const v = object(value, 'manifest');
    const backendId = canonicalBackendId(v.backendId, 'backendId');
    const decoded = {
        schema: v.schema,
        previewId: v.previewId,
        sourceId: v.sourceId,
        backendId,
        backendVersion: v.backendVersion,
        kind: v.kind,
        ...(v.pageCount === undefined ? {} : { pageCount: v.pageCount }),
        ...(v.slideCount === undefined ? {} : { slideCount: v.slideCount }),
        resources: array(v.resources, 'resources', 128).map((resource) => {
            const item = object(resource, 'resource');
            return {
                resourceId: item.resourceId,
                name: item.name,
                mediaType: item.mediaType,
                url: item.url,
                sizeBytes: item.sizeBytes,
            };
        }),
        ...(v.selectionSidecar === undefined
            ? {}
            : {
                selectionSidecar: array(v.selectionSidecar, 'selectionSidecar', 4096).map(decodePreviewSelectionV1),
            }),
        warnings: array(v.warnings, 'warnings', 64).map((warning) => string(warning, 'warning')),
        fallbackTrace: array(v.fallbackTrace, 'fallbackTrace', 16).map(decodePreviewFallbackTraceEntryV1),
        createdAtMs: v.createdAtMs,
    };
    assertPreviewArtifactManifestV1(decoded);
    return decoded;
}
//# sourceMappingURL=document-preview.js.map