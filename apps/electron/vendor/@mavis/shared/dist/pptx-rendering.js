import { PPTX_DIAGNOSTIC_POLICY_BY_CODE_V1, } from './pptx-diagnostic-policy.generated.js';
import { PPTX_PREVIEW_LIMITS_V1, PPTX_PREVIEW_LIMITS_VERSION_V1, } from './pptx-preview-limits.generated.js';
import { PPTX_ANIMATION_EVALUATION_SCHEMA_V1, PPTX_CORE_SESSION_SCHEMA_V1, PPTX_CORE_STREAM_CHUNK_BYTES_V1, PPTX_CORE_STREAM_MAX_UNACKNOWLEDGED_V1, PPTX_CORE_STREAM_SCHEMA_V1, PPTX_DECK_SUMMARY_SCHEMA_V1, PPTX_DIAGNOSTIC_REPORT_SCHEMA_V1, PPTX_RENDER_RESOURCE_SCHEMA_V1, PPTX_RENDER_WIRE_LIMITS_V1, PPTX_SELECTION_RESOURCE_SCHEMA_V1, PPTX_SLIDE_ANIMATION_SCHEMA_V1, PPTX_SLIDE_NOTES_SCHEMA_V1, PPTX_SLIDE_RENDER_SCHEMA_V1, PPTX_SLIDE_SELECTION_MODEL_SCHEMA_V1, PPTX_SLIDE_SELECTION_MODEL_SCHEMA_V2, PPTX_TEXT_SEARCH_SCHEMA_V1, PPTX_TRANSITION_EVALUATION_SCHEMA_V1, SAFE_PACKAGE_HANDLE_SCHEMA_V1, } from './pptx-rendering-contract.js';
import { DIAGNOSTIC_REASON, MEDIA_TYPE, NOTES_DIAGNOSTIC_CODE, NOTES_LANGUAGE_HINT, NOTES_LIMITS_V1, PPTX_DIAGNOSTIC_STAGES_V1, PPT_DOCUMENT_HASH, PPT_DOCUMENT_ID, PPT_DOCUMENT_REVISION, PPT_NODE_ID, TEXT_SEARCH_LIMITS_V1, booleanValue, boundedNotesText, boundedSourceText, boundedStrings, boundedText, decodeNotesSourceAnchorV1, decodeRect, decodeRenderNode, decodeRenderResourceRef, deepFreezeWire, exactKeys, finiteInteger, nonNegativeInteger, opaque, partUri, pptIdentity, record, renderHash, renderNodeId, renderResourceId, sha256, } from './pptx-wire-validation.js';
export function decodePptxCoreCreateSessionInputV1(value) {
    const input = record(value, 'core session request');
    exactKeys(input, ['schema', 'requestId', 'sourceId'], 'core session request');
    if (input.schema !== PPTX_CORE_SESSION_SCHEMA_V1)
        throw new TypeError('invalid core session schema');
    return {
        schema: PPTX_CORE_SESSION_SCHEMA_V1,
        requestId: opaque(input.requestId, 'requestId'),
        sourceId: opaque(input.sourceId, 'sourceId'),
    };
}
export function decodePptxCoreSessionDescriptorV1(value) {
    const descriptor = record(value, 'core session descriptor');
    exactKeys(descriptor, [
        'schema',
        'coreSessionId',
        'sourceId',
        'sourceGeneration',
        'sourceSha256',
        'sourceSizeBytes',
        'nonce',
        'limitsVersion',
    ], 'core session descriptor');
    if (descriptor.schema !== PPTX_CORE_SESSION_SCHEMA_V1)
        throw new TypeError('invalid core session schema');
    if (descriptor.limitsVersion !== PPTX_PREVIEW_LIMITS_VERSION_V1) {
        throw new TypeError('invalid PPTX limits version');
    }
    return {
        schema: PPTX_CORE_SESSION_SCHEMA_V1,
        coreSessionId: opaque(descriptor.coreSessionId, 'coreSessionId'),
        sourceId: opaque(descriptor.sourceId, 'sourceId'),
        sourceGeneration: nonNegativeInteger(descriptor.sourceGeneration, 'sourceGeneration'),
        sourceSha256: sha256(descriptor.sourceSha256, 'sourceSha256'),
        sourceSizeBytes: nonNegativeInteger(descriptor.sourceSizeBytes, 'sourceSizeBytes', PPTX_PREVIEW_LIMITS_V1.maxInputBytes),
        nonce: opaque(descriptor.nonce, 'nonce'),
        limitsVersion: PPTX_PREVIEW_LIMITS_VERSION_V1,
    };
}
export function decodePptxCoreSessionCapabilityV1(value) {
    const capability = record(value, 'core session capability');
    exactKeys(capability, ['schema', 'coreSessionId', 'nonce'], 'core session capability');
    if (capability.schema !== PPTX_CORE_SESSION_SCHEMA_V1) {
        throw new TypeError('invalid core session schema');
    }
    return {
        schema: PPTX_CORE_SESSION_SCHEMA_V1,
        coreSessionId: opaque(capability.coreSessionId, 'coreSessionId'),
        nonce: opaque(capability.nonce, 'nonce'),
    };
}
export function decodePptxDeckSummaryV1(value) {
    const summary = record(value, 'PPTX deck summary');
    exactKeys(summary, [
        'schema',
        'documentId',
        'revision',
        'sourceSha256',
        'canonicalHash',
        'slideSize',
        'slideCount',
        'slides',
        'capabilities',
        'diagnosticCodes',
        'coverage',
    ], 'PPTX deck summary');
    if (summary.schema !== PPTX_DECK_SUMMARY_SCHEMA_V1) {
        throw new TypeError('invalid PPTX deck summary schema');
    }
    const slideSize = record(summary.slideSize, 'PPTX slide size');
    exactKeys(slideSize, ['width', 'height'], 'PPTX slide size');
    const width = nonNegativeInteger(slideSize.width, 'slide width');
    const height = nonNegativeInteger(slideSize.height, 'slide height');
    if (width === 0 || height === 0)
        throw new TypeError('PPTX slide size must be positive');
    const slideCount = nonNegativeInteger(summary.slideCount, 'slideCount', 10_000);
    if (!Array.isArray(summary.slides) || summary.slides.length !== slideCount) {
        throw new TypeError('PPTX slide summaries do not match slideCount');
    }
    const slideIds = new Set();
    const slides = summary.slides.map((candidate, index) => {
        const slide = decodePptxDeckSlideSummaryV1(candidate, index);
        if (slideIds.has(slide.nodeId))
            throw new TypeError('duplicate PPTX slide nodeId');
        slideIds.add(slide.nodeId);
        return slide;
    });
    return decodePptxDeckSummaryMetadataV1(summary, { width, height }, slideCount, slides);
}
export function decodePptxDeckSlideSummaryV1(candidate, index = 0) {
    const slide = record(candidate, `PPTX slide summary ${index}`);
    exactKeys(slide, [
        'nodeId',
        'authoredSlideId',
        'hidden',
        'title',
        'capabilities',
        'diagnosticCodes',
        'layoutCapability',
        'layoutCanonicalHash',
        'layoutDiagnosticCodes',
    ], `PPTX slide summary ${index}`);
    const nodeId = pptIdentity(slide.nodeId, PPT_NODE_ID, `slide ${index} nodeId`);
    const title = slide.title === null ? null : boundedText(slide.title, `slide ${index} title`, 512, true);
    if (slide.layoutCapability !== 'supported' &&
        slide.layoutCapability !== 'supported-static-approximation' &&
        slide.layoutCapability !== 'unsupported-terminal' &&
        slide.layoutCapability !== 'pending') {
        throw new TypeError(`slide ${index} layoutCapability is invalid`);
    }
    if (slide.layoutCanonicalHash !== null &&
        (typeof slide.layoutCanonicalHash !== 'string' ||
            !/^layout:v1:[a-f0-9]{16}$/u.test(slide.layoutCanonicalHash))) {
        throw new TypeError(`slide ${index} layoutCanonicalHash is invalid`);
    }
    if (slide.layoutCapability === 'pending' &&
        (slide.layoutCanonicalHash !== null ||
            !Array.isArray(slide.layoutDiagnosticCodes) ||
            slide.layoutDiagnosticCodes.length !== 0)) {
        throw new TypeError(`slide ${index} pending layout must not claim a result`);
    }
    return Object.freeze({
        nodeId,
        authoredSlideId: nonNegativeInteger(slide.authoredSlideId, `slide ${index} authoredSlideId`),
        hidden: booleanValue(slide.hidden, `slide ${index} hidden`),
        title,
        capabilities: boundedStrings(slide.capabilities, `slide ${index} capabilities`, 64),
        diagnosticCodes: boundedStrings(slide.diagnosticCodes, `slide ${index} diagnosticCodes`, 256),
        layoutCapability: slide.layoutCapability,
        layoutCanonicalHash: slide.layoutCanonicalHash,
        layoutDiagnosticCodes: boundedStrings(slide.layoutDiagnosticCodes, `slide ${index} layoutDiagnosticCodes`, 256),
    });
}
function decodePptxDeckSummaryMetadataV1(summary, { width, height }, slideCount, slides) {
    const coverage = record(summary.coverage, 'PPTX deck coverage');
    const coverageFields = [
        'sourceParts',
        'reachableSourceObjects',
        'modeledNodes',
        'requiredNodes',
        'requiredUnknownNodes',
        'preservedUnknownNodes',
        'recoverableUnknownNodes',
        'omittedVisibleNodes',
        'slideTerminalCount',
        'unclassifiedObjects',
        'unclassifiedDiagnostics',
        'unresolvedRequiredReferences',
        'nodesWithoutSourceAnchor',
    ];
    exactKeys(coverage, coverageFields, 'PPTX deck coverage');
    const decodedCoverage = Object.freeze(Object.fromEntries(coverageFields.map((field) => [field, nonNegativeInteger(coverage[field], field)])));
    return Object.freeze({
        schema: PPTX_DECK_SUMMARY_SCHEMA_V1,
        documentId: pptIdentity(summary.documentId, PPT_DOCUMENT_ID, 'documentId'),
        revision: pptIdentity(summary.revision, PPT_DOCUMENT_REVISION, 'revision'),
        sourceSha256: sha256(summary.sourceSha256, 'sourceSha256'),
        canonicalHash: pptIdentity(summary.canonicalHash, PPT_DOCUMENT_HASH, 'canonicalHash'),
        slideSize: Object.freeze({ width, height }),
        slideCount,
        slides: Object.freeze(slides),
        capabilities: boundedStrings(summary.capabilities, 'capabilities', 256),
        diagnosticCodes: boundedStrings(summary.diagnosticCodes, 'diagnosticCodes', 4_000),
        coverage: decodedCoverage,
    });
}
export function decodePptxCoreStreamMainMessageV1(value) {
    const message = record(value, 'core stream message');
    if (message.schema !== PPTX_CORE_STREAM_SCHEMA_V1)
        throw new TypeError('invalid core stream schema');
    const common = {
        schema: PPTX_CORE_STREAM_SCHEMA_V1,
        coreSessionId: opaque(message.coreSessionId, 'coreSessionId'),
        nonce: opaque(message.nonce, 'nonce'),
        sequence: nonNegativeInteger(message.sequence, 'sequence'),
    };
    switch (message.kind) {
        case 'hello':
            exactKeys(message, [
                'schema',
                'kind',
                'coreSessionId',
                'nonce',
                'sequence',
                'sourceGeneration',
                'sourceSha256',
                'sourceSizeBytes',
                'chunkBytes',
                'maxUnacknowledged',
                'limitsVersion',
            ], 'hello');
            if (common.sequence !== 0 ||
                message.chunkBytes !== PPTX_CORE_STREAM_CHUNK_BYTES_V1 ||
                message.maxUnacknowledged !== PPTX_CORE_STREAM_MAX_UNACKNOWLEDGED_V1 ||
                message.limitsVersion !== PPTX_PREVIEW_LIMITS_VERSION_V1)
                throw new TypeError('invalid hello negotiation');
            return {
                ...common,
                kind: 'hello',
                sequence: 0,
                sourceGeneration: nonNegativeInteger(message.sourceGeneration, 'sourceGeneration'),
                sourceSha256: sha256(message.sourceSha256, 'sourceSha256'),
                sourceSizeBytes: nonNegativeInteger(message.sourceSizeBytes, 'sourceSizeBytes', PPTX_PREVIEW_LIMITS_V1.maxInputBytes),
                chunkBytes: PPTX_CORE_STREAM_CHUNK_BYTES_V1,
                maxUnacknowledged: PPTX_CORE_STREAM_MAX_UNACKNOWLEDGED_V1,
                limitsVersion: PPTX_PREVIEW_LIMITS_VERSION_V1,
            };
        case 'chunk':
            exactKeys(message, ['schema', 'kind', 'coreSessionId', 'nonce', 'sequence', 'offset', 'bytes'], 'chunk');
            if (common.sequence === 0 ||
                !(message.bytes instanceof ArrayBuffer) ||
                message.bytes.byteLength === 0 ||
                message.bytes.byteLength > PPTX_CORE_STREAM_CHUNK_BYTES_V1)
                throw new TypeError('invalid source chunk');
            return {
                ...common,
                kind: 'chunk',
                offset: nonNegativeInteger(message.offset, 'offset', PPTX_PREVIEW_LIMITS_V1.maxInputBytes),
                bytes: message.bytes,
            };
        case 'end':
            exactKeys(message, ['schema', 'kind', 'coreSessionId', 'nonce', 'sequence', 'totalBytes', 'sourceSha256'], 'end');
            if (common.sequence === 0)
                throw new TypeError('invalid end sequence');
            return {
                ...common,
                kind: 'end',
                totalBytes: nonNegativeInteger(message.totalBytes, 'totalBytes', PPTX_PREVIEW_LIMITS_V1.maxInputBytes),
                sourceSha256: sha256(message.sourceSha256, 'sourceSha256'),
            };
        case 'abort': {
            exactKeys(message, ['schema', 'kind', 'coreSessionId', 'nonce', 'sequence', 'reason'], 'abort');
            const reasons = [
                'cancelled',
                'invalid_protocol',
                'source_mutated',
                'source_unavailable',
            ];
            if (!reasons.includes(message.reason))
                throw new TypeError('invalid abort reason');
            return {
                ...common,
                kind: 'abort',
                reason: message.reason,
            };
        }
        default:
            throw new TypeError('invalid core stream message kind');
    }
}
export function decodePptxCoreStreamWorkerMessageV1(value) {
    const message = record(value, 'core stream worker message');
    if (message.kind === 'ack') {
        exactKeys(message, ['schema', 'kind', 'coreSessionId', 'nonce', 'sequence'], 'ack');
        const decoded = decodePptxCoreStreamMainMessageV1({
            ...message,
            kind: 'abort',
            reason: 'cancelled',
        });
        return {
            schema: decoded.schema,
            kind: 'ack',
            coreSessionId: decoded.coreSessionId,
            nonce: decoded.nonce,
            sequence: decoded.sequence,
        };
    }
    const decoded = decodePptxCoreStreamMainMessageV1(message);
    if (decoded.kind !== 'abort')
        throw new TypeError('worker may send only ack or abort');
    return decoded;
}
export function decodeSafePackageHandleV1(value) {
    const handle = record(value, 'safe package handle');
    exactKeys(handle, [
        'schema',
        'packageId',
        'sourceSha256',
        'limitsVersion',
        'entries',
        'contentTypesEntry',
        'rootRelationshipsEntry',
        'state',
    ], 'safe package handle');
    if (handle.schema !== SAFE_PACKAGE_HANDLE_SCHEMA_V1 ||
        handle.limitsVersion !== PPTX_PREVIEW_LIMITS_VERSION_V1 ||
        handle.contentTypesEntry !== '[Content_Types].xml' ||
        handle.rootRelationshipsEntry !== '_rels/.rels')
        throw new TypeError('invalid safe package contract');
    if (!Array.isArray(handle.entries) || handle.entries.length > 4_000)
        throw new TypeError('invalid safe package entries');
    const exactParts = new Set();
    const foldedParts = new Set();
    let totalUncompressedBytes = 0;
    let mediaBytes = 0;
    const entries = handle.entries.map((raw, index) => {
        const entry = record(raw, `entry ${index}`);
        exactKeys(entry, [
            'partUri',
            'compressionMethod',
            'compressedSize',
            'uncompressedSize',
            'crc32',
            'category',
            'state',
        ], `entry ${index}`);
        const canonicalPartUri = partUri(entry.partUri);
        const foldedPartUri = canonicalPartUri.toLocaleLowerCase('en-US');
        if (exactParts.has(canonicalPartUri) || foldedParts.has(foldedPartUri)) {
            throw new TypeError('duplicate package part URI');
        }
        exactParts.add(canonicalPartUri);
        foldedParts.add(foldedPartUri);
        if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8)
            throw new TypeError('invalid compression method');
        if (!['xml', 'relationship', 'media', 'binary'].includes(entry.category) ||
            !['indexed', 'materializing', 'ready', 'terminal'].includes(entry.state))
            throw new TypeError('invalid entry classification');
        const compressedSize = nonNegativeInteger(entry.compressedSize, 'compressedSize', PPTX_PREVIEW_LIMITS_V1.maxInputBytes);
        const uncompressedSize = nonNegativeInteger(entry.uncompressedSize, 'uncompressedSize', PPTX_PREVIEW_LIMITS_V1.maxEntryUncompressedBytes);
        totalUncompressedBytes += uncompressedSize;
        if (entry.category === 'media')
            mediaBytes += uncompressedSize;
        if (totalUncompressedBytes > PPTX_PREVIEW_LIMITS_V1.maxTotalUncompressedBytes ||
            mediaBytes > PPTX_PREVIEW_LIMITS_V1.maxMediaBytes)
            throw new TypeError('safe package entries exceed resource limits');
        return {
            partUri: canonicalPartUri,
            compressionMethod: entry.compressionMethod,
            compressedSize,
            uncompressedSize,
            crc32: nonNegativeInteger(entry.crc32, 'crc32', 0xffffffff),
            category: entry.category,
            state: entry.state,
        };
    });
    if (!exactParts.has('[Content_Types].xml') || !exactParts.has('_rels/.rels'))
        throw new TypeError('safe package core entries are missing');
    if (!['indexed', 'materializing', 'ready', 'released'].includes(handle.state))
        throw new TypeError('invalid package state');
    return Object.freeze({
        schema: SAFE_PACKAGE_HANDLE_SCHEMA_V1,
        packageId: opaque(handle.packageId, 'packageId'),
        sourceSha256: sha256(handle.sourceSha256, 'sourceSha256'),
        limitsVersion: PPTX_PREVIEW_LIMITS_VERSION_V1,
        entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
        contentTypesEntry: '[Content_Types].xml',
        rootRelationshipsEntry: '_rels/.rels',
        state: handle.state,
    });
}
export function decodePptxSlideRenderV1(value, expected = {}) {
    const input = record(value, 'slide render');
    exactKeys(input, ['schema', 'documentId', 'revision', 'sourceSha256', 'slideIndex', 'layoutHash', 'tree'], 'slide render');
    if (input.schema !== PPTX_SLIDE_RENDER_SCHEMA_V1)
        throw new TypeError('invalid slide render schema');
    const tree = record(input.tree, 'render tree');
    exactKeys(tree, [
        'schema',
        'contractVersion',
        'slideId',
        'widthEmu',
        'heightEmu',
        'rootNodeId',
        'nodes',
        'resources',
        'diagnostics',
        'capability',
        'canonicalHash',
    ], 'render tree');
    if (tree.schema !== 'mavis.pptx_render_tree.v1' || tree.contractVersion !== 'pptx-render.v1')
        throw new TypeError('invalid RenderTree contract');
    if (!Array.isArray(tree.nodes) ||
        tree.nodes.length === 0 ||
        tree.nodes.length > PPTX_RENDER_WIRE_LIMITS_V1.maxNodes)
        throw new TypeError('RenderTree node budget exceeded');
    if (!Array.isArray(tree.resources) ||
        tree.resources.length > PPTX_RENDER_WIRE_LIMITS_V1.maxResources ||
        !Array.isArray(tree.diagnostics))
        throw new TypeError('RenderTree arrays are invalid');
    if (new TextEncoder().encode(JSON.stringify(tree)).byteLength >
        PPTX_RENDER_WIRE_LIMITS_V1.maxWireBytes)
        throw new TypeError('RenderTree wire budget exceeded');
    const budget = { commands: 0, glyphs: 0 };
    const nodes = tree.nodes.map((node, index) => decodeRenderNode(node, index, budget));
    const ids = new Set(nodes.map((node) => node.nodeId));
    if (ids.size !== nodes.length)
        throw new TypeError('RenderTree contains duplicate nodes');
    const paintOrders = new Set(nodes.map((node) => node.paintOrder));
    if (paintOrders.size !== nodes.length)
        throw new TypeError('RenderTree contains duplicate paint order');
    const rootNodeId = renderNodeId(tree.rootNodeId, 'rootNodeId');
    if (!ids.has(rootNodeId))
        throw new TypeError('RenderTree root node is missing');
    const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
    const root = nodeById.get(rootNodeId);
    if (root.kind !== 'group' || root.parentId !== null)
        throw new TypeError('RenderTree root must be the only parentless group');
    if (nodes.some((node) => node.nodeId !== rootNodeId && node.parentId === null))
        throw new TypeError('RenderTree contains another parentless node');
    for (const node of nodes) {
        if (node.parentId !== null && !ids.has(node.parentId))
            throw new TypeError('RenderTree parent is missing');
        for (const clipId of node.clipIds) {
            if (nodeById.get(clipId)?.kind !== 'clip')
                throw new TypeError('RenderTree clip is missing or not a clip node');
        }
        if (node.kind === 'group') {
            const childIds = node.childIds;
            if (new Set(childIds).size !== childIds.length)
                throw new TypeError('RenderTree group contains duplicate children');
            for (const childId of childIds) {
                const child = nodeById.get(childId);
                if (!child || child.parentId !== node.nodeId)
                    throw new TypeError('RenderTree child ownership is invalid');
            }
        }
        else if (node.parentId !== null) {
            const parent = nodeById.get(node.parentId);
            if (parent?.kind !== 'group' ||
                !parent.childIds.includes(node.nodeId)) {
                throw new TypeError('RenderTree parent ownership is invalid');
            }
        }
    }
    const visited = new Set();
    const visiting = new Set();
    const visit = (nodeId) => {
        if (visiting.has(nodeId))
            throw new TypeError('RenderTree contains a cycle');
        if (visited.has(nodeId))
            return;
        visiting.add(nodeId);
        const node = nodeById.get(nodeId);
        if (node.kind === 'group')
            for (const childId of node.childIds)
                visit(childId);
        visiting.delete(nodeId);
        visited.add(nodeId);
    };
    visit(rootNodeId);
    if (visited.size !== nodes.length)
        throw new TypeError('RenderTree contains unreachable nodes');
    const resources = tree.resources.map(decodeRenderResourceRef);
    if (new Set(resources.map((resource) => resource.resourceId)).size !== resources.length)
        throw new TypeError('RenderTree contains duplicate resources');
    const resourceIds = new Set(resources.map((resource) => resource.resourceId));
    const resourceById = new Map(resources.map((resource) => [resource.resourceId, resource]));
    for (const node of nodes) {
        if (node.kind === 'image' && !resourceIds.has(node.resourceId))
            throw new TypeError('image resource is undeclared');
        if (node.kind === 'image' &&
            Object.hasOwn(node, 'mediaResourceId') &&
            resourceById.get(node.mediaResourceId)?.kind !== 'media')
            throw new TypeError('image media resource is undeclared or not media');
        if (node.kind === 'path' || node.kind === 'glyphRun') {
            for (const fill of [
                node.fill,
                node.kind === 'path' && node.stroke !== null
                    ? node.stroke.fill
                    : null,
            ]) {
                if (fill &&
                    fill.kind === 'image' &&
                    !resourceIds.has(fill.resourceId)) {
                    throw new TypeError('paint resource is undeclared');
                }
            }
        }
    }
    const diagnostics = tree.diagnostics.map((diagnosticValue, index) => {
        const item = record(diagnosticValue, `diagnostic ${index}`);
        exactKeys(item, ['code', 'stage', 'severity', 'disposition', 'promotionImpact', 'sourceNodeId', 'reason'], `diagnostic ${index}`);
        const code = boundedText(item.code, 'diagnostic code', 256);
        const policy = PPTX_DIAGNOSTIC_POLICY_BY_CODE_V1[code];
        if (!policy ||
            item.stage !== policy.stage ||
            item.severity !== policy.severity ||
            item.disposition !== policy.disposition ||
            item.promotionImpact !== policy.promotionImpact) {
            throw new TypeError('render diagnostic policy is invalid');
        }
        return Object.freeze({
            code,
            stage: policy.stage,
            severity: policy.severity,
            disposition: policy.disposition,
            promotionImpact: policy.promotionImpact,
            sourceNodeId: item.sourceNodeId === null
                ? null
                : pptIdentity(item.sourceNodeId, PPT_NODE_ID, 'diagnostic sourceNodeId'),
            reason: boundedText(item.reason, 'diagnostic reason', 256),
        });
    });
    if (!['supported', 'supported-static-approximation', 'unsupported-terminal'].includes(String(tree.capability)))
        throw new TypeError('render capability is invalid');
    const decoded = deepFreezeWire({
        schema: PPTX_SLIDE_RENDER_SCHEMA_V1,
        documentId: pptIdentity(input.documentId, PPT_DOCUMENT_ID, 'documentId'),
        revision: pptIdentity(input.revision, PPT_DOCUMENT_REVISION, 'revision'),
        sourceSha256: sha256(input.sourceSha256, 'sourceSha256'),
        slideIndex: nonNegativeInteger(input.slideIndex, 'slideIndex', 100_000),
        layoutHash: pptIdentity(input.layoutHash, /^layout:v1:[a-f0-9]{16}$/u, 'layoutHash'),
        tree: {
            schema: 'mavis.pptx_render_tree.v1',
            contractVersion: 'pptx-render.v1',
            slideId: pptIdentity(tree.slideId, PPT_NODE_ID, 'slideId'),
            widthEmu: finiteInteger(tree.widthEmu, 'widthEmu', 1),
            heightEmu: finiteInteger(tree.heightEmu, 'heightEmu', 1),
            rootNodeId,
            nodes,
            resources: Object.freeze(resources),
            diagnostics: Object.freeze(diagnostics),
            capability: tree.capability,
            canonicalHash: renderHash(tree.canonicalHash),
        },
    });
    if ((expected.revision !== undefined && decoded.revision !== expected.revision) ||
        (expected.slideIndex !== undefined && decoded.slideIndex !== expected.slideIndex) ||
        (expected.sourceSha256 !== undefined && decoded.sourceSha256 !== expected.sourceSha256))
        throw new TypeError('stale slide render revision');
    return decoded;
}
export function decodePptxSlideRenderOutcomeV1(value, expected = {}) {
    const input = record(value, 'slide render outcome');
    if (input.kind === 'rendered') {
        exactKeys(input, ['kind', 'page'], 'slide render outcome');
        return Object.freeze({
            kind: 'rendered',
            page: decodePptxSlideRenderV1(input.page, expected),
        });
    }
    if (input.kind !== 'slide-terminal') {
        throw new TypeError('slide render outcome kind is invalid');
    }
    exactKeys(input, ['kind', 'slideIndex', 'diagnosticCodes'], 'slide render outcome');
    const slideIndex = nonNegativeInteger(input.slideIndex, 'slide terminal index', 10_000);
    if (expected.slideIndex !== undefined && slideIndex !== expected.slideIndex) {
        throw new TypeError('stale slide terminal outcome');
    }
    const diagnosticCodes = boundedStrings(input.diagnosticCodes, 'slide terminal diagnostic codes', PPTX_PREVIEW_LIMITS_V1.maxSlideDiagnostics).map((code) => {
        const policy = PPTX_DIAGNOSTIC_POLICY_BY_CODE_V1[code];
        if (!policy || policy.disposition !== 'slide-terminal') {
            throw new TypeError('slide terminal diagnostic code is invalid');
        }
        return code;
    });
    if (diagnosticCodes.length === 0) {
        throw new TypeError('slide terminal outcome must contain a diagnostic code');
    }
    return Object.freeze({ kind: 'slide-terminal', slideIndex, diagnosticCodes });
}
function diagnosticStatusV1(diagnostics) {
    if (diagnostics.some((diagnostic) => diagnostic.severity === 'terminal'))
        return 'terminal';
    if (diagnostics.some((diagnostic) => diagnostic.disposition === 'omit-node' ||
        diagnostic.disposition === 'static-approximation' ||
        diagnostic.disposition === 'preserve-only' ||
        diagnostic.promotionImpact === 'block-required' ||
        diagnostic.promotionImpact === 'block-security')) {
        return 'degraded';
    }
    return diagnostics.length === 0 ? 'clean' : 'observed';
}
export function decodePptxDiagnosticReportV1(value, expected = {}) {
    const input = record(value, 'PPTX diagnostic report');
    exactKeys(input, [
        'schema',
        'sourceSha256',
        'revision',
        'availability',
        'fidelity',
        'stageSummaries',
        'diagnostics',
        'truncated',
    ], 'PPTX diagnostic report');
    if (input.schema !== PPTX_DIAGNOSTIC_REPORT_SCHEMA_V1) {
        throw new TypeError('invalid PPTX diagnostic report schema');
    }
    const sourceSha256 = sha256(input.sourceSha256, 'diagnostic report sourceSha256');
    const revision = pptIdentity(input.revision, PPT_DOCUMENT_REVISION, 'diagnostic report revision');
    if ((expected.sourceSha256 !== undefined && sourceSha256 !== expected.sourceSha256) ||
        (expected.revision !== undefined && revision !== expected.revision)) {
        throw new TypeError('stale PPTX diagnostic report');
    }
    if (!['ready', 'partial', 'deck-terminal'].includes(String(input.availability))) {
        throw new TypeError('PPTX diagnostic availability is invalid');
    }
    if (!['exact', 'approximated', 'content-missing', 'unknown'].includes(String(input.fidelity))) {
        throw new TypeError('PPTX diagnostic fidelity is invalid');
    }
    if (!Array.isArray(input.diagnostics) ||
        input.diagnostics.length > PPTX_PREVIEW_LIMITS_V1.maxDeckDiagnostics + 1) {
        throw new RangeError('PPTX diagnostic report budget exceeded');
    }
    const diagnostics = input.diagnostics.map((candidate, index) => {
        const diagnostic = record(candidate, `PPTX diagnostic ${index}`);
        exactKeys(diagnostic, [
            'code',
            'stage',
            'severity',
            'scope',
            'disposition',
            'promotionImpact',
            'slideIndex',
            'sourceNodeId',
            'occurrenceCount',
            'reason',
        ], `PPTX diagnostic ${index}`);
        const code = boundedText(diagnostic.code, 'PPTX diagnostic code', 128);
        const policy = PPTX_DIAGNOSTIC_POLICY_BY_CODE_V1[code];
        if (!policy ||
            diagnostic.stage !== policy.stage ||
            diagnostic.severity !== policy.severity ||
            diagnostic.scope !== policy.scope ||
            diagnostic.disposition !== policy.disposition ||
            diagnostic.promotionImpact !== policy.promotionImpact) {
            throw new TypeError('PPTX diagnostic classification is invalid');
        }
        const occurrenceCount = nonNegativeInteger(diagnostic.occurrenceCount, 'PPTX diagnostic occurrenceCount');
        if (occurrenceCount === 0)
            throw new TypeError('PPTX diagnostic occurrenceCount is invalid');
        const reason = diagnostic.reason === null
            ? null
            : boundedText(diagnostic.reason, 'PPTX diagnostic reason', 128);
        if (reason !== null && !DIAGNOSTIC_REASON.test(reason)) {
            throw new TypeError('PPTX diagnostic reason must be a stable token');
        }
        return Object.freeze({
            code,
            stage: policy.stage,
            severity: policy.severity,
            scope: policy.scope,
            disposition: policy.disposition,
            promotionImpact: policy.promotionImpact,
            slideIndex: diagnostic.slideIndex === null
                ? null
                : nonNegativeInteger(diagnostic.slideIndex, 'PPTX diagnostic slideIndex', 10_000),
            sourceNodeId: diagnostic.sourceNodeId === null
                ? null
                : pptIdentity(diagnostic.sourceNodeId, PPT_NODE_ID, 'PPTX diagnostic sourceNodeId'),
            occurrenceCount,
            reason,
        });
    });
    if (!Array.isArray(input.stageSummaries) || input.stageSummaries.length !== 10) {
        throw new TypeError('PPTX diagnostic stage summaries are incomplete');
    }
    const stageSummaries = input.stageSummaries.map((candidate, index) => {
        const summary = record(candidate, `PPTX stage summary ${index}`);
        exactKeys(summary, ['stage', 'status', 'diagnosticCount', 'occurrenceCount', 'slideCount'], `PPTX stage summary ${index}`);
        const stage = PPTX_DIAGNOSTIC_STAGES_V1[index];
        if (summary.stage !== stage)
            throw new TypeError('PPTX diagnostic stages are out of order');
        const stageDiagnostics = diagnostics.filter((diagnostic) => diagnostic.stage === stage);
        const expectedStatus = diagnosticStatusV1(stageDiagnostics);
        if (summary.status !== expectedStatus) {
            throw new TypeError('PPTX diagnostic stage status is inconsistent');
        }
        const diagnosticCount = nonNegativeInteger(summary.diagnosticCount, 'PPTX stage diagnosticCount', PPTX_PREVIEW_LIMITS_V1.maxDeckDiagnostics + 1);
        const occurrenceCount = nonNegativeInteger(summary.occurrenceCount, 'PPTX stage occurrenceCount');
        const slideCount = nonNegativeInteger(summary.slideCount, 'PPTX stage slideCount', 10_000);
        if (diagnosticCount !== stageDiagnostics.length ||
            occurrenceCount !==
                stageDiagnostics.reduce((total, diagnostic) => total + diagnostic.occurrenceCount, 0) ||
            slideCount !==
                new Set(stageDiagnostics.flatMap((diagnostic) => diagnostic.slideIndex === null ? [] : [diagnostic.slideIndex])).size) {
            throw new TypeError('PPTX diagnostic stage summary is inconsistent');
        }
        return Object.freeze({
            stage,
            status: expectedStatus,
            diagnosticCount,
            occurrenceCount,
            slideCount,
        });
    });
    const truncated = booleanValue(input.truncated, 'PPTX diagnostic report truncated');
    if (truncated !==
        diagnostics.some((diagnostic) => diagnostic.code === 'PPTX-S08-DIAGNOSTIC-BUDGET-EXCEEDED')) {
        throw new TypeError('PPTX diagnostic truncation state is inconsistent');
    }
    return deepFreezeWire({
        schema: PPTX_DIAGNOSTIC_REPORT_SCHEMA_V1,
        sourceSha256,
        revision,
        availability: input.availability,
        fidelity: input.fidelity,
        stageSummaries,
        diagnostics,
        truncated,
    });
}
export function decodePptxRenderResourceV1(value, expected = {}) {
    const input = record(value, 'render resource');
    exactKeys(input, [
        'schema',
        'revision',
        'renderHash',
        'resourceId',
        'mediaType',
        'byteLength',
        'sha256',
        'bytes',
    ], 'render resource');
    if (input.schema !== PPTX_RENDER_RESOURCE_SCHEMA_V1 || !(input.bytes instanceof ArrayBuffer))
        throw new TypeError('invalid render resource payload');
    const byteLength = nonNegativeInteger(input.byteLength, 'resource byteLength', PPTX_RENDER_WIRE_LIMITS_V1.maxResourceBytes);
    if (input.bytes.byteLength !== byteLength ||
        typeof input.mediaType !== 'string' ||
        !MEDIA_TYPE.test(input.mediaType))
        throw new TypeError('render resource metadata mismatch');
    const decoded = Object.freeze({
        schema: PPTX_RENDER_RESOURCE_SCHEMA_V1,
        revision: pptIdentity(input.revision, PPT_DOCUMENT_REVISION, 'revision'),
        renderHash: renderHash(input.renderHash),
        resourceId: renderResourceId(input.resourceId),
        mediaType: input.mediaType,
        byteLength,
        sha256: sha256(input.sha256, 'resource sha256'),
        bytes: input.bytes,
    });
    if ((expected.revision !== undefined && decoded.revision !== expected.revision) ||
        (expected.renderHash !== undefined && decoded.renderHash !== expected.renderHash) ||
        (expected.resourceId !== undefined && decoded.resourceId !== expected.resourceId))
        throw new TypeError('stale render resource revision');
    return decoded;
}
export function decodePptxSlideNotesV1(value, expected = {}) {
    const input = record(value, 'speaker notes');
    exactKeys(input, [
        'schema',
        'revision',
        'slideId',
        'state',
        'plainText',
        'paragraphs',
        'sourceAnchor',
        'diagnostics',
    ], 'speaker notes');
    if (input.schema !== PPTX_SLIDE_NOTES_SCHEMA_V1) {
        throw new TypeError('invalid speaker notes schema');
    }
    if (!['available', 'empty', 'unsupported'].includes(String(input.state))) {
        throw new TypeError('invalid speaker notes state');
    }
    const revision = pptIdentity(input.revision, PPT_DOCUMENT_REVISION, 'notes revision');
    const slideId = pptIdentity(input.slideId, PPT_NODE_ID, 'notes slideId');
    const plainText = boundedNotesText(input.plainText, 'speaker notes text', NOTES_LIMITS_V1.maxTextBytes);
    if (!Array.isArray(input.paragraphs) || input.paragraphs.length > NOTES_LIMITS_V1.maxParagraphs) {
        throw new RangeError('speaker notes paragraph budget exceeded');
    }
    const paragraphs = input.paragraphs.map((candidate, index) => {
        const paragraph = record(candidate, `speaker notes paragraph ${index}`);
        exactKeys(paragraph, [
            'sourceParagraphIndex',
            'plainText',
            'hardBreakOffsets',
            'languageHint',
            'directionHint',
            'sourceAnchor',
        ], `speaker notes paragraph ${index}`);
        const paragraphText = boundedNotesText(paragraph.plainText, `speaker notes paragraph ${index}`, NOTES_LIMITS_V1.maxParagraphBytes);
        if (!Array.isArray(paragraph.hardBreakOffsets) ||
            paragraph.hardBreakOffsets.length > paragraphText.length) {
            throw new TypeError(`speaker notes paragraph ${index} hard breaks are invalid`);
        }
        const hardBreakOffsets = paragraph.hardBreakOffsets.map((offset, offsetIndex) => {
            const decoded = nonNegativeInteger(offset, `speaker notes paragraph ${index} hard break ${offsetIndex}`, paragraphText.length);
            if (paragraphText[decoded] !== '\n') {
                throw new TypeError(`speaker notes paragraph ${index} hard break is not a newline`);
            }
            return decoded;
        });
        if (hardBreakOffsets.some((offset, offsetIndex) => offsetIndex > 0 && hardBreakOffsets[offsetIndex - 1] >= offset)) {
            throw new TypeError(`speaker notes paragraph ${index} hard breaks are not ordered`);
        }
        const languageHint = paragraph.languageHint === null
            ? null
            : boundedNotesText(paragraph.languageHint, `speaker notes paragraph ${index} language`, 64);
        if (languageHint !== null && !NOTES_LANGUAGE_HINT.test(languageHint)) {
            throw new TypeError(`speaker notes paragraph ${index} language is invalid`);
        }
        if (!['ltr', 'rtl', 'auto'].includes(String(paragraph.directionHint))) {
            throw new TypeError(`speaker notes paragraph ${index} direction is invalid`);
        }
        if (nonNegativeInteger(paragraph.sourceParagraphIndex, `speaker notes paragraph ${index} source index`, NOTES_LIMITS_V1.maxParagraphs) !== index) {
            throw new TypeError('speaker notes paragraph source order is invalid');
        }
        return Object.freeze({
            sourceParagraphIndex: index,
            plainText: paragraphText,
            hardBreakOffsets: Object.freeze(hardBreakOffsets),
            languageHint,
            directionHint: paragraph.directionHint,
            sourceAnchor: decodeNotesSourceAnchorV1(paragraph.sourceAnchor, `speaker notes paragraph ${index} source anchor`),
        });
    });
    if (!Array.isArray(input.diagnostics) ||
        input.diagnostics.length > NOTES_LIMITS_V1.maxDiagnostics) {
        throw new RangeError('speaker notes diagnostic budget exceeded');
    }
    const diagnostics = input.diagnostics.map((candidate, index) => {
        const item = record(candidate, `speaker notes diagnostic ${index}`);
        exactKeys(item, ['code', 'reason', 'anchorKind', 'count'], `speaker notes diagnostic ${index}`);
        const code = boundedText(item.code, `speaker notes diagnostic ${index} code`, 256);
        if (!NOTES_DIAGNOSTIC_CODE.test(code))
            throw new TypeError('speaker notes diagnostic code is invalid');
        if (!['slide', 'relationship', 'notes-slide', 'body-placeholder', 'paragraph'].includes(String(item.anchorKind))) {
            throw new TypeError('speaker notes diagnostic anchor kind is invalid');
        }
        return Object.freeze({
            code,
            reason: boundedText(item.reason, `speaker notes diagnostic ${index} reason`, 256),
            anchorKind: item.anchorKind,
            count: nonNegativeInteger(item.count, `speaker notes diagnostic ${index} count`, 100_000),
        });
    });
    const state = input.state;
    if (state === 'unsupported') {
        if (plainText !== '' || paragraphs.length !== 0 || diagnostics.length === 0) {
            throw new TypeError('unsupported speaker notes state is inconsistent');
        }
    }
    else {
        if (diagnostics.length !== 0)
            throw new TypeError('readable speaker notes contain diagnostics');
        if (paragraphs.map((paragraph) => paragraph.plainText).join('\n') !== plainText) {
            throw new TypeError('speaker notes paragraph text does not match aggregate text');
        }
        if ((state === 'available') !== plainText.length > 0) {
            throw new TypeError('speaker notes state does not match text');
        }
    }
    const decoded = deepFreezeWire({
        schema: PPTX_SLIDE_NOTES_SCHEMA_V1,
        revision,
        slideId,
        state,
        plainText,
        paragraphs: Object.freeze(paragraphs),
        sourceAnchor: input.sourceAnchor === null
            ? null
            : decodeNotesSourceAnchorV1(input.sourceAnchor, 'speaker notes source anchor'),
        diagnostics: Object.freeze(diagnostics),
    });
    if ((expected.revision !== undefined && decoded.revision !== expected.revision) ||
        (expected.slideId !== undefined && decoded.slideId !== expected.slideId)) {
        throw new TypeError('stale speaker notes revision');
    }
    return decoded;
}
export function decodePptxTextSearchResultV1(value, expected = {}) {
    const input = record(value, 'text search result');
    exactKeys(input, ['schema', 'revision', 'query', 'matchCount', 'truncated', 'matches'], 'text search result');
    if (input.schema !== PPTX_TEXT_SEARCH_SCHEMA_V1 || typeof input.truncated !== 'boolean') {
        throw new TypeError('invalid text search result');
    }
    const revision = pptIdentity(input.revision, PPT_DOCUMENT_REVISION, 'search revision');
    const query = boundedText(input.query, 'search query', TEXT_SEARCH_LIMITS_V1.maxQueryLength);
    if (query.trim() !== query)
        throw new TypeError('search query must be trimmed');
    if (!Array.isArray(input.matches) || input.matches.length > TEXT_SEARCH_LIMITS_V1.maxMatches) {
        throw new RangeError('text search match budget exceeded');
    }
    const matches = input.matches.map((candidate, index) => {
        const match = record(candidate, `text search match ${index}`);
        exactKeys(match, ['slideId', 'slideIndex', 'sourceNodeId', 'sourceKind', 'text', 'matchStart', 'matchLength'], `text search match ${index}`);
        if (!['shape-text', 'table-cell', 'chart-text', 'smartart-text', 'formula-text'].includes(String(match.sourceKind))) {
            throw new TypeError('text search source kind is invalid');
        }
        const text = boundedText(match.text, `text search match ${index} text`, TEXT_SEARCH_LIMITS_V1.maxMatchTextLength);
        const matchStart = nonNegativeInteger(match.matchStart, `text search match ${index} start`, text.length);
        const matchLength = nonNegativeInteger(match.matchLength, `text search match ${index} length`, TEXT_SEARCH_LIMITS_V1.maxQueryLength);
        if (matchLength === 0 || matchStart + matchLength > text.length) {
            throw new TypeError('text search match range is invalid');
        }
        return Object.freeze({
            slideId: pptIdentity(match.slideId, PPT_NODE_ID, `text search match ${index} slideId`),
            slideIndex: nonNegativeInteger(match.slideIndex, `text search match ${index} slideIndex`, 100_000),
            sourceNodeId: pptIdentity(match.sourceNodeId, PPT_NODE_ID, `text search match ${index} sourceNodeId`),
            sourceKind: match.sourceKind,
            text,
            matchStart,
            matchLength,
        });
    });
    const matchCount = nonNegativeInteger(input.matchCount, 'text search matchCount', 1_000_000);
    if (matchCount < matches.length || input.truncated !== matchCount > matches.length) {
        throw new TypeError('text search truncation metadata is inconsistent');
    }
    const decoded = deepFreezeWire({
        schema: PPTX_TEXT_SEARCH_SCHEMA_V1,
        revision,
        query,
        matchCount,
        truncated: input.truncated,
        matches: Object.freeze(matches),
    });
    if ((expected.revision !== undefined && decoded.revision !== expected.revision) ||
        (expected.query !== undefined && decoded.query !== expected.query)) {
        throw new TypeError('stale text search result');
    }
    return decoded;
}
export function decodePptxSlideSelectionModelV1(value, expected = {}) {
    const input = record(value, 'slide selection model');
    exactKeys(input, ['schema', 'revision', 'slideId', 'slideIndex', 'widthEmu', 'heightEmu', 'nodes'], 'slide selection model');
    if (input.schema !== PPTX_SLIDE_SELECTION_MODEL_SCHEMA_V1 || !Array.isArray(input.nodes)) {
        throw new TypeError('invalid slide selection model');
    }
    if (input.nodes.length > PPTX_RENDER_WIRE_LIMITS_V1.maxNodes) {
        throw new RangeError('slide selection node budget exceeded');
    }
    const nodes = input.nodes.map((candidate, index) => {
        const node = record(candidate, `slide selection node ${index}`);
        exactKeys(node, [
            'nodeId',
            'nodeType',
            'bounds',
            'rotation60000',
            'flipH',
            'flipV',
            'text',
            'sourceAnchor',
            'resource',
        ], `slide selection node ${index}`);
        if (!['shape', 'picture', 'table', 'group', 'chart'].includes(String(node.nodeType))) {
            throw new TypeError('slide selection node type is invalid');
        }
        const bounds = decodeRect(node.bounds, `slide selection node ${index} bounds`);
        const rotation60000 = finiteInteger(node.rotation60000, `slide selection node ${index} rotation`, -2_147_483_648, 2_147_483_647);
        if (typeof node.flipH !== 'boolean' || typeof node.flipV !== 'boolean') {
            throw new TypeError('slide selection transform flags are invalid');
        }
        const text = node.text === null
            ? null
            : boundedSourceText(node.text, `slide selection node ${index} text`, 64 * 1024);
        let resource = null;
        if (node.resource !== null) {
            const rawResource = record(node.resource, `slide selection node ${index} resource`);
            exactKeys(rawResource, ['resourceId', 'partUri', 'mediaType', 'crop'], `slide selection node ${index} resource`);
            const rawCrop = record(rawResource.crop, `slide selection node ${index} crop`);
            exactKeys(rawCrop, ['top', 'right', 'bottom', 'left'], `slide selection node ${index} crop`);
            if (typeof rawResource.mediaType !== 'string' || !MEDIA_TYPE.test(rawResource.mediaType)) {
                throw new TypeError('slide selection resource media type is invalid');
            }
            resource = Object.freeze({
                resourceId: renderResourceId(rawResource.resourceId),
                partUri: partUri(rawResource.partUri),
                mediaType: rawResource.mediaType,
                crop: Object.freeze({
                    top: finiteInteger(rawCrop.top, 'selection crop top', 0, 100_000),
                    right: finiteInteger(rawCrop.right, 'selection crop right', 0, 100_000),
                    bottom: finiteInteger(rawCrop.bottom, 'selection crop bottom', 0, 100_000),
                    left: finiteInteger(rawCrop.left, 'selection crop left', 0, 100_000),
                }),
            });
        }
        if ((node.nodeType === 'picture') !== (resource !== null)) {
            throw new TypeError('slide selection picture resource is inconsistent');
        }
        return Object.freeze({
            nodeId: pptIdentity(node.nodeId, PPT_NODE_ID, `slide selection node ${index} id`),
            nodeType: node.nodeType,
            bounds,
            rotation60000,
            flipH: node.flipH,
            flipV: node.flipV,
            text,
            sourceAnchor: decodeNotesSourceAnchorV1(node.sourceAnchor, `slide selection node ${index} source anchor`),
            resource,
        });
    });
    if (new Set(nodes.map((node) => node.nodeId)).size !== nodes.length) {
        throw new TypeError('slide selection nodes contain duplicate ids');
    }
    const decoded = deepFreezeWire({
        schema: PPTX_SLIDE_SELECTION_MODEL_SCHEMA_V1,
        revision: pptIdentity(input.revision, PPT_DOCUMENT_REVISION, 'selection revision'),
        slideId: pptIdentity(input.slideId, PPT_NODE_ID, 'selection slideId'),
        slideIndex: nonNegativeInteger(input.slideIndex, 'selection slideIndex', 100_000),
        widthEmu: finiteInteger(input.widthEmu, 'selection width', 1),
        heightEmu: finiteInteger(input.heightEmu, 'selection height', 1),
        nodes: Object.freeze(nodes),
    });
    if ((expected.revision !== undefined && decoded.revision !== expected.revision) ||
        (expected.slideIndex !== undefined && decoded.slideIndex !== expected.slideIndex)) {
        throw new TypeError('stale slide selection model');
    }
    return decoded;
}
const PPTX_SELECTION_MODEL_MAX_WIRE_BYTES_V2 = 4 * 1024 * 1024;
function decodeSelectionCropV2(value, name) {
    const crop = record(value, name);
    exactKeys(crop, ['top', 'right', 'bottom', 'left'], name);
    return Object.freeze({
        top: finiteInteger(crop.top, `${name} top`, 0, 100_000),
        right: finiteInteger(crop.right, `${name} right`, 0, 100_000),
        bottom: finiteInteger(crop.bottom, `${name} bottom`, 0, 100_000),
        left: finiteInteger(crop.left, `${name} left`, 0, 100_000),
    });
}
function rectContainsRect(parent, child) {
    return (child.x >= parent.x &&
        child.y >= parent.y &&
        child.x + child.width <= parent.x + parent.width &&
        child.y + child.height <= parent.y + parent.height);
}
export function decodePptxSlideSelectionModelV2(value, expected = {}) {
    const input = record(value, 'slide selection model');
    exactKeys(input, ['schema', 'revision', 'slideId', 'slideIndex', 'widthEmu', 'heightEmu', 'nodes'], 'slide selection model');
    if (input.schema !== PPTX_SLIDE_SELECTION_MODEL_SCHEMA_V2 || !Array.isArray(input.nodes)) {
        throw new TypeError('invalid slide selection model');
    }
    if (new TextEncoder().encode(JSON.stringify(input)).byteLength >
        PPTX_SELECTION_MODEL_MAX_WIRE_BYTES_V2) {
        throw new TypeError('slide selection wire budget exceeded');
    }
    if (input.nodes.length > PPTX_RENDER_WIRE_LIMITS_V1.maxNodes) {
        throw new RangeError('slide selection node budget exceeded');
    }
    const nodes = input.nodes.map((candidate, index) => {
        const node = record(candidate, `slide selection node ${index}`);
        exactKeys(node, [
            'nodeId',
            'nodeType',
            'paintOrder',
            'bounds',
            'rotation60000',
            'flipH',
            'flipV',
            'text',
            'sourceAnchor',
            'tableCells',
            'resource',
        ], `slide selection node ${index}`);
        if (!['shape', 'picture', 'table', 'group', 'chart'].includes(String(node.nodeType))) {
            throw new TypeError('slide selection node type is invalid');
        }
        const bounds = decodeRect(node.bounds, `slide selection node ${index} bounds`);
        if (bounds.width <= 0 || bounds.height <= 0) {
            throw new TypeError('slide selection node bounds must have positive area');
        }
        if (!Array.isArray(node.tableCells) ||
            node.tableCells.length > PPTX_RENDER_WIRE_LIMITS_V1.maxNodes) {
            throw new TypeError('slide selection table cells are invalid');
        }
        const tableCells = node.tableCells.map((candidateCell, cellIndex) => {
            const cell = record(candidateCell, `slide selection table cell ${cellIndex}`);
            exactKeys(cell, ['row', 'column', 'rowSpan', 'columnSpan', 'bounds', 'text'], `slide selection table cell ${cellIndex}`);
            const cellBounds = decodeRect(cell.bounds, `slide selection table cell ${cellIndex} bounds`);
            if (cellBounds.width <= 0 ||
                cellBounds.height <= 0 ||
                !rectContainsRect(bounds, cellBounds)) {
                throw new TypeError('slide selection table cell bounds are outside the table');
            }
            const row = nonNegativeInteger(cell.row, `slide selection table cell ${cellIndex} row`, 100_000);
            const column = nonNegativeInteger(cell.column, `slide selection table cell ${cellIndex} column`, 100_000);
            const rowSpan = finiteInteger(cell.rowSpan, `slide selection table cell ${cellIndex} row span`, 1, 100_000);
            const columnSpan = finiteInteger(cell.columnSpan, `slide selection table cell ${cellIndex} column span`, 1, 100_000);
            if (row + rowSpan > 100_000 || column + columnSpan > 100_000) {
                throw new TypeError('slide selection table cell span is invalid');
            }
            const text = cell.text === null
                ? null
                : boundedSourceText(cell.text, `slide selection table cell ${cellIndex} text`, 64 * 1024);
            return Object.freeze({
                row,
                column,
                rowSpan,
                columnSpan,
                bounds: cellBounds,
                text,
            });
        });
        if (node.nodeType !== 'table' && tableCells.length > 0) {
            throw new TypeError('slide selection table cells require a table node');
        }
        if (new Set(tableCells.map((cell) => `${cell.row}:${cell.column}`)).size !== tableCells.length) {
            throw new TypeError('slide selection table cells contain duplicate coordinates');
        }
        const occupiedTableCells = new Set();
        for (const cell of tableCells) {
            if (cell.rowSpan * cell.columnSpan > PPTX_RENDER_WIRE_LIMITS_V1.maxNodes ||
                occupiedTableCells.size + cell.rowSpan * cell.columnSpan >
                    PPTX_RENDER_WIRE_LIMITS_V1.maxNodes) {
                throw new RangeError('slide selection table cell span budget exceeded');
            }
            for (let row = cell.row; row < cell.row + cell.rowSpan; row += 1) {
                for (let column = cell.column; column < cell.column + cell.columnSpan; column += 1) {
                    const coordinate = `${row}:${column}`;
                    if (occupiedTableCells.has(coordinate)) {
                        throw new TypeError('slide selection table cell spans overlap');
                    }
                    occupiedTableCells.add(coordinate);
                }
            }
        }
        let resource = null;
        if (node.resource !== null) {
            const rawResource = record(node.resource, `slide selection node ${index} resource`);
            if (rawResource.state === 'embedded') {
                exactKeys(rawResource, ['state', 'resourceId', 'partUri', 'mediaType', 'crop'], `slide selection node ${index} resource`);
                if (typeof rawResource.mediaType !== 'string' || !MEDIA_TYPE.test(rawResource.mediaType)) {
                    throw new TypeError('slide selection resource media type is invalid');
                }
                resource = Object.freeze({
                    state: 'embedded',
                    resourceId: renderResourceId(rawResource.resourceId),
                    partUri: partUri(rawResource.partUri),
                    mediaType: rawResource.mediaType,
                    crop: decodeSelectionCropV2(rawResource.crop, `slide selection node ${index} resource crop`),
                });
            }
            else if (rawResource.state === 'unavailable') {
                exactKeys(rawResource, ['state', 'reason', 'crop'], `slide selection node ${index} resource`);
                if (!['external', 'missing', 'unsupported'].includes(String(rawResource.reason))) {
                    throw new TypeError('slide selection unavailable resource reason is invalid');
                }
                resource = Object.freeze({
                    state: 'unavailable',
                    reason: rawResource.reason,
                    crop: decodeSelectionCropV2(rawResource.crop, `slide selection node ${index} resource crop`),
                });
            }
            else {
                throw new TypeError('slide selection resource state is invalid');
            }
        }
        if (node.nodeType === 'picture' ? resource === null : resource !== null) {
            throw new TypeError('slide selection picture resource is inconsistent');
        }
        return Object.freeze({
            nodeId: pptIdentity(node.nodeId, PPT_NODE_ID, `slide selection node ${index} id`),
            nodeType: node.nodeType,
            paintOrder: nonNegativeInteger(node.paintOrder, `slide selection node ${index} paint order`, PPTX_RENDER_WIRE_LIMITS_V1.maxNodes - 1),
            bounds,
            rotation60000: finiteInteger(node.rotation60000, `slide selection node ${index} rotation`, -2_147_483_648, 2_147_483_647),
            flipH: booleanValue(node.flipH, `slide selection node ${index} flipH`),
            flipV: booleanValue(node.flipV, `slide selection node ${index} flipV`),
            text: node.text === null
                ? null
                : boundedSourceText(node.text, `slide selection node ${index} text`, 64 * 1024),
            sourceAnchor: decodeNotesSourceAnchorV1(node.sourceAnchor, `slide selection node ${index} source anchor`),
            tableCells: Object.freeze(tableCells),
            resource,
        });
    });
    if (new Set(nodes.map((node) => node.nodeId)).size !== nodes.length) {
        throw new TypeError('slide selection nodes contain duplicate ids');
    }
    if (new Set(nodes.map((node) => node.paintOrder)).size !== nodes.length ||
        nodes.some((node, index) => index > 0 && nodes[index - 1].paintOrder >= node.paintOrder)) {
        throw new TypeError('slide selection nodes contain invalid paint order');
    }
    const decoded = deepFreezeWire({
        schema: PPTX_SLIDE_SELECTION_MODEL_SCHEMA_V2,
        revision: pptIdentity(input.revision, PPT_DOCUMENT_REVISION, 'selection revision'),
        slideId: pptIdentity(input.slideId, PPT_NODE_ID, 'selection slideId'),
        slideIndex: nonNegativeInteger(input.slideIndex, 'selection slideIndex', 100_000),
        widthEmu: finiteInteger(input.widthEmu, 'selection width', 1),
        heightEmu: finiteInteger(input.heightEmu, 'selection height', 1),
        nodes: Object.freeze(nodes),
    });
    if ((expected.revision !== undefined && decoded.revision !== expected.revision) ||
        (expected.slideIndex !== undefined && decoded.slideIndex !== expected.slideIndex)) {
        throw new TypeError('stale slide selection model');
    }
    return decoded;
}
export function decodePptxSelectionResourceV1(value, expected = {}) {
    const input = record(value, 'selection resource');
    exactKeys(input, ['schema', 'revision', 'resourceId', 'partUri', 'mediaType', 'byteLength', 'sha256', 'bytes'], 'selection resource');
    if (input.schema !== PPTX_SELECTION_RESOURCE_SCHEMA_V1 ||
        !(input.bytes instanceof ArrayBuffer) ||
        typeof input.mediaType !== 'string' ||
        !MEDIA_TYPE.test(input.mediaType)) {
        throw new TypeError('invalid selection resource');
    }
    const byteLength = nonNegativeInteger(input.byteLength, 'selection resource byteLength', PPTX_RENDER_WIRE_LIMITS_V1.maxResourceBytes);
    if (input.bytes.byteLength !== byteLength)
        throw new TypeError('selection resource size mismatch');
    const decoded = Object.freeze({
        schema: PPTX_SELECTION_RESOURCE_SCHEMA_V1,
        revision: pptIdentity(input.revision, PPT_DOCUMENT_REVISION, 'selection resource revision'),
        resourceId: renderResourceId(input.resourceId),
        partUri: partUri(input.partUri),
        mediaType: input.mediaType,
        byteLength,
        sha256: sha256(input.sha256, 'selection resource sha256'),
        bytes: input.bytes,
    });
    if ((expected.revision !== undefined && decoded.revision !== expected.revision) ||
        (expected.resourceId !== undefined && decoded.resourceId !== expected.resourceId)) {
        throw new TypeError('stale selection resource');
    }
    return decoded;
}
const ANIMATION_PROGRAM_HASH = /^animation:v1:[a-f0-9]{16}$/u;
const ANIMATION_GEOMETRY_HASH = /^animation-geometry:v1:[a-f0-9]{16}$/u;
const ANIMATION_EVALUATION_HASH = /^animation-evaluation:v1:[a-f0-9]{16}$/u;
const TRANSITION_PROGRAM_HASH = /^transition:v1:[a-f0-9]{16}$/u;
function contractHash(value, pattern, name) {
    if (typeof value !== 'string' || !pattern.test(value))
        throw new TypeError(`${name} is invalid`);
    return value;
}
export function decodePptxSlideAnimationV1(value, expected = {}) {
    const input = record(value, 'slide animation');
    exactKeys(input, [
        'schema',
        'revision',
        'sourceSha256',
        'slideIndex',
        'programHash',
        'geometryBasisHash',
        'capability',
        'clickStepCount',
        'automaticStepCount',
        ...(Object.hasOwn(input, 'interactiveStepCount') ? ['interactiveStepCount'] : []),
        ...(Object.hasOwn(input, 'mediaStepCount') ? ['mediaStepCount'] : []),
        'advanceAfterMs',
        'diagnosticCodes',
        'diagnostics',
    ], 'slide animation');
    if (input.schema !== PPTX_SLIDE_ANIMATION_SCHEMA_V1 ||
        !['exact', 'approximated', 'terminal'].includes(String(input.capability)) ||
        !Array.isArray(input.diagnostics) ||
        input.diagnostics.length > 4_000)
        throw new TypeError('invalid slide animation contract');
    const nullableText = (candidate, name, max = 512) => candidate === null ? null : boundedText(candidate, name, max, true);
    const nullableMilliseconds = (candidate, name) => candidate === null ? null : nonNegativeInteger(candidate, name);
    const diagnostics = input.diagnostics.map((candidate, index) => {
        const diagnostic = record(candidate, `animation diagnostic ${index}`);
        exactKeys(diagnostic, ['code', 'outcome', 'reason', 'detail', 'sourceTimingIds', 'authored', 'fallback'], `animation diagnostic ${index}`);
        if (!['PPTX-S06-EFFECT-UNSUPPORTED-STATIC', 'PPTX-S06-ANIMATION-TERMINAL'].includes(String(diagnostic.code)) ||
            !['approximated', 'terminal'].includes(String(diagnostic.outcome)) ||
            !Array.isArray(diagnostic.sourceTimingIds) ||
            diagnostic.sourceTimingIds.length > 4_000) {
            throw new TypeError(`animation diagnostic ${index} is invalid`);
        }
        const sourceTimingIds = diagnostic.sourceTimingIds.map((item, timingIndex) => nonNegativeInteger(item, `animation diagnostic ${index} timing ${timingIndex}`, 1_000_000));
        if (new Set(sourceTimingIds).size !== sourceTimingIds.length) {
            throw new TypeError(`animation diagnostic ${index} timing ids contain duplicates`);
        }
        const authored = record(diagnostic.authored, `animation diagnostic ${index} authored`);
        exactKeys(authored, [
            'kind',
            'presetClass',
            'presetId',
            'filter',
            'subtype',
            'target',
            'trigger',
            'durationMs',
            'delayMs',
            'ooxmlAnchor',
        ], `animation diagnostic ${index} authored`);
        const target = record(authored.target, `animation diagnostic ${index} target`);
        exactKeys(target, ['kind', 'authoredShapeId', 'relationshipId', 'nodeId'], `animation diagnostic ${index} target`);
        const trigger = record(authored.trigger, `animation diagnostic ${index} trigger`);
        exactKeys(trigger, ['kind', 'clickIndex', 'referenceStepId', 'targetNodeId', 'mediaNodeId', 'bookmark', 'event'], `animation diagnostic ${index} trigger`);
        if (![
            'slide-enter',
            'page-click',
            'with-previous',
            'after-previous',
            'shape-click',
            'media-bookmark',
            'event',
        ].includes(String(trigger.kind))) {
            throw new TypeError(`animation diagnostic ${index} trigger is invalid`);
        }
        const clickIndex = trigger.clickIndex === null
            ? null
            : (() => {
                if (!Number.isSafeInteger(trigger.clickIndex) || Number(trigger.clickIndex) < -1) {
                    throw new TypeError(`animation diagnostic ${index} click index is invalid`);
                }
                return Number(trigger.clickIndex);
            })();
        const fallback = diagnostic.fallback === null
            ? null
            : (() => {
                const item = record(diagnostic.fallback, `animation diagnostic ${index} fallback`);
                exactKeys(item, ['kernelId', 'easing'], `animation diagnostic ${index} fallback`);
                if (!['authored', 'linear'].includes(String(item.easing))) {
                    throw new TypeError(`animation diagnostic ${index} fallback easing is invalid`);
                }
                return Object.freeze({
                    kernelId: boundedText(item.kernelId, `animation diagnostic ${index} fallback kernel`, 256),
                    easing: item.easing,
                });
            })();
        if (
        // A partially compiled parallel group or iteration keeps supported
        // authored tracks without substituting one fallback kernel.
        (diagnostic.outcome === 'approximated' &&
            diagnostic.code !== 'PPTX-S06-EFFECT-UNSUPPORTED-STATIC') ||
            (diagnostic.outcome === 'terminal' &&
                (diagnostic.code !== 'PPTX-S06-ANIMATION-TERMINAL' || fallback !== null))) {
            throw new TypeError(`animation diagnostic ${index} outcome is inconsistent`);
        }
        return deepFreezeWire({
            code: diagnostic.code,
            outcome: diagnostic.outcome,
            reason: boundedText(diagnostic.reason, `animation diagnostic ${index} reason`, 256),
            detail: boundedText(diagnostic.detail, `animation diagnostic ${index} detail`, 2_048),
            sourceTimingIds: Object.freeze(sourceTimingIds),
            authored: Object.freeze({
                kind: boundedText(authored.kind, `animation diagnostic ${index} kind`, 128),
                presetClass: nullableText(authored.presetClass, `animation diagnostic ${index} presetClass`),
                presetId: nullableText(authored.presetId, `animation diagnostic ${index} presetId`),
                filter: nullableText(authored.filter, `animation diagnostic ${index} filter`, 1_024),
                subtype: nullableText(authored.subtype, `animation diagnostic ${index} subtype`),
                target: Object.freeze({
                    kind: nullableText(target.kind, `animation diagnostic ${index} target kind`, 128),
                    authoredShapeId: target.authoredShapeId === null
                        ? null
                        : nonNegativeInteger(target.authoredShapeId, `animation diagnostic ${index} authored shape id`, 10_000_000),
                    relationshipId: nullableText(target.relationshipId, `animation diagnostic ${index} relationship id`),
                    nodeId: target.nodeId === null
                        ? null
                        : pptIdentity(target.nodeId, PPT_NODE_ID, `animation diagnostic ${index} node id`),
                }),
                trigger: Object.freeze({
                    kind: trigger.kind,
                    clickIndex,
                    referenceStepId: nullableText(trigger.referenceStepId, `animation diagnostic ${index} reference step`),
                    targetNodeId: trigger.targetNodeId === null
                        ? null
                        : pptIdentity(trigger.targetNodeId, PPT_NODE_ID, `animation diagnostic ${index} trigger target`),
                    mediaNodeId: trigger.mediaNodeId === null
                        ? null
                        : pptIdentity(trigger.mediaNodeId, PPT_NODE_ID, `animation diagnostic ${index} trigger media`),
                    bookmark: nullableText(trigger.bookmark, `animation diagnostic ${index} bookmark`),
                    event: nullableText(trigger.event, `animation diagnostic ${index} event`),
                }),
                durationMs: nullableMilliseconds(authored.durationMs, `animation diagnostic ${index} duration`),
                delayMs: nullableMilliseconds(authored.delayMs, `animation diagnostic ${index} delay`),
                ooxmlAnchor: decodeNotesSourceAnchorV1(authored.ooxmlAnchor, `animation diagnostic ${index} OOXML anchor`),
            }),
            fallback,
        });
    });
    const diagnosticCodes = boundedStrings(input.diagnosticCodes, 'animation diagnosticCodes', 4_000);
    const actualDiagnosticCodes = [...new Set(diagnostics.map((item) => item.code))].sort();
    if (JSON.stringify(diagnosticCodes) !== JSON.stringify(actualDiagnosticCodes)) {
        throw new TypeError('animation diagnostic codes do not match structured diagnostics');
    }
    if ((input.capability === 'exact' && diagnostics.length !== 0) ||
        (input.capability === 'approximated' &&
            (diagnostics.length === 0 || diagnostics.some((item) => item.outcome !== 'approximated'))) ||
        (input.capability === 'terminal' && !diagnostics.some((item) => item.outcome === 'terminal'))) {
        throw new TypeError('animation capability is inconsistent with diagnostics');
    }
    const decoded = deepFreezeWire({
        schema: PPTX_SLIDE_ANIMATION_SCHEMA_V1,
        revision: pptIdentity(input.revision, PPT_DOCUMENT_REVISION, 'revision'),
        sourceSha256: sha256(input.sourceSha256, 'animation sourceSha256'),
        slideIndex: nonNegativeInteger(input.slideIndex, 'slideIndex', 10_000),
        programHash: contractHash(input.programHash, ANIMATION_PROGRAM_HASH, 'programHash'),
        geometryBasisHash: contractHash(input.geometryBasisHash, ANIMATION_GEOMETRY_HASH, 'geometryBasisHash'),
        capability: input.capability,
        clickStepCount: nonNegativeInteger(input.clickStepCount, 'clickStepCount', 100_000),
        automaticStepCount: nonNegativeInteger(input.automaticStepCount, 'automaticStepCount', 100_000),
        interactiveStepCount: nonNegativeInteger(Object.hasOwn(input, 'interactiveStepCount') ? input.interactiveStepCount : 0, 'interactiveStepCount', 100_000),
        mediaStepCount: nonNegativeInteger(Object.hasOwn(input, 'mediaStepCount') ? input.mediaStepCount : 0, 'mediaStepCount', 100_000),
        advanceAfterMs: input.advanceAfterMs === null
            ? null
            : nonNegativeInteger(input.advanceAfterMs, 'advanceAfterMs'),
        diagnosticCodes,
        diagnostics: Object.freeze(diagnostics),
    });
    if ((expected.revision !== undefined && decoded.revision !== expected.revision) ||
        (expected.sourceSha256 !== undefined && decoded.sourceSha256 !== expected.sourceSha256) ||
        (expected.slideIndex !== undefined && decoded.slideIndex !== expected.slideIndex))
        throw new TypeError('stale slide animation revision');
    return decoded;
}
function decodePlaybackOverridesV2(value) {
    const input = record(value, 'playback overrides');
    exactKeys(input, [
        'schema',
        'baseRenderHash',
        'logicalTimeMs',
        'nodeProperties',
        'masks',
        'filters',
        'transforms3d',
        'mediaCommands',
        'provenance',
    ], 'playback overrides');
    if (input.schema !== 'mavis.pptx_playback_overrides.v2')
        throw new TypeError('invalid playback override schema');
    const arrays = [
        'nodeProperties',
        'masks',
        'filters',
        'transforms3d',
        'mediaCommands',
        'provenance',
    ];
    for (const field of arrays) {
        if (!Array.isArray(input[field]) || input[field].length > 100_000)
            throw new TypeError(`playback ${field} exceeds budget`);
    }
    const provenance = new Set();
    const decodedProvenance = input.provenance.map((candidate, index) => {
        const item = record(candidate, `playback provenance ${index}`);
        if (typeof item.provenanceId !== 'string' ||
            !item.provenanceId ||
            provenance.has(item.provenanceId))
            throw new TypeError('playback provenance identity is invalid');
        provenance.add(item.provenanceId);
        return deepFreezeWire({ ...item });
    });
    const seen = new Set();
    const nodeProperties = input.nodeProperties.map((candidate, index) => {
        const item = record(candidate, `node property ${index}`);
        exactKeys(item, [
            'nodeId',
            ...(Object.hasOwn(item, 'subNodeKey') ? ['subNodeKey'] : []),
            'property',
            'value',
            'provenanceId',
        ], `node property ${index}`);
        const nodeId = pptIdentity(item.nodeId, PPT_NODE_ID, 'animation nodeId');
        const property = String(item.property);
        if (![
            'visibility',
            'opacity100000',
            'transform',
            'fill',
            'stroke',
            'textPaint',
            'textLayout',
            'textScale100000',
            'strokeEnabled',
            'fillEnabled',
        ].includes(property) ||
            typeof item.provenanceId !== 'string' ||
            !provenance.has(item.provenanceId))
            throw new TypeError('playback node property is invalid');
        const subNodeKey = Object.hasOwn(item, 'subNodeKey')
            ? boundedText(item.subNodeKey, 'animation subNodeKey', 256)
            : undefined;
        const identity = `${nodeId}|${subNodeKey ?? ''}|${property}`;
        if (seen.has(identity))
            throw new TypeError('playback node property conflicts');
        seen.add(identity);
        if (property === 'opacity100000')
            finiteInteger(item.value, 'opacity100000', 0, 100_000);
        if (property === 'textScale100000')
            finiteInteger(item.value, 'textScale100000', 0, 100_000_000);
        if (['visibility', 'strokeEnabled', 'fillEnabled'].includes(property) &&
            typeof item.value !== 'boolean')
            throw new TypeError('playback visibility is invalid');
        if (property === 'textLayout') {
            const variant = record(item.value, 'animation text layout');
            exactKeys(variant, ['key', 'nodes', ...(Object.hasOwn(variant, 'fontFamily') ? ['fontFamily'] : [])], 'animation text layout');
            boundedText(variant.key, 'animation text variant key', 4096);
            if (Object.hasOwn(variant, 'fontFamily'))
                boundedText(variant.fontFamily, 'animation font family', 256);
            if (!Array.isArray(variant.nodes) || variant.nodes.length > 4096)
                throw new TypeError('animation text layout budget is invalid');
            const budget = { commands: 0, glyphs: 0 };
            const ids = new Set();
            for (const [nodeIndex, node] of variant.nodes.entries()) {
                const decoded = decodeRenderNode(node, nodeIndex, budget);
                if (decoded.sourceNodeId !== nodeId ||
                    typeof decoded.kind !== 'string' ||
                    typeof decoded.nodeId !== 'string' ||
                    !['glyphRun', 'path'].includes(decoded.kind) ||
                    ids.has(decoded.nodeId))
                    throw new TypeError('animation text layout target is invalid');
                ids.add(decoded.nodeId);
            }
        }
        return deepFreezeWire({
            nodeId,
            ...(subNodeKey ? { subNodeKey } : {}),
            property,
            value: item.value,
            provenanceId: item.provenanceId,
        });
    });
    const decodeOpaqueArray = (field) => Object.freeze(input[field].map((candidate, index) => {
        const item = record(candidate, `${field} ${index}`);
        if (typeof item.provenanceId !== 'string' || !provenance.has(item.provenanceId))
            throw new TypeError(`${field} provenance is invalid`);
        if (typeof item.nodeId === 'string')
            pptIdentity(item.nodeId, PPT_NODE_ID, `${field} nodeId`);
        if (Object.hasOwn(item, 'subNodeKey'))
            boundedText(item.subNodeKey, `${field} subNodeKey`, 256);
        return deepFreezeWire({ ...item });
    }));
    return deepFreezeWire({
        schema: 'mavis.pptx_playback_overrides.v2',
        baseRenderHash: renderHash(input.baseRenderHash),
        logicalTimeMs: finiteInteger(input.logicalTimeMs, 'logicalTimeMs', 0),
        nodeProperties: Object.freeze(nodeProperties),
        masks: decodeOpaqueArray('masks'),
        filters: decodeOpaqueArray('filters'),
        transforms3d: decodeOpaqueArray('transforms3d'),
        mediaCommands: decodeOpaqueArray('mediaCommands'),
        provenance: Object.freeze(decodedProvenance),
    });
}
export function decodePptxAnimationEvaluationV1(value, expected = {}) {
    const input = record(value, 'animation evaluation');
    exactKeys(input, [
        'schema',
        'revision',
        'slideIndex',
        'programHash',
        'clickIndex',
        'isComplete',
        'nextEventDeadlineMs',
        'evaluationHash',
        'overrides',
    ], 'animation evaluation');
    if (input.schema !== PPTX_ANIMATION_EVALUATION_SCHEMA_V1 || typeof input.isComplete !== 'boolean')
        throw new TypeError('invalid animation evaluation contract');
    const decoded = deepFreezeWire({
        schema: PPTX_ANIMATION_EVALUATION_SCHEMA_V1,
        revision: pptIdentity(input.revision, PPT_DOCUMENT_REVISION, 'revision'),
        slideIndex: nonNegativeInteger(input.slideIndex, 'slideIndex', 10_000),
        programHash: contractHash(input.programHash, ANIMATION_PROGRAM_HASH, 'programHash'),
        clickIndex: nonNegativeInteger(input.clickIndex, 'clickIndex', 100_000),
        isComplete: input.isComplete,
        nextEventDeadlineMs: input.nextEventDeadlineMs === null
            ? null
            : nonNegativeInteger(input.nextEventDeadlineMs, 'nextEventDeadlineMs'),
        evaluationHash: contractHash(input.evaluationHash, ANIMATION_EVALUATION_HASH, 'evaluationHash'),
        overrides: decodePlaybackOverridesV2(input.overrides),
    });
    if ((expected.revision !== undefined && decoded.revision !== expected.revision) ||
        (expected.slideIndex !== undefined && decoded.slideIndex !== expected.slideIndex) ||
        (expected.programHash !== undefined && decoded.programHash !== expected.programHash))
        throw new TypeError('stale animation evaluation revision');
    return decoded;
}
export function decodePptxTransitionEvaluationV1(value, expected = {}) {
    const input = record(value, 'transition evaluation');
    exactKeys(input, ['schema', 'revision', 'fromSlideIndex', 'toSlideIndex', 'programHash', 'frame'], 'transition evaluation');
    if (input.schema !== PPTX_TRANSITION_EVALUATION_SCHEMA_V1)
        throw new TypeError('invalid transition evaluation contract');
    const frame = record(input.frame, 'transition frame');
    if (frame.schema !== 'mavis.pptx_transition_frame.v1' ||
        !Array.isArray(frame.operations) ||
        !Array.isArray(frame.morphOperations))
        throw new TypeError('invalid transition frame');
    const decoded = deepFreezeWire({
        schema: PPTX_TRANSITION_EVALUATION_SCHEMA_V1,
        revision: pptIdentity(input.revision, PPT_DOCUMENT_REVISION, 'revision'),
        fromSlideIndex: nonNegativeInteger(input.fromSlideIndex, 'fromSlideIndex', 10_000),
        toSlideIndex: nonNegativeInteger(input.toSlideIndex, 'toSlideIndex', 10_000),
        programHash: contractHash(input.programHash, TRANSITION_PROGRAM_HASH, 'programHash'),
        frame: deepFreezeWire({ ...frame }),
    });
    if ((expected.revision !== undefined && decoded.revision !== expected.revision) ||
        (expected.fromSlideIndex !== undefined && decoded.fromSlideIndex !== expected.fromSlideIndex) ||
        (expected.toSlideIndex !== undefined && decoded.toSlideIndex !== expected.toSlideIndex))
        throw new TypeError('stale transition evaluation revision');
    return decoded;
}
export * from './pptx-rendering-contract.js';
//# sourceMappingURL=pptx-rendering.js.map