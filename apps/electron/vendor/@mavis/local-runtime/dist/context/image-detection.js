import { parseImageDimensionsFromBytes } from '@mavis/shared/image-dimensions';
/**
 * Vision token estimation, dimension-based.
 *
 * Visual tokens are a function of the image's (resized) pixel dimensions,
 * not its file size — a PNG screenshot and a JPEG photo of the same
 * dimensions can differ 10x in bytes but cost the same tokens. So we parse
 * width/height from the image header inside the base64 data, simulate the
 * provider-side proportional resize, and count 28px patches.
 *
 * The default path uses a single conservative tier (the high-res one:
 * maxEdge=2576, maxTokens=4784) instead of a broad per-model tier table.
 * MiniMax-M is the one explicit exception because its media-token helper is
 * known locally. Under-estimation is the dangerous direction
 * (context-overflow retry loop), so fallbacks stay conservative.
 */
const MAX_IMAGE_EDGE = 2_576;
const MAX_IMAGE_TOKENS = 4_784;
const IMAGE_PATCH_SIZE = 28;
const MAX_MEDIA_DIMENSION = 1_000_000;
const MAX_BINARY_SEARCH_ITERATIONS = 64;
const MINIMAX_M_MIN_SHORT_SIDE = 112;
const MINIMAX_M_FACTOR = 28;
const MINIMAX_M_IMAGE_LONG_SIDE = {
    low: 672,
    default: 2_016,
    high: 3_584,
};
const MINIMAX_M_VIDEO_LONG_SIDE = {
    low: 504,
    default: 672,
    high: 1_288,
};
/**
 * Default fallback when the header cannot be parsed (unknown format,
 * truncated data, or no dimensions). MiniMax-M uses its own per-detail
 * fallback because image/video limits differ there.
 */
export const FALLBACK_IMAGE_TOKENS = MAX_IMAGE_TOKENS;
/**
 * Only base64-decode a bounded prefix for header sniffing. PNG/GIF/WebP
 * dimensions live in the first ~32 bytes; JPEG's SOF marker can sit after
 * a large EXIF/APPn block, so allow up to ~96KB of decoded prefix before
 * giving up. Never decode the full payload (images can be many MB).
 */
const HEADER_SNIFF_BASE64_CHARS = 131_072;
export function messagesContainImageData(messages) {
    for (const message of messages) {
        const record = message;
        const content = record.content;
        if (!Array.isArray(content))
            continue;
        for (const block of content) {
            if (block.type === 'image' || block.type === 'video')
                return true;
        }
    }
    return false;
}
/**
 * Estimate visual tokens for one image (or video) block. Parses dimensions
 * from the base64 header and simulates the provider resize; falls back to
 * {@link FALLBACK_IMAGE_TOKENS} when the data is missing or unparseable.
 */
export function estimateImageBlockTokens(block, options = {}) {
    const isVideo = isVideoBlock(block);
    const dimensions = readDimensionsFromBlock(block) ?? readDimensionsFromBase64Block(block, isVideo);
    if (isMiniMaxMModel(options.model)) {
        const detail = readMediaDetail(block);
        if (!dimensions)
            return minimaxMFallbackTokens(detail, isVideo);
        return estimateMiniMaxMVisualTokensForDimensions(dimensions.height, dimensions.width, detail, isVideo, readMaxLongSidePixel(block));
    }
    if (!dimensions)
        return FALLBACK_IMAGE_TOKENS;
    return estimateVisualTokensForDimensions(dimensions.width, dimensions.height);
}
/**
 * Replicates the provider resize helper: binary-search the largest
 * proportional scale whose resized dimensions satisfy both the edge cap
 * and the visual-token cap, then count 28px patches on the result.
 */
export function estimateVisualTokensForDimensions(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return FALLBACK_IMAGE_TOKENS;
    }
    const w = Math.floor(width);
    const h = Math.floor(height);
    if (fitsWithinCaps(w, h))
        return visualTokensAt(w, h);
    const longerEdge = Math.max(w, h);
    let lo = 1;
    let hi = longerEdge;
    let bestW = 1;
    let bestH = 1;
    // visualTokensAt is monotone non-decreasing in the scaled edge, so binary
    // search over the target longer-edge length is valid.
    for (let iterations = 0; lo <= hi && iterations < MAX_BINARY_SEARCH_ITERATIONS; iterations += 1) {
        const mid = Math.floor((lo + hi) / 2);
        const scale = mid / longerEdge;
        const scaledW = Math.max(1, Math.floor(w * scale));
        const scaledH = Math.max(1, Math.floor(h * scale));
        if (fitsWithinCaps(scaledW, scaledH)) {
            bestW = scaledW;
            bestH = scaledH;
            lo = mid + 1;
        }
        else {
            hi = mid - 1;
        }
    }
    return visualTokensAt(bestW, bestH);
}
/**
 * MiniMax-M helper mirrors the provider formula, whose public signature uses
 * (H, W, detail, is_video, max_long_side_pixel), so height intentionally comes
 * before width here.
 */
