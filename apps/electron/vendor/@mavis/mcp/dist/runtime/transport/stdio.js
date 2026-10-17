/**
 * Stdio MCP transport for Mavis runtimes.
 *
 * Ported from the retired `packages/daemon/src/mcp/runtime/transport/stdio.ts`,
 * narrowed to the surface Mavis runtimes need:
 *
 *   * `cwd: homedir()` — never inherit launchd / Electron / systemd CWD (which
 *     can be `/`), so MCP children that write workspace-relative dirs
 *     (such as Playwright's `.playwright-mcp/`) don't
 *     ENOENT against `/`.
 *   * `stderr: 'pipe'` — the SDK creates a PassThrough but no consumer
 *     attaches by default. The connection pool's `attachStderrLogging` reads
 *     this stream and emits per-line log records; without `'pipe'` here that
 *     hook would silently no-op. We also attach an error handler to the raw
 *     child stderr pipe because Node does not forward source stream errors
 *     through `.pipe()`.
 *   * `env` constructed as `{ ...process.env, ...config.env, ...injected.env }`
 *     — injected env wins so host-provided identity or policy data can
 *     override any stale value baked into config or leaking from the parent
 *     process env.
 */
import { homedir } from 'node:os';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
export function createStdioTransport(config, options) {
    return new SafeStdioClientTransport({
        command: config.command,
        args: config.args,
        env: buildProcessEnv(config.env, options?.env),
        cwd: config.cwd ?? homedir(),
        stderr: 'pipe',
    });
}
class SafeStdioClientTransport extends StdioClientTransport {
    async start() {
        await super.start();
        const childProcess = this._process;
        childProcess?.stderr?.on?.('error', (error) => {
            this.onerror?.(error);
        });
    }
}
function buildProcessEnv(configEnv, injectedEnv) {
    return {
        ...getProcessEnv(),
        ...(configEnv ?? {}),
        ...(injectedEnv ?? {}),
    };
}
function getProcessEnv() {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (typeof value === 'string')
            env[key] = value;
    }
    return env;
}
//# sourceMappingURL=stdio.js.map