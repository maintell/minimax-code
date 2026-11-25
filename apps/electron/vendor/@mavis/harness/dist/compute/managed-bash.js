/**
 * 托管前台 bash（对齐桌面 runManagedForegroundLocalBash）：命令一开始就作为 compute 后台进程启动，前台
 * 最多等 softYieldMs（60s）。
 *
 * - 期间结束：先经 `markDelivered` 标记已投递（结果在前台交给模型，不再进后台完成提醒），再读回输出，按
 *   exec 路径的格式（pi bash 工具回放）返回；pi 截断时附上 task_output 的读取指引（同桌面）。读输出失败
 *   时返回 failed，指向 task_output。
 * - 到点仍在运行：进程继续运行，返回 auto_promoted 与 task id，不重启进程；命令时长从启动算起，转后台不重置。
 * - 等待中被取消：停止后台进程并标记已投递（同桌面），再抛出 AbortError。
 * - 启动失败且未取消：`canFallback` 判定能改走 exec 时调用 `onFallback` 并返回 unavailable，core bash 改按
 *   普通前台命令走 exec；判定不能时返回 failed，不执行第二次。
 * - 轮询：先等后查，间隔从 250ms 起翻倍、最多 1s；查询失败按仍在运行处理。
 * - 输出：每次读 1MiB，最多 8MiB（同 exec 的输出上限），超出记为截断；stdout 与 stderr 已合在一起。
 * - 超时：状态为 timeout，或退出码 124（compute 用 `timeout` 包装命令）且已跑满命令时长。
 */
import { runPiBash, } from '@mavis/agent-tools/core-tools';
import { isPtcChildContext, setBashFullOutput } from './full-output.js';
import { createReplayBashOperations, OUTPUT_TRUNCATED_NOTICE, } from './pi-operations.js';
const FIRST_POLL_MS = 250;
const MAX_POLL_MS = 1_000;
const READ_CHUNK_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** `timeout` 命令超时退出的退出码。 */
const TIMEOUT_EXIT_CODE = 124;
export function createManagedForeground(options) {
    return async (ctx, input, softYieldMs, signal) => {
        const startedAt = Date.now();
        const started = await startOrFallback(options, input.command, {
            cwd: options.root,
            ...(input.timeout ? { timeoutMs: input.timeout * 1000 } : {}),
            turnId: ctx.turnId,
            ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
            ...(signal ? { signal } : {}),
            executionMode: 'managed_foreground',
            ...bashTaskDescription(input),
        });
        if ('result' in started)
            return started.result;
        const { handle } = started;
        const status = await waitForExit(handle, startedAt + softYieldMs, signal);
        if (status === 'aborted') {
            await stopQuietly(handle);
            await options.markDelivered(handle.id);
            throw abortError(signal);
        }
        if (!status)
            return { status: 'auto_promoted', taskId: handle.id };
        await options.markDelivered(handle.id);
        const run = { handle, command: input.command, startedAt };
        return foregroundResult(options.root, input.timeout ? { ...run, timeoutSeconds: input.timeout } : run, status, ctx);
    };
}
/**
 * core bash 在 description 缺省时把它填成命令本身；只有模型给出不同的说明时才交给 compute，
 * 否则 compute 保留自己的显示名。
 */
