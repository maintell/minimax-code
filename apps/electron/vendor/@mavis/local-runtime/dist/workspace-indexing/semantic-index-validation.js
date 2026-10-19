import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { MAX_WORKSPACE_SEMANTIC_INDEX_DIMENSIONS } from './semantic-index-pointer.js';
import { WORKSPACE_SEMANTIC_INDEX_SCHEMA_VERSION } from './types.js';
const INDEX_ENTRY_NAME = 'index.json';
export const MAX_WORKSPACE_SEMANTIC_INDEX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_INDEX_JSON_BYTES = 128 * 1024 * 1024;
const MAX_INDEX_CHUNKS = 2_000;
const MAX_SNIPPET_CHARS = 20_000;
export async function validateSemanticIndexArchiveEnvelope(input) {
    const archive = await stat(input.archivePath);
    if (!archive.isFile() ||
        input.archiveSizeBytes !== archive.size ||
        input.archiveSizeBytes <= 0 ||
        input.archiveSizeBytes > MAX_WORKSPACE_SEMANTIC_INDEX_ARCHIVE_BYTES) {
        throw new Error('workspace_semantic_index_archive_size_mismatch');
    }
    if (!/^[a-f0-9]{64}$/u.test(input.archiveSha256)) {
        throw new Error('workspace_semantic_index_archive_hash_invalid');
    }
    if (!Number.isInteger(input.dimensions) ||
        input.dimensions <= 0 ||
        input.dimensions > MAX_WORKSPACE_SEMANTIC_INDEX_DIMENSIONS) {
        throw new Error('workspace_semantic_index_dimensions_invalid');
    }
    if (!input.embeddingModel.trim() || input.normalization !== 'l2') {
        throw new Error('workspace_semantic_index_metadata_invalid');
    }
}
export async function parseAndValidateSemanticIndex(input) {
    const archive = await readFile(input.archivePath);
    const zip = await JSZip.loadAsync(archive);
    const names = Object.keys(zip.files);
    const indexEntry = zip.files[INDEX_ENTRY_NAME];
    if (names.length !== 1 || names[0] !== INDEX_ENTRY_NAME || !indexEntry || indexEntry.dir) {
        throw new Error('workspace_semantic_index_package_invalid');
    }
    const raw = await readZipEntryWithLimit(indexEntry.nodeStream('nodebuffer'), MAX_INDEX_JSON_BYTES);
    const parsed = JSON.parse(raw.toString('utf8'));
    if (parsed.schemaVersion !== WORKSPACE_SEMANTIC_INDEX_SCHEMA_VERSION ||
        parsed.workspaceId !== input.workspaceId ||
        parsed.revisionId !== input.revisionId ||
        parsed.rootHash !== input.rootHash ||
        parsed.embeddingModel !== input.embeddingModel ||
        parsed.dimensions !== input.dimensions ||
        parsed.normalization !== input.normalization ||
        !Array.isArray(parsed.chunks) ||
        parsed.chunks.length > MAX_INDEX_CHUNKS) {
        throw new Error('workspace_semantic_index_metadata_mismatch');
    }
    for (const chunk of parsed.chunks) {
        if (!chunk ||
            typeof chunk.id !== 'string' ||
            chunk.id.length === 0 ||
            !isSafeRelativePath(chunk.path) ||
            !Number.isInteger(chunk.startLine) ||
            chunk.startLine < 1 ||
            !Number.isInteger(chunk.endLine) ||
            chunk.endLine < chunk.startLine ||
            typeof chunk.snippet !== 'string' ||
            chunk.snippet.length > MAX_SNIPPET_CHARS ||
            typeof chunk.contentSha256 !== 'string' ||
            !/^[a-f0-9]{64}$/u.test(chunk.contentSha256) ||
            !Array.isArray(chunk.vector) ||
            chunk.vector.length !== parsed.dimensions ||
            chunk.vector.some((value) => !Number.isFinite(value))) {
            throw new Error('workspace_semantic_index_chunk_invalid');
        }
    }
    return parsed;
}
export async function sha256SemanticIndexArchive(filePath) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.once('error', reject);
        stream.once('end', () => resolve(hash.digest('hex')));
    });
}
async function readZipEntryWithLimit(stream, maxBytes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        let settled = false;
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            reject(error);
        };
        stream.on('data', (value) => {
            if (settled)
                return;
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            total += chunk.byteLength;
            if (total > maxBytes) {
                stream.destroy();
                fail(new Error('workspace_semantic_index_json_too_large'));
                return;
            }
            chunks.push(chunk);
        });
        stream.once('error', fail);
        stream.once('end', () => {
            if (settled)
                return;
            settled = true;
            resolve(Buffer.concat(chunks, total));
        });
    });
}
function isSafeRelativePath(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        !value.includes('\\') &&
        !path.posix.isAbsolute(value) &&
        path.posix.normalize(value) === value &&
        !value.startsWith('../'));
}
//# sourceMappingURL=semantic-index-validation.js.map