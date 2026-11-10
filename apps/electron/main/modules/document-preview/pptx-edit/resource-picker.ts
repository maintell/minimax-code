import { BrowserWindow, dialog } from "electron";
import { open } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { PPTX_PREVIEW_LIMITS_V1 } from "@mavis/shared/document-preview";
const TYPES = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    ogg: 'audio/ogg',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
};
const EXTENSIONS = {
    image: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
    audio: ['mp3', 'wav', 'm4a', 'ogg'],
    video: ['mp4', 'webm', 'mov'],
};
function magic(bytes, type) {
    const ascii = (start, length) => String.fromCharCode(...bytes.slice(start, start + length));
    if (type === 'image/png')
        return [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value);
    if (type === 'image/jpeg')
        return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (type === 'image/gif')
        return ['GIF87a', 'GIF89a'].includes(ascii(0, 6));
    if (type === 'image/webp')
        return ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP';
    if (type === 'audio/wav')
        return ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE';
    if (type === 'audio/ogg')
        return ascii(0, 4) === 'OggS';
    if (type === 'audio/mpeg')
        return ascii(0, 3) === 'ID3' || (bytes[0] === 255 && (bytes[1] & 224) === 224);
    if (type === 'video/webm')
        return bytes[0] === 26 && bytes[1] === 69 && bytes[2] === 223 && bytes[3] === 163;
    return ascii(4, 4) === 'ftyp';
}
/** The renderer cannot provide a path; every resource starts with a native user selection. */
export async function pickPptResource(owner, kind, onDialog) {
    if (!Object.prototype.hasOwnProperty.call(EXTENSIONS, kind) || owner.isDestroyed())
        throw new Error('invalid_request');
    const window = BrowserWindow.fromWebContents(owner);
    if (!window || window.isDestroyed())
        throw new Error('invalid_request');
    const dialogAt = performance.now();
    const selected = await dialog.showOpenDialog(window, {
        properties: ['openFile'],
        filters: [{ name: kind.toUpperCase(), extensions: EXTENSIONS[kind] }],
    });
    onDialog?.(Math.max(0, performance.now() - dialogAt));
    if (selected.canceled)
        return null;
    if (owner.isDestroyed() || selected.filePaths.length !== 1)
        throw new Error('cancelled');
    const file = selected.filePaths[0];
    const extension = path.extname(file).slice(1).toLowerCase();
    if (!EXTENSIONS[kind].includes(extension))
        throw new Error('unsupported_edit');
    const contentType = TYPES[extension];
    const handle = await open(file, 'r');
    try {
        const before = await handle.stat();
        if (!before.isFile() ||
            before.size <= 0 ||
            before.size > PPTX_PREVIEW_LIMITS_V1.maxEntryUncompressedBytes)
            throw new Error('resource_limit_exceeded');
        const bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.length) {
            const read = await handle.read(bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset);
            if (!read.bytesRead)
                throw new Error('source_mutated');
            offset += read.bytesRead;
        }
        const after = await handle.stat();
        if (before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            !magic(bytes, contentType))
            throw new Error('unsupported_edit');
        if (owner.isDestroyed())
            throw new Error('cancelled');
        return {
            contentType,
            bytes: new Uint8Array(bytes),
            sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        };
    }
    finally {
        await handle.close();
    }
}
