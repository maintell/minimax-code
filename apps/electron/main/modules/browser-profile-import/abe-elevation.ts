import { randomUUID } from "node:crypto";
import { CHROME_CNG_KEY_NAME, decodeSnapshotDescriptor, AbeBrokerProtocolError, encodeBrokerRequest, decodeBrokerResponse } from "./abe-broker-protocol";
export class AbeElevationError extends Error {
    constructor(reason, detail) {
        super(detail ? `${reason}: ${detail}` : reason);
        this.name = 'AbeElevationError';
        this.reason = reason;
        this.detail = detail;
    }
}

/** 用户点了 UAC 取消时 ShellExecuteEx 返回的 Win32 错误码。 */
const ERROR_CANCELLED = 1223;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
/**
 * 卷影创建的默认超时。
 *
 * 实测约 20 秒，这里留到 3 分钟：卷影耗时随卷负轻而动，不是固定值，而边界只会
 * 把真正挂死的快照请求提前放弃。客户端必须等得比 broker 侧自毁更久，否则会先于
 * broker 判定失败。
 */
const DEFAULT_SNAPSHOT_TIMEOUT_MS = 180000;
/** UAC 弹窗默认约 2 分钟自动消失，这里留出余量。 */
const DEFAULT_CONNECT_TIMEOUT_MS = 150000;
/**
 * 把 broker 的失败原因映射成调用方关心的类别。
 *
 * `malformed_request` / `unsupported_operation` / `payload_invalid` 都归到
 * `protocol_error`：这三种只可能是我方编解码有 bug 或版本不匹配，
 * 重试没有意义，必须暴露成可定位的错误而不是笼统的失败。
 */
function mapBrokerReason(reason, detail) {
    switch (reason) {
        case 'identity_rejected':
            return new AbeElevationError('identity_rejected', detail);
        case 'dpapi_failed':
            return new AbeElevationError('dpapi_failed', detail);
        case 'cng_failed':
            return new AbeElevationError('cng_failed', detail);
        case 'snapshot_failed':
            return new AbeElevationError('snapshot_failed', detail);
        case 'malformed_request':
        case 'unsupported_operation':
        case 'payload_invalid':
            return new AbeElevationError('protocol_error', detail ?? reason);
        default:
            return new AbeElevationError('broker_error', detail ?? reason);
    }
}
/** `--install-and-start` 在「不是管理员令牌」阶段退出的退出码，见 broker README。 */
const EXIT_REQUIRE_ELEVATED = 10;
/**
 * 判断提权失败时用户是否已经批准过。
 *
 * 两种文本说明提升进程确实跑过：`--elevate` 父进程写的
 * `elevated install failed: exit code N`，以及连接器在启动器 exit 0 之后
 * 等不到管道时写的 `after the elevated install succeeded`。退出码 10 例外：
 * 那是拿到了非管理员令牌，对用户来说等同于没批准。
 */
