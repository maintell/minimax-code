import { once } from "node:events";
import { createWriteStream, createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Transform } from "node:stream";
import { pipeline, finished } from "node:stream/promises";
import archiver from "archiver";
const CHUNK_BYTES = 64 * 1024;
class ArtifactTooLargeError extends Error {
}
/** Stage one input with bounded buffers before committing its entry to the ZIP. */
export async function writeDiagnosticArchive(path, bundle) {
    const staging = await mkdtemp(join(dirname(path), '.feedback-stage-'));
    const stagedPath = join(staging, 'artifact');
    const controller = new AbortController();
    const { signal } = controller;
    const output = createWriteStream(path);
    const archive = archiver('zip', { zlib: { level: 9 } });
    const manifest = {
        ...bundle.manifest,
        artifacts: [],
        totalFiles: 0,
        totalBytes: 0,
    };
    manifest.skippedArtifacts = [...(bundle.manifest.skippedArtifacts ?? [])];
    // Observe output errors immediately, including ones raised while an input read is pending.
    const completion = pipeline(archive, output, { signal });
    const append = async () => {
        try {
            for (const artifact of bundle.artifacts) {
                signal.throwIfAborted();
                const content = artifact.content ?? '';
                let bytes;
                try {
                    bytes = artifact.path
                        ? await stageArtifact(artifact.path, stagedPath, manifest.limits.maxBytes - manifest.totalBytes, signal)
                        : Buffer.byteLength(content);
                    if (manifest.totalBytes + bytes > manifest.limits.maxBytes)
                        throw new ArtifactTooLargeError();
                }
                catch (error) {
                    signal.throwIfAborted();
                    manifest.skippedArtifacts?.push({
                        name: artifact.name,
                        reason: error instanceof ArtifactTooLargeError
                            ? 'diagnostic_bundle_too_large'
                            : 'read_failed',
                    });
                    await rm(stagedPath, { force: true });
                    continue;
                }
                // Wait for consumption before unlinking (including handle close on Windows)
                // or staging the next file. This also bounds the archiver input queue.
                const entry = once(archive, 'entry', { signal });
                if (artifact.path) {
                    const input = createReadStream(stagedPath, { highWaterMark: CHUNK_BYTES, signal });
                    const consumed = finished(input, { cleanup: true });
                    archive.append(input, { name: artifact.name });
                    await Promise.all([entry, consumed]);
                    await rm(stagedPath);
                }
                else {
                    archive.append(content, { name: artifact.name });
                    await entry;
                }
                const { name, source, privacy, uploadDefault } = artifact;
                manifest.artifacts.push({ name, source, privacy, uploadDefault, bytes });
                manifest.totalBytes += bytes;
                manifest.totalFiles += 1;
            }
            manifest.sources = manifest.sources.map((source) => {
                const artifacts = manifest.artifacts.filter((artifact) => artifact.source === source.id);
                return {
                    ...source,
                    fileCount: artifacts.length,
                    bytes: artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
                };
            });
            archive.append(JSON.stringify(manifest, null, 2), { name: 'diagnostic-manifest.json' });
            await archive.finalize();
        }
        catch (error) {
            output.destroy(error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
    };
    const appending = append();
    try {
        await Promise.all([completion, appending]);
    }
    finally {
        controller.abort();
        archive.abort();
        await Promise.allSettled([completion, appending]);
        await rm(staging, { recursive: true, force: true });
    }
}
async function stageArtifact(source, target, limit, signal) {
    const info = await stat(source);
    if (info.size > limit)
        throw new ArtifactTooLargeError();
    let bytes = 0;
    const bounded = new Transform({
        transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            callback(bytes > limit ? new ArtifactTooLargeError() : null, chunk);
        },
    });
    await pipeline(createReadStream(source, { highWaterMark: CHUNK_BYTES, signal }), bounded, createWriteStream(target, { flags: 'wx', mode: 0o600, highWaterMark: CHUNK_BYTES }), { signal });
    return bytes;
}
