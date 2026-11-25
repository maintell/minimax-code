/**
 * 从 ComputeEnvironment 派生 core 工具（read / write / edit / bash / grep / glob）。工具 def、
 * 结果格式与处理逻辑直接复用桌面实现（@mavis/agent-tools/core-tools），IO 经
 * createComputeToolHost 落到 compute 的 fs / process 上。
 *
 * - kind = 'none' 或没有 fs：不提供任何工具；没有 process：只提供 read / write / edit。
 * - 桌面专属能力按 capabilities 关闭：后台 bash 仅在 backgroundProcess 为真且 compute 提供
 *   spawnBackground 时开放，否则 schema 去掉 run_in_background；host trash、子进程环境清洗、
 *   权限执行计划、srt 沙箱都不接入；bash 输出不在 harness 主机落盘。
 * - 后台命令的时长与完成方式、单条前台命令的上限由宿主经 options 给出（云端为 AS 的 1800s 与下一轮
 *   提醒、ExecuteShell 同步上限 270s），schema 与工具结果写实际值；缺省为桌面约定。后台命令带上发起
 *   它的 turn 与 tool call。
 * - 宿主给出 backgroundBash.autoBackground 时前台命令走托管前台（managed-bash.ts）：60s 内结束按前台
 *   结果返回，否则转为后台任务，不重启进程；run_code 内的 bash 子调用不转后台。不给时前台命令走 exec。
 * - `~` 按 workspace.home 展开：pi 的文件工具按 harness 进程的 home 展开，所以 read / write /
 *   edit 的路径在交给 core 前预展开；没有 home 时报错。
 * - reservedPaths 对 read / write / edit / grep / glob 生效；bash 不拦截（已知限制）。
 * - grep 的 files_with_matches 固定按文件名排序；桌面生产按 mtime 排序，compute 上逐个 stat 代价高。
 * - 每次工具执行结束（成功或抛错）都调用一次 `onInvocationEnd()`；它抛错时本次工具调用失败。
 * - read 读视频按工具上下文的 parentAgentConfig.model.capabilities 门控（support_video、
 *   max_video_bytes_inline、max_request_body_bytes），与 v1 CloudReadTool 共用同一 helper；
 *   harness 把准备好的 agentConfig 作为 parentAgentConfig，Host 准备时须保留 model.capabilities。
 */
import { defineRuntimeTool, } from '@mavis/agent-core/tools';
import { CoreBashTool, CoreEditTool, CoreGlobTool, CoreGrepTool, CoreReadTool, CoreWriteTool, createBashToolSchema, expandHomePath, LocalBashToolDef, LocalEditToolDef, LocalGlobToolDef, LocalGrepToolDef, LocalReadToolDef, LocalWriteToolDef, } from '@mavis/agent-tools/core-tools';
import { createReservedPathGuard } from './compute-paths.js';
import { createComputeToolHost } from './core-tool-host.js';
import { bashFullOutputCapture, isPtcChildContext, readBashFullOutput } from './full-output.js';
import { bashTaskDescription, createManagedForeground } from './managed-bash.js';
import { createBashOperations } from './pi-operations.js';
/**
 * 宿主 `prepareBashTools` 用：本 Turn 不能消费后台输出（没有 native task_output）时 harness 不让 bash 显式或自动转后台，
 * builtin 的 bash 换成不带后台的 schema，写明宿主的单条前台命令上限；其他来源的同名工具不改。
 */