export function estimateMiniMaxMVisualTokensForDimensions(height, width, detail = 'default', isVideo = false, maxLongSidePixel) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return minimaxMFallbackTokens(detail, isVideo);
    }
    const h = Math.floor(height);
    const w = Math.floor(width);
    const limits = isVideo ? MINIMAX_M_VIDEO_LONG_SIDE : MINIMAX_M_IMAGE_LONG_SIDE;
    const longSideLimit = maxLongSidePixel ?? limits[detail];
    let beta;
    if (Math.max(h, w) > longSideLimit) {
        beta = longSideLimit / Math.max(h, w);
    }
    else if (Math.min(h, w) < MINIMAX_M_MIN_SHORT_SIDE) {
        beta = MINIMAX_M_MIN_SHORT_SIDE / Math.min(h, w);
    }
    else {
        beta = 1;
    }
    return (ceilScaledPatches(h, beta, MINIMAX_M_FACTOR) * ceilScaledPatches(w, beta, MINIMAX_M_FACTOR));
}
/** Parse width/height from a base64 image payload (PNG/JPEG/GIF/WebP). */
export function parseImageDimensionsFromBase64(data) {
    let b64 = data;
    // Tolerate data URLs ("data:image/png;base64,....").
    const commaIndex = b64.indexOf(',');
    if (b64.startsWith('data:') && commaIndex !== -1)
        b64 = b64.slice(commaIndex + 1);
    b64 = b64.slice(0, HEADER_SNIFF_BASE64_CHARS);
    b64 = b64.slice(0, b64.length - (b64.length % 4));
    if (b64.length === 0)
        return undefined;
    let buffer;
    try {
        buffer = Buffer.from(b64, 'base64');
    }
    catch {
        return undefined;
    }
    if (buffer.length < 4)
        return undefined;
    return parseImageDimensionsFromBytes(buffer);
}
function visualTokensAt(width, height) {
    return Math.ceil(width / IMAGE_PATCH_SIZE) * Math.ceil(height / IMAGE_PATCH_SIZE);
}
function ceilScaledPatches(value, scale, factor) {
    // Match the intended math.ceil(value * beta / factor) semantics without
    // letting JS floating point noise turn exact integers into N + epsilon.
    return Math.ceil((value * scale) / factor - 1e-9);
}
function fitsWithinCaps(width, height) {
    return (width <= MAX_IMAGE_EDGE &&
        height <= MAX_IMAGE_EDGE &&
        visualTokensAt(width, height) <= MAX_IMAGE_TOKENS);
}
function readDimensionsFromBase64Block(block, isVideo) {
    if (isVideo)
        return undefined;
    const data = resolveBase64Data(block);
    return data ? parseImageDimensionsFromBase64(data) : undefined;
}
function readDimensionsFromBlock(block) {
    const width = readDimensionNumber(block.width ?? block.w);
    const height = readDimensionNumber(block.height ?? block.h);
    if (width !== undefined && height !== undefined)
        return normalizeDimensions(width, height);
    const source = block.source;
    if (!source)
        return undefined;
    const sourceWidth = readDimensionNumber(source.width ?? source.w);
    const sourceHeight = readDimensionNumber(source.height ?? source.h);
    return sourceWidth !== undefined && sourceHeight !== undefined
        ? normalizeDimensions(sourceWidth, sourceHeight)
        : undefined;
}
function readMediaDetail(block) {
    const source = block.source;
    const raw = block.detail ?? source?.detail;
    return raw === 'low' || raw === 'high' || raw === 'default' ? raw : 'default';
}
function readMaxLongSidePixel(block) {
    const source = block.source;
    return (readPositiveNumber(block.max_long_side_pixel ?? block.maxLongSidePixel) ??
        readPositiveNumber(source?.max_long_side_pixel ?? source?.maxLongSidePixel));
}
function isMiniMaxMModel(model) {
    const id = model?.id?.trim() ?? '';
    const name = model?.name?.trim() ?? '';
    return /^minimax-m(?:\b|[\d.-])/i.test(id) || /^minimax-m(?:\b|[\d.-])/i.test(name);
}
function minimaxMFallbackTokens(detail, isVideo) {
    const limits = isVideo ? MINIMAX_M_VIDEO_LONG_SIDE : MINIMAX_M_IMAGE_LONG_SIDE;
    const edge = limits[detail];
    return estimateMiniMaxMVisualTokensForDimensions(edge, edge, detail, isVideo, edge);
}
function isVideoBlock(block) {
    if (block.type === 'video')
        return true;
    const source = block.source;
    const mediaType = block.mimeType ?? block.media_type ?? source?.media_type ?? source?.mimeType;
    return typeof mediaType === 'string' && mediaType.toLowerCase().startsWith('video/');
}
function readPositiveNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
function readDimensionNumber(value) {
    const number = readPositiveNumber(value);
    return number !== undefined && number <= MAX_MEDIA_DIMENSION ? number : undefined;
}
function normalizeDimensions(width, height) {
    if (Number.isFinite(width) &&
        Number.isFinite(height) &&
        width > 0 &&
        height > 0 &&
        width <= MAX_MEDIA_DIMENSION &&
        height <= MAX_MEDIA_DIMENSION) {
        return { width, height };
    }
    return undefined;
}
function resolveBase64Data(block) {
    if (typeof block.data === 'string' && block.data.length > 0)
        return block.data;
    const source = block.source;
    if (source && typeof source.data === 'string' && source.data.length > 0)
        return source.data;
    return undefined;
}
//# sourceMappingURL=image-detection.js.map