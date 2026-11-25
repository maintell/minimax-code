/**
 * 交付文件的 metainfo MIME：按扩展名给出注入器（{@link injectByMimeType}）认识的 MIME，非媒体返回 ''。
 *
 * 照 cloud-runtime `inferUploadMimeType`（drive-upload-helpers.ts）原样迁出：文本 / 代码 / 压缩包等
 * 有意不列，保持这些文件字节不被改写。与 space `inferMimeType` 的区别是多了 mkv / flv / ogg / oga 和
 * 三种 OOXML 模板（dotx / potx / xltx），且对未知扩展名返回 '' 而不是 application/octet-stream。
 */
const METAINFO_MIME_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.flv': 'video/x-flv',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/m4a',
    '.aac': 'audio/aac',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.dotx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.potx': 'application/vnd.openxmlformats-officedocument.presentationml.template',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xltx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
    '.pdf': 'application/pdf',
};
export function inferMetainfoMimeType(fileName) {
    const dot = fileName.lastIndexOf('.');
    const slash = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
    if (dot <= slash + 1)
        return '';
    return METAINFO_MIME_TYPES[fileName.slice(dot).toLowerCase()] ?? '';
}
//# sourceMappingURL=mime.js.map