export function prepareComputeBashTools(tools, background, maxForegroundTimeoutSeconds) {
    if (background)
        return tools;
    return tools.map((tool) => tool.def.name === LocalBashToolDef.name &&
        (tool.source === undefined || tool.source === 'builtin')
        ? {
            ...tool,
            def: {
                ...tool.def,
                schema: createBashToolSchema(false, undefined, undefined, undefined, maxForegroundTimeoutSeconds),
            },
        }
        : tool);
}
/** LocalBashToolDef 的约定：显式后台命令不给 timeout 时以 1 小时为运行上限。 */
const BACKGROUND_DEFAULT_TIMEOUT_SECONDS = 3_600;
export function createComputeCoreTools(env, options = {}) {
    if (env.kind === 'none' || !env.fs)
        return [];
    const root = env.workspace.root;
    const host = createComputeToolHost(env, createReservedPathGuard(root, options.reservedPaths));
    const fileTools = createFileTools(env, host);
    if (!env.process)
        return fileTools;
    const grep = new CoreGrepTool(root, host, { sortMode: 'name' });
    const glob = new CoreGlobTool(root, host);
    return [
        ...fileTools,
        createBashTool(env, env.process, options),
        builtin(env, LocalGrepToolDef, (ctx, input, signal) => grep.execute(ctx, input, signal)),
        builtin(env, LocalGlobToolDef, (ctx, input, signal) => glob.execute(ctx, input, signal)),
    ];
}
function createFileTools(env, host) {
    const { root, home } = env.workspace;
    const read = new CoreReadTool(root, host);
    const write = new CoreWriteTool(root, host);
    const edit = new CoreEditTool(root, host);
    return [
        builtin(env, LocalReadToolDef, async (ctx, input, signal) => read.execute(ctx, { ...input, path: expandHomePath(input.path, home) }, signal)),
        builtin(env, LocalWriteToolDef, async (ctx, input, signal) => write.execute(ctx, { ...input, path: expandHomePath(input.path, home) }, signal)),
        builtin(env, LocalEditToolDef, async (ctx, input, signal) => edit.execute(ctx, { ...input, file_path: expandHomePath(input.file_path, home) }, signal)),
    ];
}
/** Registered counter of a run_code child's bash full output; the registry owns its labels. */
const PTC_CHILD_BASH_FULL_OUTPUT_TOTAL = 'ptc_child_bash_full_output_total';
function createBashTool(env, computeProcess, options) {
    const { backgroundBash, maxForegroundTimeoutSeconds } = options;
    const background = createBackgroundAdapter(env, computeProcess, backgroundBash);
    const managedTimeoutSeconds = background?.runManagedForeground
        ? backgroundBash?.autoBackground?.timeoutSeconds
        : undefined;
    const tool = new CoreBashTool(env.workspace.root, {
        // 只为 PTC 子调用攒全文：顶层 bash 与桌面一样只拿到预览。
        createOperations: (ctx) => createBashOperations(env, isPtcChildContext(ctx) ? bashFullOutputCapture(ctx) : undefined),
        persistOutput: false,
        // compute 上没有 pi 落在本机的完整输出文件，把攒到的全文交给 bash 工具拼回。
        readFullOutput: async (ctx) => readBashFullOutput(ctx),
        onChildFullOutput: (outcome) => {
            try {
                options.metrics?.counter(PTC_CHILD_BASH_FULL_OUTPUT_TOTAL, 1, { outcome });
            }
            catch {
                // Metrics must not change the tool outcome.
            }
        },
        ...(background ? { backgroundAdapter: background } : {}),
        ...(backgroundBash ? { backgroundCompletion: backgroundBash.completion } : {}),
        ...(maxForegroundTimeoutSeconds === undefined ? {} : { maxForegroundTimeoutSeconds }),
        ...(managedTimeoutSeconds === undefined
            ? {}
            : { maxManagedTimeoutSeconds: managedTimeoutSeconds }),
    });
    // 没有托管前台时只提供显式后台，schema 不描述自动转后台。
    const def = {
        ...LocalBashToolDef,
        schema: createBashToolSchema(Boolean(background), managedTimeoutSeconds !== undefined, backgroundBash?.timeoutSeconds, managedTimeoutSeconds, maxForegroundTimeoutSeconds),
    };
    if (!background) {
        return builtin(env, def, (ctx, input, signal) => tool.execute(ctx, input, signal));
    }
    // 后台输出由 compute 的后台任务读取；host 显式声明不可消费时仍以 ctx 为准。
    return builtin(env, def, (ctx, input, signal) => tool.execute({ ...ctx, canConsumeBackgroundBashOutput: ctx.canConsumeBackgroundBashOutput ?? true }, input, signal));
}
/**
 * 显式后台的时长取宿主给出的后台时长（默认值兼上限），结果里写实际生效的值；宿主给出 autoBackground 时
 * 另提供托管前台。
 */
function createBackgroundAdapter(env, computeProcess, backgroundBash) {
    const spawnBackground = computeProcess.spawnBackground?.bind(computeProcess);
    if (!env.capabilities.backgroundProcess || !spawnBackground)
        return undefined;
    const cwd = env.workspace.root;
    const limitSeconds = backgroundBash?.timeoutSeconds;
    const auto = backgroundBash?.autoBackground;
    return {
        ...(auto
            ? {
                runManagedForeground: createManagedForeground({
                    root: cwd,
                    spawn: spawnBackground,
                    markDelivered: (taskId) => auto.markDelivered(taskId),
                    ...(auto.onFallback ? { onFallback: (error) => auto.onFallback?.(error) } : {}),
                    ...(auto.canFallback
                        ? { canFallback: (error) => auto.canFallback?.(error) !== false }
                        : {}),
                }),
            }
            : {}),
        startBackground: async (ctx, input, signal) => {
            const timeoutSeconds = backgroundTimeoutSeconds(input.timeout, limitSeconds);
            try {
                const handle = await spawnBackground(input.command, {
                    cwd,
                    timeoutMs: timeoutSeconds * 1000,
                    turnId: ctx.turnId,
                    ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
                    ...(signal ? { signal } : {}),
                    executionMode: 'explicit_background',
                    ...bashTaskDescription(input),
                });
                return {
                    status: 'started',
                    taskId: handle.id,
                    ...(limitSeconds === undefined
                        ? {}
                        : { details: { timing: { commandTimeoutSeconds: timeoutSeconds } } }),
                };
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return { status: 'failed', errorMessage };
            }
        },
    };
}
function backgroundTimeoutSeconds(requested, limitSeconds) {
    if (limitSeconds === undefined)
        return requested ?? BACKGROUND_DEFAULT_TIMEOUT_SECONDS;
    return Math.min(requested ?? limitSeconds, limitSeconds);
}
/** 桌面 def 原样作为 builtin 工具；label 沿用桌面（不设）。每次执行结束调用 `onInvocationEnd()`。 */
function builtin(env, def, execute) {
    return defineRuntimeTool({
        ...def,
        source: 'builtin',
        execute: async (...args) => {
            try {
                return await execute(...args);
            }
            finally {
                await env.onInvocationEnd();
            }
        },
    });
}
//# sourceMappingURL=core-tools.js.map