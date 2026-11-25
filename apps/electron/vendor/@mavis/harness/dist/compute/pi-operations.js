/**
 * compute 上的 pi BashOperations：core bash 工具（@mavis/agent-tools/core-tools）在 compute
 * 内执行命令时使用。
 *
 * - bash 忽略 pi 传入的 env（那是 harness 主机的 shell 环境），只透传 cwd / timeout / signal。
 * - process 缺失时在调用时报错（不在创建时报错）。
 * - 已在后台进程里跑完的命令用 createReplayBashOperations 回放，截断提示、超时与退出码按 exec 的同一协议
 *   交给 pi，结果格式与 exec 一致。
 */
import { Buffer } from 'node:buffer';
import { requireComputeProcess } from './compute-paths.js';
/** compute 自己截断输出时追加的说明；托管前台与全文出口共用同一句。 */
export const OUTPUT_TRUNCATED_NOTICE = '\n[output truncated: the command exceeded the compute output limit]\n';
/**
 * `capture` 只在 PTC 子调用时给出：它按到达顺序攒下 pi 收到的每个 chunk，
 * 外加截断说明，所以攒到的文本正是 pi 会累计的全文，而不是 stdout 与 stderr
 * 的事后拼接。
 */
export function createBashOperations(env, capture) {
    return {
        separatesOutputStreams: env.capabilities.separatesOutputStreams,
        exec: async (command, cwd, options) => {
            const timeoutSeconds = commandTimeoutSeconds(options);
            const result = await requireComputeProcess(env).exec(command, {
                cwd,
                ...(timeoutSeconds > 0 ? { timeoutMs: timeoutSeconds * 1000 } : {}),
                ...(options.signal ? { signal: options.signal } : {}),
                onData: (chunk, stream) => {
                    capture?.chunks.push(chunk);
                    options.onData(Buffer.from(chunk), stream);
                },
            });
            if (capture)
                capture.outputTruncated = result.outputTruncated;
            return settle(result, options, capture);
        },
    };
}
/** 回放 `run`：输出一次性交给 pi，不再执行任何命令。 */
export function createReplayBashOperations(run) {
    return {
        separatesOutputStreams: false,
        exec: async (_command, _cwd, options) => {
            if (run.output)
                options.onData(Buffer.from(run.output), 'stdout');
            return settle(run, options);
        },
    };
}
/** pi 自定义 operations 的约定：取消抛 `aborted`，超时抛 `timeout:<秒>`，否则返回退出码。 */
function settle(result, options, capture) {
    if (result.outputTruncated) {
        const notice = Buffer.from(OUTPUT_TRUNCATED_NOTICE);
        // The capture must carry the notice too: a rebuilt full output replaces the
        // text pi previewed, and compute's own truncation stays reported either way.
        capture?.chunks.push(notice);
        options.onData(notice, 'stderr');
    }
    if (options.signal?.aborted)
        throw new Error('aborted');
    if (result.timedOut)
        throw new Error(`timeout:${String(commandTimeoutSeconds(options) || '')}`);
    return { exitCode: result.exitCode };
}
function commandTimeoutSeconds(options) {
    return options.timeout !== undefined && options.timeout > 0 ? options.timeout : 0;
}
//# sourceMappingURL=pi-operations.js.map