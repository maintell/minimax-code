import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { MAX_BROKER_LINE_BYTES } from "./abe-broker-protocol";
/**
 * Windows 上与 SYSTEM broker 建立一次会话的连接器。
 *
 * 一次会话的动作顺序是固定的：
 *
 *   1. 定位 broker 可执行文件；
 *   2. 生成会话 id，以 `--elevate` 启动 broker —— 提权、服务注册与启动全在
 *      broker 内部完成，本模块不碰任何特权操作；
 *   3. 等管道出现并作为客户端连上；
 *   4. 把连接包成 `AbeBrokerConnection` 交给会话层。
 *
 * 为什么提权不放在这里：让宿主进程去安装服务或调 ShellExecuteEx，就得把
 * 「怎么拿到 SYSTEM」的知识散到两个地方，而且宿主侧没有可测的边界。broker 是
 * 仓库内可单测的原生助手，把整条特权路径留在它内部，宿主只负责起进程和连管道。
 */
/** 会话管道所在命名空间，与 broker 侧 `pipePathPrefix` 必须一致。 */
export let ABE_PIPE_PREFIX = ['\\\\.\\pipe\\', 'mavis-abe-'].join('');
/** 连接重试间隔：管道由服务进程创建，客户端只能轮询等它出现。 */
const CONNECT_RETRY_INTERVAL_MS = 100;
/**
 * 定位随包分发的 broker 可执行文件。
 *
 * 与 session-transfer 助手用同一套查找顺序，避免两处各写一份规则后随打包布局
 * 变化而分叉。
 */
export function resolveAbeBrokerBinary(override) {
    if (override)
        return override;
    if (process.platform !== 'win32')
        return undefined;
    const binaryName = 'MiniMax Code.exe';
    const platformDirectory = `${process.platform}-${process.arch}`;
    const proc = process;
    const roots = [
        ...(process.versions.electron && proc.resourcesPath
            ? [path.join(proc.resourcesPath, 'resources')]
            : []),
        path.join(__dirname, '..', '..', '..', '..', 'resources'),
    ];
    for (const root of roots) {
        const candidate = path.join(root, 'abe-broker', platformDirectory, binaryName);
        if (existsSync(candidate))
            return candidate;
    }
    return undefined;
}
function defaultLaunch(binaryPath, args) {
    const child = spawn(binaryPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
        // 只留尾部：broker 的诊断可能很长，而调用方只需要最后的失败原因。
        stderr = (stderr + chunk.toString('utf8')).slice(-4096);
    });
    const exited = new Promise((resolve) => {
        child.once('exit', (code) => resolve({ code, stderr }));
        child.once('error', (error) => resolve({ code: null, stderr: error.message }));
    });
    return { exited, kill: () => child.kill() };
}
function defaultConnect(pipePath) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(pipePath);
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
    });
}
const defaultSleep = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
});
/**
 * 把已连接的管道包成 `AbeBrokerConnection`。
 *
 * 读侧自己做行缓冲：socket 的 data 事件按 TCP/管道分片到达，一行完全可能跨多个
 * 分片。这里假定每次 `receive` 消费一行，与 broker 侧一问一答的约定一致。
 */
function wrapConnection(socket) {
    let pending = '';
    let waiting = null;
    let failure = null;
    const deliver = () => {
        if (!waiting)
            return;
        const index = pending.indexOf('\n');
        if (index < 0) {
            if (failure) {
                const settle = waiting;
                waiting = null;
                settle(null);
            }
            return;
        }
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        const settle = waiting;
        waiting = null;
        settle(line);
    };
    socket.on('data', (chunk) => {
        pending += chunk.toString('utf8');
        // 超长行说明对端已经不符合协议，继续缓冲只会把内存吃光。
        if (pending.length > MAX_BROKER_LINE_BYTES) {
            failure = new Error('broker response exceeded the maximum line length');
            pending = '';
        }
        deliver();
    });
    socket.once('error', (error) => {
        failure = error ?? new Error('broker pipe failed');
        deliver();
    });
    socket.once('close', () => {
        failure = failure ?? new Error('broker closed the pipe');
        deliver();
    });
    return {
        send: async (line) => {
            socket.write(`${line}\n`);
        },
        receive: async () => new Promise((resolve, reject) => {
            waiting = (line) => {
                if (line !== null) {
                    resolve(line);
                    return;
                }
                reject(failure ?? new Error('broker closed the pipe'));
            };
            deliver();
        }),
        close: () => {
            socket.end();
            socket.destroy();
        },
    };
}
/**
 * 构造 Windows 的 broker 连接器。
 *
 * broker 进程退出与管道出现是两条独立信号，二者必须一起看：只看管道会把
 * 「用户点了取消」当成「服务起不来」，而只看进程退出则会在管道其实已经可用时
 * 过早失败。
 */
export function createWindowsAbeBrokerConnector(dependencies = {}) {
    const launch = dependencies.launch ?? defaultLaunch;
    const connect = dependencies.connect ?? defaultConnect;
    const now = dependencies.now ?? Date.now;
    const sleep = dependencies.sleep ?? defaultSleep;
    const newSessionId = dependencies.sessionId ?? randomUUID;
    return async ({ timeoutMs, signal }) => {
        const binaryPath = resolveAbeBrokerBinary(dependencies.binaryPath);
        if (!binaryPath) {
            throw new Error('the ABE broker executable is not available in this build');
        }
        const pipePath = ABE_PIPE_PREFIX + newSessionId();
        const child = launch(binaryPath, [
            '--elevate',
            '--pipe',
            pipePath.slice(ABE_PIPE_PREFIX.length),
            '--client-pid',
            String(process.pid),
        ]);
        // Held in an object rather than a bare variable: the assignment happens in
        // a callback, and a `let` narrowed to null would be read back as never.
        const outcome = { exit: null };
        void child.exited.then((result) => {
            outcome.exit = result;
        });
        const deadline = now() + timeoutMs;
        try {
            for (;;) {
                if (signal?.aborted)
                    throw new Error('aborted');
                // 只有非 0 退出才提前失败：那是用户取消 UAC，或提权/服务注册
                // 失败，两者都不会再产生管道。
                //
                // 退出码 0 是成功路径，不能当失败：`--elevate` 装好服务就返回，而管道由
                // SYSTEM 服务进程异步创建，常常晚于启动器退出一拍。旧实现无论退出码都
                // 抛错，于是用户批准 UAC、服务真的起来了，导入仍然失败。现在继续轮询到连接超时。
                if (outcome.exit && outcome.exit.code !== 0) {
                    const detail = outcome.exit.stderr.trim();
                    throw new Error(detail.length > 0
                        ? `broker exited with code ${outcome.exit.code}: ${detail}`
                        : `broker exited with code ${outcome.exit.code}`);
                }
                try {
                    return wrapConnection(await connect(pipePath));
                }
                catch {
                    if (now() >= deadline) {
                        // 启动器已经 exit 0 说明用户批准了、服务也报告装好了，管道却始终没出现：
                        // 多半是服务被拦截。这句话是会话层判断「已批准」的依据，不能随意改写。
                        throw new Error(outcome.exit?.code === 0
                            ? `the ABE broker pipe did not appear within ${timeoutMs}ms after the elevated install succeeded`
                            : `the ABE broker pipe did not appear within ${timeoutMs}ms`);
                    }
                    await sleep(CONNECT_RETRY_INTERVAL_MS);
                }
            }
        }
        catch (error) {
            child.kill();
            throw error;
        }
    };
}
