import { createHash } from "node:crypto";
import { writeFileIfUnchanged } from "./conditional-write.js";
import path from "node:path";
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** Serialize application saves and replace only a verified, unchanged source file. */
export async function saveWorkbook(request) {
    if (!path.isAbsolute(request.filePath) ||
        !/\.(xlsx|xlsm|csv)$/i.test(request.filePath) ||
        !/^[a-f0-9]{64}$/.test(request.expectedSha256) ||
        request.contentBase64.length > 48 * 1024 * 1024) {
        throw new Error('Invalid workbook save request');
    }
    const bytes = Buffer.from(request.contentBase64, 'base64');
    if (bytes.toString('base64') !== request.contentBase64)
        throw new Error('Invalid workbook bytes');
    try {
        await writeFileIfUnchanged(request.filePath, bytes, request.expectedSha256);
    }
    catch (error) {
        if (error instanceof Error && error.message.startsWith('FILE_CHANGED:'))
            throw new Error('WORKBOOK_SAVE_CONFLICT');
        throw error;
    }
    return { sha256: hash(bytes) };
}
