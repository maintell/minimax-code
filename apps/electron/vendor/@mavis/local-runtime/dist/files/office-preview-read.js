import { open } from 'node:fs/promises';
import { OFFICE_PREVIEW_TOO_LARGE } from '@mavis/shared/office-preview-limits';
export class OfficePreviewSizeError extends Error {
    sizeBytes;
    maxBytes;
    code = OFFICE_PREVIEW_TOO_LARGE;
    constructor(sizeBytes, maxBytes) {
        super('Office file exceeds the inline preview size limit');
        this.sizeBytes = sizeBytes;
        this.maxBytes = maxBytes;
    }
}
/** Check metadata before reading; cap the stream too if the file grows while it is open. */
export async function readOfficePreviewFile(path, maxBytes) {
    const handle = await open(path, 'r');
    try {
        const info = await handle.stat();
        if (info.size > maxBytes)
            throw new OfficePreviewSizeError(info.size, maxBytes);
        const stream = handle.createReadStream({ autoClose: false });
        const chunks = [];
        let size = 0;
        for await (const chunk of stream) {
            const bytes = chunk;
            size += bytes.length;
            if (size > maxBytes)
                throw new OfficePreviewSizeError(size, maxBytes);
            chunks.push(bytes);
        }
        return Buffer.concat(chunks, size);
    }
    finally {
        await handle.close();
    }
}
//# sourceMappingURL=office-preview-read.js.map