import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { crc32, createDeflateRaw } from 'node:zlib';
/** bit 3: CRC and sizes follow the data (descriptor); bit 11: UTF-8 names. */
const GENERAL_PURPOSE_FLAGS = 0x0808;
const VERSION_NEEDED = 20;
/** Upper byte 3 = UNIX, so readers honour the permission bits below. */
const VERSION_MADE_BY = (3 << 8) | VERSION_NEEDED;
const DEFLATE = 8;
/** Fixed 1980-01-01 00:00 timestamp: equal inputs produce byte-identical archives. */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
const REGULAR_FILE = 0o100000;
const ZIP32_MAX = 0xffffffff;
const ZIP32_MAX_ENTRIES = 0xffff;
/** ZIP64 end records need format 4.5. */
const ZIP64_VERSION = 45;
/**
 * One read buffer per archive, refilled for every file: a fresh allocation per
 * chunk turned the whole source size into off-heap garbage that V8 collects
 * late, inflating the runtime's peak RSS by the size of the Workspace.
 */
const READ_BUFFER_BYTES = 256 * 1024;
/**
 * zlib preallocates one output buffer per stream (16KB by default), i.e. per
 * file. Most source files deflate to a few KB, so size it to the file; this
 * only changes how output is chunked, never the compressed bytes.
 */
const MIN_DEFLATE_CHUNK_BYTES = 1024;
const MAX_DEFLATE_CHUNK_BYTES = 64 * 1024;
/**
 * Writes the scanned files as a ZIP in one pass: each file is read once,
 * hashed and deflated by native zlib (off the event loop). The bytes archived
 * are exactly the bytes hashed, so a file edited after the scan fails the
 * whole archive instead of shipping content the manifest does not describe.
 */