export function isElevationApproved(detail) {
    if (!detail)
        return false;
    if (detail.includes('after the elevated install succeeded'))
        return true;
    const match = /elevated install failed: exit code (\d+)/.exec(detail);
    return match !== null && Number(match[1]) !== EXIT_REQUIRE_ELEVATED;
}
/** 判断 ShellExecute 的错误是否属于「用户主动取消」。 */
export function isElevationDeclined(detail) {
    if (!detail)
        return false;
    return new RegExp(`\\b${ERROR_CANCELLED}\\b`).test(detail);
}
class PipeBrokerSession {
    constructor(connection, requestTimeoutMs, snapshotTimeoutMs, signal) {
        this.closed = false;
        this.connection = connection;
        this.requestTimeoutMs = requestTimeoutMs;
        this.snapshotTimeoutMs = snapshotTimeoutMs;
        this.signal = signal;
    }
    async unwrapSystemLayer(abeBlob) {
        return this.exchange('unwrapSystemLayer', abeBlob);
    }
    async cngDecrypt(block, keyName = CHROME_CNG_KEY_NAME) {
        return this.exchange('cngDecrypt', block, keyName);
    }
    async createSnapshot(sourcePath) {
        // 卷影用自己的超时：VSS 的耗时量级比密钥操作大一个数量级。
        const payload = await this.exchange('createSnapshot', Buffer.from(sourcePath, 'utf8'), undefined, this.snapshotTimeoutMs);
        try {
            return decodeSnapshotDescriptor(payload);
        }
        catch (error) {
            // 描述符决定我们接下来打开哪个文件，形状不符一律当协议错误，绝不退让。
            if (error instanceof AbeBrokerProtocolError) {
                throw new AbeElevationError('protocol_error', error.reason);
            }
            throw error;
        }
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        try {
            this.connection.close();
        }
        catch {
            /* 关闭失败不影响调用方：broker 侧有超时自毁 */
        }
    }
    async exchange(op, payload, keyName, timeoutMs = this.requestTimeoutMs) {
        if (this.closed)
            throw new AbeElevationError('broker_unavailable', 'session already closed');
        if (this.signal?.aborted)
            throw new AbeElevationError('aborted');
        const request = keyName
            ? encodeBrokerRequest({ op, payload: payload.toString('base64'), keyName })
            : encodeBrokerRequest({ op, payload: payload.toString('base64') });
        await this.withTimeout(this.connection.send(request), timeoutMs);
        const raw = await this.withTimeout(this.connection.receive(), timeoutMs);
        let response;
        try {
            response = decodeBrokerResponse(raw);
        }
        catch (error) {
            if (error instanceof AbeBrokerProtocolError) {
                throw new AbeElevationError('protocol_error', error.reason);
            }
            throw error;
        }
        if (!response.ok)
            throw mapBrokerReason(response.reason, response.detail);
        const result = Buffer.from(response.payload, 'base64');
        if (result.length === 0) {
            // decodeBrokerResponse 已经拦掉空 payload，这里是防御性兜底：
            // 长度错误的「明文」一旦流到 AES-GCM 会静默解出垃圾。
            throw new AbeElevationError('protocol_error', 'empty payload');
        }
        return result;
    }
    /**
     * 给一次收发套上超时与取消两个上界。
     *
     * 取消必须在这里生效，而不是只在 exchange 开头查一次：卷影创建的预算长达三分钟，
     * 用户点取消后如果还要等 broker 把快照做完，上层的 activeImport 会一直被占住，
     * 期间再点导入只能拿到 import_in_progress。所以取消一到就关连接并立即拒绝，
     * 让调用方马上释放。
     */
    withTimeout(promise, timeoutMs) {
        return new Promise((resolve, reject) => {
            const signal = this.signal;
            let settle = () => { };
            const timer = setTimeout(() => {
                this.close();
                reject(new AbeElevationError('broker_timeout', `${timeoutMs}ms`));
            }, timeoutMs);
            const onAbort = () => {
                this.close();
                reject(new AbeElevationError('aborted'));
            };
            // 计时器与监听器必须一起拆掉：漏掉监听器会在长会话里累积，
            // 而 AbortSignal 对已注册的监听器数量有告警阈值。
            settle = () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
            };
            if (signal) {
                if (signal.aborted) {
                    settle();
                    this.close();
                    reject(new AbeElevationError('aborted'));
                    return;
                }
                signal.addEventListener('abort', onAbort, { once: true });
            }
            promise.then((value) => {
                settle();
                resolve(value);
            }, (error) => {
                settle();
                reject(error);
            });
        });
    }
}
/**
 * 打开一次 broker 会话：提权 → 等 broker 建管道 → 连上。
 *
 * 连接失败时必须关掉已建立的连接，避免 broker 侧一直等服务。
 */
export async function openAbeBrokerSession(connector, options = {}) {
    const signal = options.signal;
    if (signal?.aborted)
        throw new AbeElevationError('aborted');
    const pipeName = `mavis-abe-${randomUUID()}`;
    const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    let connection;
    try {
        connection = await connector({ pipeName, timeoutMs, signal });
    }
    catch (error) {
        if (signal?.aborted)
            throw new AbeElevationError('aborted');
        if (error instanceof AbeElevationError)
            throw error;
        const detail = error instanceof Error ? error.message : String(error);
        if (isElevationDeclined(detail))
            throw new AbeElevationError('elevation_declined', detail);
        throw new AbeElevationError(isElevationApproved(detail) ? 'elevation_blocked' : 'elevation_failed', detail);
    }
    return new PipeBrokerSession(connection, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, options.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS, signal);
}
/**
 * 构造 `AbePrivilegedOperations`，供 `readWindowsChromeAppBoundKey` 使用。
 *
 * 会话在第一次调用时懒打开，两步操作共用同一次提权；`close` 由调用方在
 * 导入结束后调用。无论成功失败，Key 与中间明文都不出本进程内存。
 */
export function createWindowsAbePrivilegedOperations(options) {
    let sessionPromise = null;
    const ensureSession = (signal) => {
        if (!sessionPromise) {
            sessionPromise = openAbeBrokerSession(options.connector, {
                requestTimeoutMs: options.requestTimeoutMs,
                connectTimeoutMs: options.connectTimeoutMs,
                signal,
            }).catch((error) => {
                // 失败后允许下次重试：否则一次 UAC 取消会把整个功能永久钉死。
                sessionPromise = null;
                throw error;
            });
        }
        return sessionPromise;
    };
    return {
        unwrapSystemLayer: async (abeBlob, signal) => {
            const session = await ensureSession(signal);
            return session.unwrapSystemLayer(abeBlob);
        },
        cngDecrypt: async (block, signal) => {
            const session = await ensureSession(signal);
            return session.cngDecrypt(block, options.cngKeyName ?? CHROME_CNG_KEY_NAME);
        },
        createSnapshot: async (sourcePath, signal) => {
            const session = await ensureSession(signal);
            return session.createSnapshot(sourcePath);
        },
        close: () => {
            const pending = sessionPromise;
            sessionPromise = null;
            if (!pending)
                return;
            void pending.then((session) => session.close(), () => {
                /* 打开失败，无需关闭 */
            });
        },
    };
}
