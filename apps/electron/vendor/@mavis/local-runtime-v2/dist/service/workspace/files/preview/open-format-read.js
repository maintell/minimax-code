import { open, readFile } from 'node:fs/promises';
import { readOfficePreviewFile } from './office-preview-read.js';
export const MAX_OPEN_FORMAT_PREVIEW_BYTES = 64 * 1024 * 1024;
/**
 * A text prefix cannot rule out embedded binary data later in PostScript.
 * Inline previews read within the binary budget, then the caller classifies the
 * complete bytes and applies the smaller text budget. Never choose 20 MiB from
 * a header sample: a later NUL can make an otherwise oversized source binary.
 * Git diff retains its existing unrestricted source read contract.
 */
export async function readOpenFormatFile(path, extension, inlinePreview) {
    if (!inlinePreview) {
        if (extension === '.ps' || extension === '.eps')
            return readFile(path);
        if (extension === '.ai' && (await hasPostScriptHeader(path)))
            return readFile(path);
        // Git only needs classification for these known binary formats.
        return Buffer.alloc(0);
    }
    return readOfficePreviewFile(path, MAX_OPEN_FORMAT_PREVIEW_BYTES);
}
async function hasPostScriptHeader(path) {
    const handle = await open(path, 'r');
    try {
        const header = Buffer.alloc(4);
        let length = 0;
        while (length < header.length) {
            const { bytesRead } = await handle.read(header, length, header.length - length, length);
            if (bytesRead === 0)
                break;
            length += bytesRead;
        }
        return length === header.length && header.toString() === '%!PS';
    }
    finally {
        await handle.close();
    }
}
//# sourceMappingURL=open-format-read.js.map