export const writeWorkspaceArchive = async (input) => {
    const output = createWriteStream(input.targetPath, { mode: 0o600 });
    // Writes complete asynchronously; keep their failure for the next write
    // instead of letting an unobserved 'error' event crash the runtime.
    let outputError;
    output.on('error', (error) => {
        outputError ??= error;
    });
    const archiveHash = createHash('sha256');
    let offset = 0;
    const write = async (chunk) => {
        if (outputError)
            throw outputError;
        archiveHash.update(chunk);
        offset += chunk.byteLength;
        if (!output.write(chunk))
            await once(output, 'drain');
    };
    const centralDirectory = [];
    const readBuffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    try {
        for (const entry of input.scan.files) {
            if (entry.kind !== 'file' || !input.includedPaths.has(entry.path))
                continue;
            input.signal?.throwIfAborted();
            const headerOffset = offset;
            if (headerOffset > ZIP32_MAX)
                throw new Error('workspace_archive_exceeds_zip32');
            const name = Buffer.from(entry.path, 'utf8');
            await write(localFileHeader(name));
            const deflated = await deflateVerifiedFile(entry, write, readBuffer, input.signal);
            await write(dataDescriptor(deflated));
            centralDirectory.push(centralDirectoryHeader(name, entry.mode, deflated, headerOffset));
        }
        const centralDirectoryOffset = offset;
        for (const header of centralDirectory)
            await write(header);
        if (offset > ZIP32_MAX)
            throw new Error('workspace_archive_exceeds_zip32');
        const centralDirectorySize = offset - centralDirectoryOffset;
        // 65,535+ files (feedback snapshots allow 100k) overflow only the 16-bit
        // entry count; offsets and sizes stay below 4GB (checked above), so a
        // ZIP64 end record is the only ZIP64 structure needed.
        if (centralDirectory.length >= ZIP32_MAX_ENTRIES) {
            await write(zip64EndOfCentralDirectory(centralDirectory.length, centralDirectorySize, centralDirectoryOffset, offset));
        }
        await write(endOfCentralDirectory(Math.min(centralDirectory.length, ZIP32_MAX_ENTRIES), centralDirectorySize, centralDirectoryOffset));
        output.end();
        await finished(output);
        return { sha256: archiveHash.digest('hex'), sizeBytes: offset };
    }
    catch (error) {
        // Callers delete the directory next, so the descriptor must be closed
        // first (Windows refuses to remove open files).
        output.destroy();
        try {
            await finished(output);
        }
        catch {
            // The archive already failed; the close is all that matters here.
        }
        throw error;
    }
};
async function deflateVerifiedFile(entry, write, readBuffer, signal) {
    const hash = createHash('sha256');
    const deflated = { crc: 0, size: 0, compressedSize: 0 };
    const file = await open(entry.sourcePath, 'r');
    const deflate = createDeflateRaw({
        level: 6,
        chunkSize: Math.min(MAX_DEFLATE_CHUNK_BYTES, Math.max(MIN_DEFLATE_CHUNK_BYTES, Math.ceil(entry.size / 4))),
    });
    const drained = (async () => {
        for await (const chunk of deflate) {
            deflated.compressedSize += chunk.byteLength;
            await write(chunk);
        }
    })();
    // The archive side can fail (e.g. disk full) while the loop below is still
    // awaiting a read; observe it now so it never becomes an unhandledRejection
    // that takes the runtime down.
    const drainedFailure = rejectionOf(drained);
    try {
        for (;;) {
            signal?.throwIfAborted();
            const { bytesRead } = await file.read(readBuffer, 0, readBuffer.byteLength, null);
            if (bytesRead === 0)
                break;
            const chunk = readBuffer.subarray(0, bytesRead);
            hash.update(chunk);
            deflated.crc = crc32(chunk, deflated.crc);
            deflated.size += bytesRead;
            // zlib holds the chunk until it has consumed it; the write callback marks
            // that point, after which the shared read buffer may be refilled.
            await new Promise((resolve, reject) => {
                deflate.write(chunk, (error) => (error ? reject(error) : resolve()));
            });
        }
        deflate.end();
        await drained;
    }
    catch (error) {
        deflate.destroy();
        // Prefer the archive-side failure (e.g. disk full) over the resulting
        // "stream destroyed" error on the read side.
        throw (await drainedFailure) ?? error;
    }
    finally {
        await file.close();
    }
    if (deflated.size !== entry.size || hash.digest('hex') !== entry.sha256) {
        throw new Error(`workspace_changed_during_capture:${entry.path}`);
    }
    if (deflated.size > ZIP32_MAX || deflated.compressedSize > ZIP32_MAX) {
        throw new Error('workspace_archive_exceeds_zip32');
    }
    return deflated;
}
async function rejectionOf(promise) {
    try {
        await promise;
        return undefined;
    }
    catch (error) {
        return error;
    }
}
function localFileHeader(name) {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(VERSION_NEEDED, 4);
    header.writeUInt16LE(GENERAL_PURPOSE_FLAGS, 6);
    header.writeUInt16LE(DEFLATE, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    // CRC-32 and sizes (14..25) stay zero; the data descriptor carries them.
    header.writeUInt16LE(name.byteLength, 26);
    return Buffer.concat([header, name]);
}
function dataDescriptor(entry) {
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(entry.crc >>> 0, 4);
    descriptor.writeUInt32LE(entry.compressedSize, 8);
    descriptor.writeUInt32LE(entry.size, 12);
    return descriptor;
}
function centralDirectoryHeader(name, mode, entry, headerOffset) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(VERSION_MADE_BY, 4);
    header.writeUInt16LE(VERSION_NEEDED, 6);
    header.writeUInt16LE(GENERAL_PURPOSE_FLAGS, 8);
    header.writeUInt16LE(DEFLATE, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(entry.crc >>> 0, 16);
    header.writeUInt32LE(entry.compressedSize, 20);
    header.writeUInt32LE(entry.size, 24);
    header.writeUInt16LE(name.byteLength, 28);
    header.writeUInt32LE(((REGULAR_FILE | (mode & 0o7777)) << 16) >>> 0, 38);
    header.writeUInt32LE(headerOffset, 42);
    return Buffer.concat([header, name]);
}
/** ZIP64 end of central directory record (56 bytes) followed by its locator (20 bytes). */
function zip64EndOfCentralDirectory(entries, size, offset, recordOffset) {
    const record = Buffer.alloc(76);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE((3 << 8) | ZIP64_VERSION, 12);
    record.writeUInt16LE(ZIP64_VERSION, 14);
    record.writeBigUInt64LE(BigInt(entries), 24);
    record.writeBigUInt64LE(BigInt(entries), 32);
    record.writeBigUInt64LE(BigInt(size), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    record.writeUInt32LE(0x07064b50, 56);
    record.writeBigUInt64LE(BigInt(recordOffset), 64);
    record.writeUInt32LE(1, 72);
    return record;
}
function endOfCentralDirectory(entries, size, offset) {
    const record = Buffer.alloc(22);
    record.writeUInt32LE(0x06054b50, 0);
    record.writeUInt16LE(entries, 8);
    record.writeUInt16LE(entries, 10);
    record.writeUInt32LE(size, 12);
    record.writeUInt32LE(offset, 16);
    return record;
}
//# sourceMappingURL=workspace-archive-writer.js.map