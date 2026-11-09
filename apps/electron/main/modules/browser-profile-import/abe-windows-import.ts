/**
 * Windows 上 Chrome Cookie 导入所需的特权能力装配。
 *
 * 一次导入对应一个 runtime 实例：broker 会话在第一次特权调用时懒打开，
 * `close()` 之后 broker 侧会停止并清理本次创建的卷影副本。
 * 因此这个对象的生命周期必须与一次导入严格对齐 —— 提前关闭会让第二次特权调用
 * 再弹一次 UAC，忘记关闭则会让卷影副本留到 broker 自身超时。
 */

import { resolveAbeBrokerBinary, createWindowsAbeBrokerConnector } from "./abe-broker-connector";
import { createWindowsAbePrivilegedOperations, AbeElevationError } from "./abe-elevation";
import { readWindowsChromeAppBoundKey, AbeKeyError } from "./abe-key-provider";
import { BrowserProfileImportFailure } from "./errors";
/**
 * 构造一次导入用的特权能力。
 *
 * 在非 Windows、或随包分发的 broker 不存在时返回 `undefined`。这**不是**错误：
 * 返回 `undefined` 时调用方不传 v20 钩子，v20 记录按既有行为记为 unsupported，
 * 与本功能存在之前完全一致。开发构建常常没有跑过 `build:abe-broker`，
 * 让这种情况变成「导入直接失败」会把它变成一个只在打包机器上才复现的问题。
 */
export function createWindowsAbeImportRuntime(options = {}) {
    const platform = options.platform ?? process.platform;
    if (platform !== 'win32')
        return undefined;
    if (!resolveAbeBrokerBinary(options.binaryPath))
        return undefined;
    const privileged = createWindowsAbePrivilegedOperations({
        connector: createWindowsAbeBrokerConnector({ binaryPath: options.binaryPath }),
    });
    const reportFailure = (step, error, signal) => {
        const elevation = elevationErrorOf(error);
        if (!elevation || signal.aborted || !options.requestId || !options.onDiagnostic)
            return;
        options.onDiagnostic({
            event: 'abe_broker_failed',
            requestId: options.requestId,
            step,
            reason: elevation.reason,
            ...brokerFailureCodes(elevation.detail),
        });
    };
    return {
        getAppBoundKey: async (localStatePath, signal) => {
            try {
                return await readWindowsChromeAppBoundKey(localStatePath, { privileged }, signal);
            }
            catch (error) {
                reportFailure('app_bound_key', error, signal);
                throw asImportFailure(error);
            }
        },
        createShadowSnapshot: async (cookieDatabasePath, signal) => {
            try {
                const descriptor = await privileged.createSnapshot(cookieDatabasePath, signal);
                return descriptor.databasePath;
            }
            catch (error) {
                // 与 getAppBoundKey 同样分类：Chrome 运行时这条路径才是弹出 UAC 的那条，
                // 用户在这里点取消若被压成 shadow_unavailable，会得到「请关闭 Chrome」——
                // 一个他做不到、也不是真正原因的动作。
                reportFailure('shadow_snapshot', error, signal);
                throw asImportFailure(error);
            }
        },
        close: () => privileged.close(),
    };
}
/**
 * 把特权步骤的失败翻译成用户能据此行动的分类。
 *
 * 按用户下一步能做什么分四类：
 *
 * - `elevation_declined`：用户在 UAC 上取消，是一次选择，重试并点「是」即可。
 * - `elevation_unavailable`：没拿到管理员批准（非管理员账户、无法弹出批准）。
 *   需要换管理员账户或找管理员。
 * - `elevation_blocked`：已经批准，但服务被安全软件或系统拦截、或会话中途失败。
 *   再点一次「是」没有用，要放行 MiniMax Code 或找管理员。
 * - `shadow_unavailable`：只有卷影副本失败，关掉 Chrome 直读就能绕过。
 *
 * `readWindowsChromeAppBoundKey` 会把特权失败收敛成 `broker_failed`，
 * 因此分类要看挂上来的 `cause`。
 */
function asImportFailure(error) {
    if (error instanceof BrowserProfileImportFailure)
        return error;
    const elevation = elevationErrorOf(error);
    if (!elevation)
        return error;
    switch (elevation.reason) {
        case 'elevation_declined':
            return new BrowserProfileImportFailure('elevation_declined');
        case 'snapshot_failed':
            return new BrowserProfileImportFailure('shadow_unavailable');
        case 'elevation_failed':
            return new BrowserProfileImportFailure('elevation_unavailable');
        default:
            // 其余原因（elevation_blocked 及会话建立之后的各类失败）都发生在批准之后。
            return new BrowserProfileImportFailure('elevation_blocked');
    }
}
/**
 * 从 broker 失败文本里只取数字码。
 *
 * 文本来自连接器（`broker exited with code N: <stderr>`）或 broker 回包（`... win32=N`），
 * 其中 stderr 与回包都可能含路径，因此只保留两个数字，原文不进日志。
 */
export function brokerFailureCodes(detail) {
    if (!detail)
        return {};
    const exit = /broker exited with code (\d+)/.exec(detail);
    const win32 = /win32=(\d+)/.exec(detail);
    return {
        ...(exit ? { brokerExitCode: Number(exit[1]) } : {}),
        ...(win32 ? { win32Code: Number(win32[1]) } : {}),
    };
}
function elevationErrorOf(error) {
    if (error instanceof AbeElevationError)
        return error;
    // 取消信号与 abort 都会原样抛出，不能被当成提权失败重新归类。
    if (!(error instanceof AbeKeyError))
        return undefined;
    return error.cause instanceof AbeElevationError ? error.cause : undefined;
}
