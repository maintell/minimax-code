/** Strictest known per-image provider limit; a larger image is never sent. */
const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;
export const REQUEST_MEDIA_DEFAULTS = {
    image: { max_width: 2_000, max_height: 2_000, max_base64_bytes: 3.5 * 1024 * 1024 },
};
/** Resolves the user-facing `requestMedia` config.yaml block. */
export function parseRequestMediaConfig(raw) {
    const value = isRecord(raw) ? raw : {};
    const image = isRecord(value.image) ? value.image : {};
    const defaults = REQUEST_MEDIA_DEFAULTS.image;
    return {
        image: {
            max_width: positiveInteger(image.max_width) ?? defaults.max_width,
            max_height: positiveInteger(image.max_height) ?? defaults.max_height,
            max_base64_bytes: Math.min(positiveInteger(image.max_base64_bytes) ?? defaults.max_base64_bytes, MAX_IMAGE_BASE64_BYTES),
        },
    };
}
function positiveInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=request-media-config.js.map