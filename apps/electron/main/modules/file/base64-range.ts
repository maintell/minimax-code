import * as fs from "fs/promises";
function requireNonNegativeSafeInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative safe integer`);
    }
    return value;
}
/**
 * Read an optional byte range without materializing the whole binary file.
 * Omitted offset and limit preserve the legacy full-file behavior.
 */
export async function readBase64FileRange(filePath, offset, limit) {
    if (offset === undefined && limit === undefined) {
        return { content: (await fs.readFile(filePath)).toString('base64'), truncated: false };
    }
    const start = requireNonNegativeSafeInteger(offset ?? 0, 'offset');
    const requestedLength = limit === undefined ? undefined : requireNonNegativeSafeInteger(limit, 'limit');
    const fileSize = (await fs.stat(filePath)).size;
    const boundedStart = Math.min(start, fileSize);
    const length = Math.min(requestedLength ?? fileSize - boundedStart, fileSize - boundedStart);
    if (length === 0) {
        return { content: '', truncated: boundedStart < fileSize };
    }
    const handle = await fs.open(filePath, 'r');
    try {
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, boundedStart);
        return {
            content: buffer.subarray(0, bytesRead).toString('base64'),
            truncated: boundedStart + bytesRead < fileSize,
        };
    }
    finally {
        await handle.close();
    }
}
