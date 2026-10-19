const MAX_FAVICON_URL_LENGTH = 4096;
const MAX_FAVICON_DATA_URL_LENGTH = 256 * 1024;
const SAFE_RASTER_FAVICON_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon);base64,/iu;
export function safeEmbeddedBrowserFaviconUrl(value) {
    if (typeof value !== 'string')
        return null;
    const candidate = value.trim();
    if (!candidate)
        return null;
    if (SAFE_RASTER_FAVICON_DATA_URL.test(candidate)) {
        return candidate.length <= MAX_FAVICON_DATA_URL_LENGTH ? candidate : null;
    }
    if (candidate.length > MAX_FAVICON_URL_LENGTH)
        return null;
    try {
        const parsed = new URL(candidate);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? candidate : null;
    }
    catch {
        return null;
    }
}