export function bashTaskDescription(input) {
    const description = input.description?.trim();
    return description && description !== input.command.trim() ? { description } : {};
}
async function startOrFallback(options, command, spawnOptions) {
    try {
        return { handle: await options.spawn(command, spawnOptions) };
    }
    catch (error) {
        if (spawnOptions.signal?.aborted)
            throw abortError(spawnOptions.signal);
        if (options.canFallback?.(error) === false) {
            return {
                result: {
                    status: 'failed',
                    errorMessage: error instanceof Error ? error.message : String(error),
                },
            };
        }
        options.onFallback?.(error);
        return { result: { status: 'unavailable' } };
    }
}
/** 轮询到 `deadline`：返回结束时的状态，仍在运行时返回 undefined。 */
async function waitForExit(handle, deadline, signal) {
    let interval = FIRST_POLL_MS;
    while (Date.now() < deadline) {
        if (await sleep(Math.min(interval, deadline - Date.now()), signal))
            return 'aborted';
        const status = await currentStatus(handle);
        if (signal?.aborted)
            return 'aborted';
        if (status && status.state !== 'running')
            return status;
        interval = Math.min(interval * 2, MAX_POLL_MS);
    }
    return signal?.aborted ? 'aborted' : undefined;
}
/** 等 `ms` 毫秒；被取消时提前返回 true。 */
function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve(true);
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            resolve(true);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve(false);
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
async function currentStatus(handle) {
    try {
        return await handle.status();
    }
    catch {
        return undefined;
    }
}
async function stopQuietly(handle) {
    try {
        await handle.stop('Command aborted');
    }
    catch {
        // 进程可能已经结束；取消照常进行。
    }
}
/** 同桌面 managedBashAbortError：沿用信号自带的 AbortError，否则按取消原因新建。 */
function abortError(signal) {
    const reason = signal?.reason;
    if (reason instanceof Error && reason.name === 'AbortError')
        return reason;
    const message = reason instanceof Error ? reason.message : String(reason ?? 'Operation aborted');
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}
async function foregroundResult(root, run, status, ctx) {
    const taskId = run.handle.id;
    let output;
    try {
        output = await readOutput(run.handle);
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
            status: 'failed',
            taskId,
            errorMessage: `The command finished but its output could not be read: ${reason}. Use task_output with task_id=${taskId} to read it.`,
        };
    }
    // A PTC child gets the whole output back in memory (same exit as the exec
    // path): pi keeps only a head+tail preview and there is no output file on
    // this host. The truncation notice is part of what pi accumulated, so the
    // rebuilt text carries it too.
    if (isPtcChildContext(ctx)) {
        setBashFullOutput(ctx, output.truncated ? `${output.text}${OUTPUT_TRUNCATED_NOTICE}` : output.text, output.truncated);
    }
    const timedOut = isTimedOut(run, status);
    const finished = {
        output: output.text,
        outputTruncated: output.truncated,
        timedOut,
        exitCode: timedOut || status.state !== 'exited' ? null : (status.exitCode ?? null),
    };
    const result = await runPiBash(root, { command: run.command, ...(run.timeoutSeconds ? { timeout: run.timeoutSeconds } : {}) }, { createOperations: () => createReplayBashOperations(finished), persistOutput: false });
    return completedResult(taskId, result);
}
/** 从头读后台进程的输出，最多 {@link MAX_OUTPUT_BYTES}。 */
async function readOutput(handle) {
    let text = '';
    let offset = 0;
    while (offset < MAX_OUTPUT_BYTES) {
        const page = await handle.readOutput(offset, Math.min(READ_CHUNK_BYTES, MAX_OUTPUT_BYTES - offset));
        text += page.chunk;
        if (!page.truncated || page.nextOffset <= offset)
            return { text, truncated: false };
        offset = page.nextOffset;
    }
    return { text, truncated: true };
}
function isTimedOut(run, status) {
    if (status.state === 'timeout')
        return true;
    if (status.exitCode !== TIMEOUT_EXIT_CODE || run.timeoutSeconds === undefined)
        return false;
    return Date.now() - run.startedAt >= run.timeoutSeconds * 1000;
}
/** pi 截断了输出时，同桌面附上完整输出的读取方式。 */
function completedResult(taskId, result) {
    const truncation = result.details?.truncation;
    const text = truncation?.truncated === true
        ? `${result.text}\n\n[Full output: task_output with task_id=${taskId}; continue with next_offset (log file bytes).]`
        : result.text;
    return {
        status: 'completed',
        taskId,
        text,
        ...(result.details ? { details: result.details } : {}),
        ...(result.isError ? { isError: true } : {}),
    };
}
//# sourceMappingURL=managed-bash.js.map