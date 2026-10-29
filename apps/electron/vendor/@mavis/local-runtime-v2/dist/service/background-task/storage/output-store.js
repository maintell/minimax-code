import { appendFile, mkdir, open, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
const DEFAULT_OUTPUT_READ_LIMIT_BYTES = 64 * 1024;
const UTF8_RANGE_ALIGNMENT_BYTES = 6;
const TASK_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
export class FsLocalTaskOutputStore {
    dataDir;
    constructor(dataDir) {
        this.dataDir = dataDir;
    }
    async append(chunk) {
        const file = this.outputFile(chunk.taskId);
        await mkdir(path.dirname(file), { recursive: true });
        const currentSize = (await fileInfo(file))?.size ?? 0;
        const offset = chunk.offset ?? currentSize;
        await appendFile(file, chunk.content, 'utf8');
        return {
            taskId: chunk.taskId,
            kind: 'file',
            uri: file,
            offset: offset + Buffer.byteLength(chunk.content, 'utf8'),
            updatedAt: chunk.timestamp ?? Date.now(),
        };
    }
    async read(taskId, options = {}) {
        const file = this.outputFile(taskId);
        const offset = normalizeByteOffset(options.offset);
        const limit = Math.max(0, options.limitBytes ?? DEFAULT_OUTPUT_READ_LIMIT_BYTES);
        const slice = await readUtf8Range(file, offset, limit);
        const updatedAt = await mtimeMs(file);
        return {
            content: slice.content,
            nextOffset: slice.nextOffset,
            truncated: slice.truncated,
            outputRef: {
                taskId,
                kind: 'file',
                uri: file,
                offset: slice.nextOffset,
                ...(updatedAt === undefined ? {} : { updatedAt }),
            },
        };
    }
    async tail(taskId, limitBytes = 8_192) {
        const file = this.outputFile(taskId);
        const size = (await fileInfo(file))?.size ?? 0;
        const offset = Math.max(0, size - limitBytes);
        return this.read(taskId, { offset, limitBytes });
    }
    async finalize(taskId, summary) {
        if (summary === undefined)
            return;
        const file = this.summaryFile(taskId);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, summary, 'utf8');
    }
    async verifyReadable(taskId, hasSavedOutput) {
        try {
            const handle = await open(this.outputFile(taskId), 'r');
            await handle.close();
        }
        catch (error) {
            if (hasSavedOutput || error.code !== 'ENOENT')
                throw error;
        }
    }
    outputFile(taskId) {
        return path.join(this.taskDir(taskId), 'output.log');
    }
    summaryFile(taskId) {
        return path.join(this.taskDir(taskId), 'summary.txt');
    }
    taskDir(taskId) {
        if (!TASK_ID_PATTERN.test(taskId))
            throw new Error(`Invalid local background task id: ${taskId}`);
        return path.join(resolveDataDir(this.dataDir), 'background-tasks', taskId);
    }
}
async function readUtf8Range(file, offset, limitBytes) {
    let handle;
    try {
        handle = await open(file, 'r');
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        return { content: '', nextOffset: 0, truncated: false };
    }
    try {
        const size = (await handle.stat()).size;
        const readOffset = Math.min(offset, size);
        // An arbitrary offset may first skip three continuation bytes, then need
        // three more bytes to complete a 4-byte code point at the page end.
        const buffer = Buffer.alloc(Math.min(size - readOffset, limitBytes + UTF8_RANGE_ALIGNMENT_BYTES));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, readOffset);
        const available = buffer.subarray(0, bytesRead);
        return alignUtf8Range(available, readOffset, size, limitBytes);
    }
    finally {
        await handle.close();
    }
}
function isUtf8ContinuationByte(byte) {
    return ((byte ?? 0) & 0xc0) === 0x80;
}
function normalizeByteOffset(offset) {
    return Number.isFinite(offset) ? Math.max(0, Math.floor(offset ?? 0)) : 0;
}
async function mtimeMs(file) {
    const info = await fileInfo(file);
    return info ? Math.floor(info.mtimeMs) : undefined;
}
function resolveDataDir(dataDir) {
    return typeof dataDir === 'function' ? dataDir() : dataDir;
}
async function fileInfo(file) {
    try {
        return await stat(file);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        return undefined;
    }
}
function alignUtf8Range(available, readOffset, size, limitBytes) {
    let start = 0;
    while (isUtf8ContinuationByte(available[start]))
        start += 1;
    const end = utf8RangeEnd(available, start, limitBytes, size - readOffset);
    return {
        content: available.subarray(start, end).toString('utf8'),
        nextOffset: readOffset + end,
        truncated: readOffset + end < size,
    };
}
function utf8RangeEnd(available, start, limitBytes, remainingBytes) {
    let end = Math.min(available.length, start + limitBytes);
    while (end > start && end < remainingBytes && isUtf8ContinuationByte(available[end]))
        end -= 1;
    if (end === start && start < available.length && limitBytes > 0) {
        end += 1;
        while (end < available.length && isUtf8ContinuationByte(available[end]))
            end += 1;
    }
    return end;
}
//# sourceMappingURL=output-store.js.map