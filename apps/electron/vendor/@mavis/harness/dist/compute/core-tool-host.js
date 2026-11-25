/**
 * ComputeEnvironment → CoreToolHost：桌面 core 工具（@mavis/agent-tools/core-tools）的 IO 端口
 * 落到 compute 上，工具逻辑与桌面共用一份。
 *
 * - fs：每个方法入口先过 reserved 守卫（EACCES）。FileStat 表达不了 FIFO / socket / 块设备，
 *   这三项判定恒为 false；symlink 先 realpath 再 stat（同 node stat 跟随链接）。open 返回惰性
 *   句柄，按 range 读取，不额外 stat。realpath 走 compute：pi 的 mutation queue 以它为 key，
 *   不同 compute 里的同名路径会排进同一队列（只影响并发度）；缺失路径依赖 compute 报 ENOENT。
 * - rg：argv 经 process.exec 在 compute 内执行，选项语义对齐桌面 runRg（stdoutLineRegex /
 *   maxStdoutLines / maxStdoutBytes）；compute 截断输出时丢掉被切断的末行；落在 reserved
 *   目录里的结果行被滤掉。
 * - homedir = workspace.home；没有 home 时 core 拒绝 `~` 路径。
 */
import { Buffer } from 'node:buffer';
import { posix } from 'node:path';
import { computeFsError, readWholeFile, requireComputeFs, requireComputeProcess, } from './compute-paths.js';
import { RG_TIMEOUT_MS, rgCommand } from './rg-command.js';
/** 与桌面 runRg 的 stdout 安全上限一致。 */
const MAX_RG_STDOUT_BYTES = 8 * 1024 * 1024;
export function createComputeToolHost(env, guard) {
    return {
        fs: createComputeToolFs(env, guard),
        runRg: createComputeRgRunner(env, guard),
        homedir: () => env.workspace.home,
    };
}
function createComputeToolFs(env, guard) {
    const allowed = (path) => {
        guard.assertAllowed(path);
        return requireComputeFs(env);
    };
    return {
        access: async (path) => {
            await statFollowingLinks(allowed(path), path, 'access');
        },
        open: async (path) => rangeHandle(allowed(path), path),
        readFile: async (path) => readWholeFile(allowed(path), path),
        realpath: async (path) => allowed(path).realpath(path),
        stat: async (path) => toStats(await statFollowingLinks(allowed(path), path, 'stat')),
        writeFile: async (path, data) => {
            const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
            await allowed(path).writeFile(path, bytes, { mkdirp: true });
        },
        mkdir: async (path, options) => allowed(path).mkdir(path, options),
    };
}
/** 路径不存在时的报错文案与 node fs 一致（`ENOENT: no such file or directory, stat '<path>'`）。 */
async function statFollowingLinks(fs, path, syscall) {
    const stat = await fs.stat(path);
    const target = stat?.type === 'symlink' ? await fs.stat(await fs.realpath(path)) : stat;
    if (!target)
        throw computeFsError('ENOENT', `no such file or directory, ${syscall} '${path}'`);
    return target;
}
function toStats(stat) {
    return {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        isFile: () => stat.type === 'file',
        isDirectory: () => stat.type === 'dir',
        isFIFO: () => false,
        isSocket: () => false,
        isBlockDevice: () => false,
    };
}
function rangeHandle(fs, path) {
    return {
        read: async (buffer, offset, length, position) => {
            const chunk = await fs.readFile(path, { range: { offset: position, length } });
            const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
            return { bytesRead: bytes.copy(buffer, offset, 0, length) };
        },
        close: () => Promise.resolve(),
    };
}
function createComputeRgRunner(env, guard) {
    return async (args, cwd, opts = {}) => {
        const result = await execRg(env, args, cwd, opts);
        const pathOf = rgLinePath(args);
        const lines = completeLines(result).filter((line) => !guard.isReserved(posix.resolve(cwd, pathOf(line))));
        const collected = collectStdout(lines, opts);
        return {
            exitCode: result.exitCode,
            stdout: collected.stdout,
            stderr: result.stderr,
            timedOut: result.timedOut,
            stdoutTruncated: result.outputTruncated || collected.truncated,
        };
    };
}
/** 取消统一报 `Operation aborted`，与桌面 runRg 一致。 */
async function execRg(env, args, cwd, opts) {
    const { signal } = opts;
    if (signal?.aborted)
        throw new Error('Operation aborted');
    let result;
    try {
        result = await requireComputeProcess(env).exec(rgCommand(args), {
            cwd,
            timeoutMs: opts.timeoutMs ?? RG_TIMEOUT_MS,
            ...(signal ? { signal } : {}),
        });
    }
    catch (error) {
        if (signal?.aborted)
            throw new Error('Operation aborted');
        throw error;
    }
    if (signal?.aborted)
        throw new Error('Operation aborted');
    return result;
}
/**
 * 结果行里的路径：`--null` 为 NUL 之前（content 模式），`--count-matches` 为最后一个 `:`
 * 之前，其余整行即路径。只看 `--` 之前的选项，pattern 本身可能长得像选项。
 */
function rgLinePath(args) {
    const end = args.indexOf('--');
    const flags = end < 0 ? args : args.slice(0, end);
    if (flags.includes('--null'))
        return (line) => line.slice(0, Math.max(0, line.indexOf('\0')));
    if (flags.includes('--count-matches')) {
        return (line) => line.slice(0, Math.max(0, line.lastIndexOf(':')));
    }
    return (line) => line;
}
/** compute 截断时末行可能被切断，丢到最后一个换行为止。 */
function completeLines(result) {
    const stdout = result.outputTruncated
        ? result.stdout.slice(0, result.stdout.lastIndexOf('\n') + 1)
        : result.stdout;
    const lines = stdout.split('\n');
    if (lines.at(-1) === '')
        lines.pop();
    return lines;
}
/** 桌面 runRg 的行筛选与上限：regex 作用于去掉 `\r`、`\` 换成 `/` 的行；行数上限只在有 regex 时生效。 */
function collectStdout(lines, opts) {
    const regex = opts.stdoutLineRegex;
    const matched = regex
        ? lines.filter((line) => regex.test(line.replace(/\r$/, '').replaceAll('\\', '/')))
        : lines;
    const maxLines = opts.maxStdoutLines;
    const lineLimited = regex !== undefined && maxLines !== undefined && matched.length >= maxLines;
    const selected = lineLimited ? matched.slice(0, maxLines) : matched;
    const cap = opts.maxStdoutBytes ?? MAX_RG_STDOUT_BYTES;
    let bytes = 0;
    const kept = [];
    for (const line of selected) {
        bytes += Buffer.byteLength(line, 'utf8') + 1;
        if (bytes > cap)
            return { stdout: joinLines(kept), truncated: true };
        kept.push(line);
    }
    return { stdout: joinLines(kept), truncated: lineLimited };
}
function joinLines(lines) {
    return lines.map((line) => `${line}\n`).join('');
}
//# sourceMappingURL=core-tool-host.js.map