import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import JSZip from 'jszip';
import lazystream from 'lazystream';
export const writeWorkspaceArchive = async (input) => {
    await mkdir(input.stagingDir, { recursive: true, mode: 0o700 });
    try {
        const zip = new JSZip();
        for (const entry of input.scan.files) {
            if (entry.kind !== 'file' || !input.includedPaths.has(entry.path))
                continue;
            input.signal?.throwIfAborted();
            const stagedPath = path.join(input.stagingDir, ...entry.path.split('/'));
            await mkdir(path.dirname(stagedPath), { recursive: true, mode: 0o700 });
            await stageVerifiedFile(entry, stagedPath, input.signal);
            // JSZip binds and pauses supplied streams during registration. Defer the
            // real ReadStream so large snapshots do not reserve one descriptor per file.
            zip.file(entry.path, new lazystream.Readable(() => createReadStream(stagedPath)), {
                binary: true,
                createFolders: true,
                unixPermissions: entry.mode,
                date: new Date(0),
            });
        }
        const hash = createHash('sha256');
        let sizeBytes = 0;
        const meter = new Transform({
            transform(chunk, _encoding, callback) {
                hash.update(chunk);
                sizeBytes += chunk.byteLength;
                callback(null, chunk);
            },
        });
        const archive = zip.generateNodeStream({
            type: 'nodebuffer',
            streamFiles: true,
            compression: 'DEFLATE',
            compressionOptions: { level: 6 },
            platform: 'UNIX',
        });
        await pipeline(archive, meter, createWriteStream(input.targetPath, { mode: 0o600 }), input.signal ? { signal: input.signal } : {});
        return { sha256: hash.digest('hex'), sizeBytes };
    }
    finally {
        await rm(input.stagingDir, { recursive: true, force: true });
    }
};
async function stageVerifiedFile(entry, stagedPath, signal) {
    const hash = createHash('sha256');
    let sizeBytes = 0;
    const meter = new Transform({
        transform(chunk, _encoding, callback) {
            hash.update(chunk);
            sizeBytes += chunk.byteLength;
            callback(null, chunk);
        },
    });
    await pipeline(createReadStream(entry.sourcePath, signal ? { signal } : undefined), meter, createWriteStream(stagedPath, { mode: 0o600 }), signal ? { signal } : {});
    if (sizeBytes !== entry.size || hash.digest('hex') !== entry.sha256) {
        throw new Error(`workspace_changed_during_capture:${entry.path}`);
    }
}
//# sourceMappingURL=workspace-archive-writer.js.map