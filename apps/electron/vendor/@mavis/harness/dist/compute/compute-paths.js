/**
 * compute 路径与文件读取的公共逻辑：路径解析、reserved 目录守卫、带 errno 的错误、
 * 按 8MB 分段的整文件读取。不做 workspace 围栏：越界路径由 compute 实现拒绝
 * （cloud-sandbox 为 AS 返回 COMPUTE_PATH_REJECTED）。
 */
import { Buffer } from 'node:buffer';
import { posix } from 'node:path';
/** 单次 readFile 的上限，与 cloud-sandbox 文件 RPC 一致。 */
const READ_CHUNK_BYTES = 8 * 1024 * 1024;
/** 整文件读取的上限；更大的文件让模型改用 bash 的 head / sed 分段查看。 */
const MAX_WHOLE_FILE_BYTES = 32 * 1024 * 1024;
/** 相对路径以 `root` 为基准，结果为规范化的 POSIX 绝对路径。 */
function resolveComputePath(root, input) {
    return posix.resolve(root, input);
}
/** 带 errno 风格 `code` 的错误；pi 的 mutation queue 按 ENOENT / ENOTDIR 识别缺失路径。 */
export function computeFsError(code, message) {
    return Object.assign(new Error(`${code}: ${message}`), { code });
}
/** `reservedDirs` 相对 `root`，对 agent 工具不可见、不可写。 */
export function createReservedPathGuard(root, reservedDirs = []) {
    const reserved = reservedDirs
        .filter((dir) => dir.trim() !== '')
        .map((dir) => resolveComputePath(root, dir))
        .filter((dir) => dir !== posix.resolve(root));
    const isReserved = (absolutePath) => {
        const normalized = posix.resolve(absolutePath);
        return reserved.some((dir) => normalized === dir || normalized.startsWith(`${dir}/`));
    };
    return {
        isReserved,
        assertAllowed(absolutePath) {
            if (isReserved(absolutePath)) {
                throw computeFsError('EACCES', `path is reserved by the harness: ${absolutePath}`);
            }
        },
    };
}
export function requireComputeFs(env) {
    if (!env.fs)
        throw new Error(`compute '${env.kind}' has no file system`);
    return env.fs;
}
export function requireComputeProcess(env) {
    if (!env.process)
        throw new Error(`compute '${env.kind}' has no process support`);
    return env.process;
}
/** 按 8MB 分段读到短块为止；超过 32MiB 报错。 */
export async function readWholeFile(fs, path) {
    const chunks = [];
    let offset = 0;
    for (;;) {
        const chunk = await fs.readFile(path, { range: { offset, length: READ_CHUNK_BYTES } });
        chunks.push(chunk);
        offset += chunk.byteLength;
        if (chunk.byteLength < READ_CHUNK_BYTES)
            return Buffer.concat(chunks);
        if (offset >= MAX_WHOLE_FILE_BYTES) {
            throw new Error(`${path} exceeds the ${MAX_WHOLE_FILE_BYTES / 1024 / 1024} MiB read limit; use bash (head, tail, sed -n) to inspect it in parts`);
        }
    }
}
//# sourceMappingURL=compute-paths.js.map