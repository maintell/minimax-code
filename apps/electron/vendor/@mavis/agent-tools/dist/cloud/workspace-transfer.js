/**
 * 端云协同上传（tar-v1 归档）的校验与流式读取，v1 cloud-runtime 与 v2 harness 共用。
 *
 * - `validateOssTransferStatus`：校验 AS objects/status 返回的归档描述与文件清单；
 * - `readOssTransferArchive`：边下载边解析归档，逐条目校验顺序、元数据、大小与 sha256，
 *   条目内容以流交给调用方，不落本地盘。
 */
import { createHash } from 'node:crypto';
import { isAbsolute, posix } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
export class OssTransferValidationError extends Error {
}
export class OssTransferTransientError extends Error {
}
export function validateOssTransferStatus(status, options) {
    if ((status.state !== 'uploaded' && status.state !== 'materializing') ||
        !status.object ||
        !status.files) {
        throw new OssTransferValidationError('OSS transfer is not ready for materialization');
    }
    if (status.manifest_hash !== options.expectedManifestHash) {
        throw new OssTransferValidationError('OSS transfer manifest binding mismatch');
    }
    if (!status.source_revision_id ||
        status.source_revision_id !== options.expectedSourceRevisionId) {
        throw new OssTransferValidationError('OSS transfer source revision binding mismatch');
    }
    const object = status.object;
    const statusExpiresAt = status.expires_at;
    const objectExpiresAt = object.expires_at;
    const objectSizeBytes = object.size_bytes;
    const objectSha256 = object.sha256;
    const objectUrl = object.url;
    if (object.format !== 'tar-v1')
        throw new OssTransferValidationError('OSS transfer format unsupported');
    if (typeof objectSha256 !== 'string' || !isSha256(objectSha256))
        throw new OssTransferValidationError('OSS transfer archive digest invalid');
    if (typeof objectSizeBytes !== 'number' ||
        !Number.isSafeInteger(objectSizeBytes) ||
        objectSizeBytes <= 0) {
        throw new OssTransferValidationError('OSS transfer archive size invalid');
    }
    if (typeof statusExpiresAt !== 'number' ||
        !Number.isSafeInteger(statusExpiresAt) ||
        statusExpiresAt <= 0 ||
        typeof objectExpiresAt !== 'number' ||
        !Number.isSafeInteger(objectExpiresAt) ||
        objectExpiresAt <= 0) {
        throw new OssTransferValidationError('OSS transfer expiry invalid');
    }
    if (Date.now() >= Math.min(statusExpiresAt, objectExpiresAt)) {
        throw new OssTransferTransientError('OSS transfer download grant expired');
    }
    if (typeof objectUrl !== 'string') {
        throw new OssTransferValidationError('OSS transfer download URL invalid');
    }
    let url;
    try {
        url = new URL(objectUrl);
        if (object.headers) {
            const validatedHeaders = new Headers(object.headers);
            void validatedHeaders;
        }
    }
    catch {
        throw new OssTransferValidationError('OSS transfer download URL invalid');
    }
    if (url.protocol !== 'https:')
        throw new OssTransferValidationError('OSS transfer download URL invalid');
    if (!Number.isSafeInteger(options.maxFileCount) || options.maxFileCount < 0) {
        throw new OssTransferValidationError('OSS transfer file limit invalid');
    }
    if (!Number.isSafeInteger(options.maxTotalBytes) || options.maxTotalBytes < 0) {
        throw new OssTransferValidationError('OSS transfer byte limit invalid');
    }
    if (options.idleTimeoutMs !== undefined &&
        (!Number.isSafeInteger(options.idleTimeoutMs) || options.idleTimeoutMs <= 0)) {
        throw new OssTransferValidationError('OSS transfer idle timeout invalid');
    }
    if (status.files.length > options.maxFileCount) {
        throw new OssTransferValidationError('OSS transfer file count exceeds limit');
    }
    const archiveLimit = options.maxArchiveBytes ?? options.maxTotalBytes + (64 << 20);
    if (!Number.isSafeInteger(archiveLimit) || archiveLimit < 0 || objectSizeBytes > archiveLimit) {
        throw new OssTransferValidationError('OSS transfer archive size exceeds limit');
    }
    let totalBytes = 0;
    const exactPaths = new Set();
    const portableSegments = new Map();
    const portableFiles = new Set();
    const files = status.files.map((file) => {
        if (typeof file.relative_path !== 'string' ||
            typeof file.sha256 !== 'string' ||
            typeof file.size_bytes !== 'number' ||
            typeof file.sensitive !== 'boolean') {
            throw new OssTransferValidationError('OSS transfer file descriptor incomplete');
        }
        validateTransferPath(file.relative_path);
        if (!isSha256(file.sha256))
            throw new OssTransferValidationError('OSS transfer file digest invalid');
        if (!Number.isSafeInteger(file.size_bytes) || file.size_bytes < 0) {
            throw new OssTransferValidationError('OSS transfer file size invalid');
        }
        if (exactPaths.has(file.relative_path))
            throw new OssTransferValidationError('OSS transfer file path duplicated');
        exactPaths.add(file.relative_path);
        const segments = file.relative_path.split('/');
        for (let index = 1; index <= segments.length; index += 1) {
            const prefix = segments.slice(0, index).join('/').normalize('NFC');
            const portable = prefix.toLocaleLowerCase('en-US');
            const collision = portableSegments.get(portable);
            if (collision && collision !== prefix) {
                throw new OssTransferValidationError('OSS transfer file path collision');
            }
            portableSegments.set(portable, prefix);
        }
        portableFiles.add(file.relative_path.normalize('NFC').toLocaleLowerCase('en-US'));
        totalBytes += file.size_bytes;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > options.maxTotalBytes) {
            throw new OssTransferValidationError('OSS transfer total size exceeds limit');
        }
        return {
            relative_path: file.relative_path,
            sha256: file.sha256,
            size_bytes: file.size_bytes,
            sensitive: file.sensitive,
        };
    });
    for (const path of exactPaths) {
        const segments = path.split('/');
        for (let index = 1; index < segments.length; index += 1) {
            const parentPath = segments
                .slice(0, index)
                .join('/')
                .normalize('NFC')
                .toLocaleLowerCase('en-US');
            if (portableFiles.has(parentPath)) {
                throw new OssTransferValidationError('OSS transfer file path collision');
            }
        }
    }
    return {
        object: {
            format: object.format,
            size_bytes: objectSizeBytes,
            sha256: objectSha256,
            url: objectUrl,
            expires_at: objectExpiresAt,
            ...(object.headers ? { headers: object.headers } : {}),
        },
        files,
        deadlineAtMs: statusExpiresAt,
    };
}
export function validTarFileMetadata(entry) {
    const isEpochOrAbsent = (value) => value === undefined || value.getTime() === 0;
    return (entry.mode === 0o600 &&
        (entry.uid ?? 0) === 0 &&
        (entry.gid ?? 0) === 0 &&
        (entry.uname ?? '') === '' &&
        (entry.gname ?? '') === '' &&
        isEpochOrAbsent(entry.mtime) &&
        entry.atime === undefined &&
        entry.ctime === undefined);
}
export function validateTransferPath(path) {
    if (!path ||
        path === '.' ||
        path === '..' ||
        path.includes('\\') ||
        path.includes(':') ||
        path.includes('\0') ||
        path.startsWith('/') ||
        path.startsWith('../') ||
        isAbsolute(path) ||
        posix.normalize(path) !== path ||
        path === '.git' ||
        path.startsWith('.git/') ||
        path === '.mavis' ||
        path.startsWith('.mavis/')) {
        throw new OssTransferValidationError('OSS transfer file path invalid');
    }
}
export function normalizedTarEntryPath(entryPath) {
    let value = entryPath;
    while (value.startsWith('./'))
        value = value.slice(2);
    return value.replace(/\/$/u, '');
}
export function isSha256(value) {
    return /^[a-f0-9]{64}$/u.test(value);
}
/**
 * 流式校验并读取 tar-v1 归档。条目必须按 UTF-8 字节序与清单一一对应；任一校验失败、
 * onEntry 失败或 signal 取消都会中止读取并抛错。结束时校验归档总大小与 sha256。
 * 空清单只接受 1024 字节全零的规范空归档（node-tar 不接受这种输入）。
 */
