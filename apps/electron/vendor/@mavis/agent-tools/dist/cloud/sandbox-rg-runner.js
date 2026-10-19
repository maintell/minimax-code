/**
 * Sandbox 侧 ripgrep 执行器 —— grep / glob 工具共用。
 *
 * 不在 cloud-runtime 自己的 Node 进程里 spawn rg(进程持有 K8s SA / OSS AK
 * 等敏感凭证),而是通过 `archonServer.executeShell` 转给沙箱里的 pod-manager
 * 在隔离进程中跑 rg。这是为了让所有"读 workspace fs"的工具统一走 bash
 * 一样的审计通路;并非真正的 Linux namespace 隔离(pod-manager 跟 harness
 * 共享容器),那是另一个 PR 的事。
 *
 * 这里只暴露 `runRgInSandbox` 给上层 tool 实现用;quote 等纯静态 helper 也
 * 一并导出,方便测试。
 */
import { SENSITIVE_GLOB_EXCLUDES } from '../shared/rg-sensitive.js';
// Re-export for downstream consumers (cloud-runtime re-exports it from
// `@mavis/agent-tools/cloud`); the source of truth lives in shared/.
export { SENSITIVE_GLOB_EXCLUDES };
const RG_BINARY = 'rg';
const DEFAULT_TIMEOUT_SECONDS = 30;
const SAFE_ARG_RE = /^[A-Za-z0-9_./:=-]+$/;
/**
 * POSIX 单引号 quoting。安全字符直接原样返回,其它字符走 `'…'` + 内部
 * `'\''` 转义。空串变 `''`。
 */
export function shellQuote(arg) {
    if (arg === '')
        return "''";
    if (SAFE_ARG_RE.test(arg))
        return arg;
    return `'${arg.replace(/'/g, `'\\''`)}'`;
}
export function withSensitiveExcludeArgs(args) {
    const out = [...args];
    for (const pattern of SENSITIVE_GLOB_EXCLUDES) {
        out.push(`--glob=${shellQuote(pattern)}`);
    }
    return out;
}
/**
 * 组装 `cd <cwd> && rg <args...> -- <pattern> <targets...>` 命令字符串。
 * 每一段都 shell-quote;LLM 控制的 pattern 放 `--` 之后做 positional,
 * 避免它通过 pattern 字段塞入额外 flag。
 */
export function buildRgCommand(opts) {
    const rgInvocation = [RG_BINARY, ...opts.args, '--', ...opts.patternAndTargets.map(shellQuote)]
        .filter((part) => part !== null && part !== undefined && part !== '')
        .join(' ');
    return `cd ${shellQuote(opts.cwd)} && ${rgInvocation}`;
}
export async function runRgInSandbox(executor, opts) {
    if (opts.signal?.aborted) {
        throw new Error('Operation aborted');
    }
    const command = buildRgCommand({
        cwd: opts.cwd,
        args: opts.args,
        patternAndTargets: opts.patternAndTargets,
    });
    const response = await executor.executeShell(opts.ctx, {
        command,
        timeout_seconds: opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    }, opts.signal);
    if (opts.signal?.aborted) {
        throw new Error('Operation aborted');
    }
    const outputTruncated = response.output_truncated ?? false;
    let stdout = response.stdout ?? '';
    if (outputTruncated) {
        // The sandbox cut the stream mid-line; drop the torn tail so a partial
        // path/content fragment never surfaces as a hallucinated result.
        stdout = stdout.slice(0, stdout.lastIndexOf('\n') + 1);
    }
    return {
        exitCode: response.exit_code ?? 0,
        stdout,
        stderr: response.stderr ?? '',
        timedOut: response.timed_out ?? false,
        outputTruncated,
    };
}
//# sourceMappingURL=sandbox-rg-runner.js.map