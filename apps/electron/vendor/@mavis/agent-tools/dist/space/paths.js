/** Space path helpers. A Space path is relative to the Space root: `/a/b.txt`, root `/`. */
/** Lightweight normalization: trim, split on `/`, trim segments, drop empties. */
export function pathSegments(input) {
    return input
        .trim()
        .split('/')
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0);
}
/** Server form: no leading or trailing `/`; root is "". */
export function serverPath(segments) {
    return segments.join('/');
}
/** Space path without trailing slash: `/a/b`, root `/`. */
export function libraryPath(segments) {
    return `/${segments.join('/')}`;
}
/** Display form: folders end with `/`, root is `/`. */
export function displayPath(path, folder) {
    const segments = pathSegments(path);
    if (segments.length === 0)
        return '/';
    return `${libraryPath(segments)}${folder ? '/' : ''}`;
}
export function joinLibraryPath(parent, name) {
    return libraryPath([...pathSegments(parent), name]);
}
/** Lowercase extension without the dot; a leading dot does not start one. */
export function fileExtension(name) {
    const base = name.split('/').pop() ?? name;
    const dot = base.lastIndexOf('.');
    return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}
/** A remote name used as one local path segment. */
export function localName(name, fallback) {
    const cleaned = name.replace(/[/\\]/gu, '_').trim();
    if (!cleaned || cleaned === '.' || cleaned === '..')
        return fallback;
    return cleaned;
}
const MIME_TYPES = {
    aac: 'audio/aac',
    csv: 'text/csv',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    flac: 'audio/flac',
    gif: 'image/gif',
    htm: 'text/html',
    html: 'text/html',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    json: 'application/json',
    m4a: 'audio/mp4',
    md: 'text/markdown',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    pdf: 'application/pdf',
    png: 'image/png',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    svg: 'image/svg+xml',
    txt: 'text/plain',
    wav: 'audio/wav',
    webm: 'video/webm',
    webp: 'image/webp',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    zip: 'application/zip',
};
export function inferMimeType(fileName) {
    return MIME_TYPES[fileExtension(fileName)] ?? 'application/octet-stream';
}
//# sourceMappingURL=paths.js.map