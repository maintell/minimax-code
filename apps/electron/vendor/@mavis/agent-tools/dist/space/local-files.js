import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SpaceError } from './errors.js';
import { downloadToFile, postObject, readLocalUploadFile, } from './transfer.js';
/**
 * Default access: node:fs on the local disk. Uploads stream the file as a signed multipart form
 * (PostObject only — a presigned PUT prepared target has no form fields to sign, and no host that
 * uses this default issues one); downloads stream the presigned GET to a sibling temporary file.
 */
export const nodeFsSpaceLocalFileAccess = {
    probe: readLocalUploadFile,
    async send({ prepared, fileName, mimeType, local, fetchImpl, signal }) {
        const instruction = prepared.upload_instruction;
        if (!instruction) {
            throw new SpaceError('UPSTREAM', 'Prepared upload carries no PostObject instruction; this host cannot send it.');
        }
        if (instruction.method && instruction.method.toUpperCase() !== 'POST') {
            throw new SpaceError('UPSTREAM', `Unsupported upload method ${instruction.method} returned by the server.`);
        }
        await postObject({
            url: instruction.url,
            fields: instruction.form_fields,
            filePath: local.realPath,
            fileName,
            mimeType,
        }, fetchImpl, signal);
    },
    async kind(absolutePath) {
        const info = await stat(absolutePath).catch(() => undefined);
        if (!info)
            return undefined;
        return info.isDirectory() ? 'directory' : 'file';
    },
    async mkdirp(absolutePath) {
        await mkdir(absolutePath, { recursive: true });
    },
    async receive({ url, destination, fetchImpl, signal }) {
        await mkdir(dirname(destination), { recursive: true });
        const { sha256 } = await downloadToFile(url, destination, fetchImpl, signal);
        return { sha256 };
    },
};
//# sourceMappingURL=local-files.js.map