export async function readOssTransferArchive(input) {
    const archive = { bytes: 0, hash: createHash('sha256') };
    const empty = input.files.length === 0;
    const measure = new Transform({
        transform(chunk, _encoding, callback) {
            input.onProgress?.();
            archive.bytes += chunk.byteLength;
            if (archive.bytes > input.object.size_bytes) {
                callback(new OssTransferValidationError('OSS transfer archive exceeds declared size'));
                return;
            }
            if (empty && (input.object.size_bytes !== 1024 || chunk.some((byte) => byte !== 0))) {
                callback(new OssTransferValidationError('OSS empty archive invalid'));
                return;
            }
            archive.hash.update(chunk);
            callback(null, chunk);
        },
    });
    const reader = empty ? undefined : new ArchiveEntryReader(input);
    const sink = reader?.parser ?? new Writable({ write: (_chunk, _encoding, done) => done() });
    try {
        await pipeline(input.body, measure, sink, input.signal ? { signal: input.signal } : {});
    }
    catch (error) {
        reader?.fail(asError(error));
        await reader?.settled();
        throw reader?.failure ?? error;
    }
    await reader?.finish();
    if (archive.bytes !== input.object.size_bytes ||
        archive.hash.digest('hex') !== input.object.sha256) {
        throw new OssTransferValidationError('OSS transfer archive integrity check failed');
    }
}
class ArchiveEntryReader {
    input;
    parser;
    failure;
    expected;
    ordered;
    index = 0;
    current;
    pending = Promise.resolve();
    constructor(input) {
        this.input = input;
        this.expected = new Map(input.files.map((file) => [file.relative_path, file]));
        this.ordered = input.files
            .map((file) => file.relative_path)
            .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
        this.parser = new tar.Parser({
            strict: true,
            onReadEntry: (entry) => this.onReadEntry(entry),
        });
    }
    fail(error) {
        this.failure ??= error;
        this.current?.destroy(this.failure);
        this.input.body.destroy(this.failure);
    }
    async settled() {
        await this.pending;
    }
    async finish() {
        await this.pending;
        if (this.failure)
            throw this.failure;
        if (this.index !== this.ordered.length) {
            throw new OssTransferValidationError('OSS transfer tar file count mismatch');
        }
    }
    onReadEntry(entry) {
        // 与 v1 解包一致：根目录条目（`./`）不计入清单，直接跳过。
        if (this.failure || normalizedTarEntryPath(entry.path) === '') {
            entry.resume();
            return;
        }
        let file;
        try {
            file = this.acceptEntry(entry);
        }
        catch (error) {
            entry.resume();
            this.fail(asError(error));
            return;
        }
        const content = hashingStream();
        this.current = content.stream;
        entry.pipe(content.stream);
        const verify = () => content.verify(file);
        this.pending = this.pending
            .then(async () => {
            if (this.failure)
                throw this.failure;
            await this.input.onEntry({ file, content: content.stream, verify });
            verify();
        })
            .catch((error) => this.fail(asError(error)));
    }
    acceptEntry(entry) {
        const relativePath = normalizedTarEntryPath(entry.path);
        if (relativePath !== this.ordered[this.index]) {
            throw new OssTransferValidationError(this.index >= this.ordered.length
                ? 'OSS transfer tar entry count exceeds manifest'
                : 'OSS transfer tar path order invalid');
        }
        this.index += 1;
        validateTransferPath(relativePath);
        if (entry.type !== 'File' && entry.type !== 'OldFile') {
            throw new OssTransferValidationError('OSS transfer tar entry type unsupported');
        }
        if (!validTarFileMetadata(entry)) {
            throw new OssTransferValidationError('OSS transfer tar metadata invalid');
        }
        const descriptor = this.expected.get(relativePath);
        if (!descriptor) {
            throw new OssTransferValidationError('OSS transfer tar contains unexpected file');
        }
        if (entry.size !== descriptor.size_bytes) {
            throw new OssTransferValidationError('OSS transfer tar file size mismatch');
        }
        return descriptor;
    }
}
function hashingStream() {
    const hash = createHash('sha256');
    let bytes = 0;
    const stream = new Transform({
        transform(chunk, _encoding, callback) {
            bytes += chunk.byteLength;
            hash.update(chunk);
            callback(null, chunk);
        },
    });
    // 失败时会 destroy 尚未被消费的条目流；消费方自己的 for-await / pipeline 仍能收到错误，
    // 这里只防止无人监听时变成进程级 uncaught。
    stream.on('error', () => undefined);
    return {
        stream,
        // 条目大小已与清单一致，经过本流的字节数达到清单大小即内容完整；不依赖 flush 时序。
        verify(file) {
            if (bytes !== file.size_bytes || hash.copy().digest('hex') !== file.sha256) {
                throw new OssTransferValidationError('OSS transfer file integrity check failed');
            }
        },
    };
}
function asError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
//# sourceMappingURL=workspace-transfer.js.map