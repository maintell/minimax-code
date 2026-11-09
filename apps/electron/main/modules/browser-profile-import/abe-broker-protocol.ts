/**
 * Electron 侧与 SYSTEM broker 之间的线路协议。
 *
 * 只做编解码与校验，不含任何 I/O，因此可以完全离线单测。
 *
 * 传输约定：UTF-8、单行 JSON、以 `\n` 结尾，一次请求对应一次响应。
 * 之所以选行分隔而不是长度前缀，是因为 broker 侧用 .NET 的
 * `StreamReader.ReadLine` / `StreamWriter.WriteLine` 实现最省事，
 * 而两端的数据量都在几十 KB 量级，不存在粘包性能问题。
 *
 * 安全约定（broker 侧必须实现，详见设计文档第 7 节）：
 *  - 管道由 **SYSTEM 侧创建**，ACL 只放行 SYSTEM 与发起导入的那个用户 SID；
 *  - broker 必须校验连接方的 SID 与启动时传入的用户 SID 一致后才处理请求；
 *  - 绝不能反过来让用户态进程做管道服务端 —— 那等于对外提供一个
 *    「SYSTEM DPAPI 解包预言机」，本机任意进程都能借它提权。
 *
 * 失败一律 fail closed：解析不出来的响应按协议错误处理，绝不猜测。
 */

/** Chrome 存 Envelope Key 的机器级 CNG/KSP 密钥名。 */
export let CHROME_CNG_KEY_NAME = 'Google Chromekey1';
/** 单个请求/响应里允许的最大 payload（base64 解码后）。 */
export let MAX_BROKER_PAYLOAD_BYTES = 64 * 1024;
/** 单行 JSON 的最大长度，防止 broker 异常时把内存吃光。 */
export let MAX_BROKER_LINE_BYTES = 256 * 1024;
const BROKER_FAILURE_REASONS = [
    'malformed_request',
    'unsupported_operation',
    'payload_invalid',
    'dpapi_failed',
    'cng_failed',
    'snapshot_failed',
    'identity_rejected',
    'internal_error',
];
export class AbeBrokerProtocolError extends Error {
    constructor(reason) {
        super(reason);
        this.name = 'AbeBrokerProtocolError';
        this.reason = reason;
    }
}

/**
 * 编码一次请求。返回的字符串**不含**换行符，由传输层负责追加。
 *
 * payload 只存在于内存中；调用方负责在请求发出后清零自己的那份副本。
 */
export function encodeBrokerRequest(request) {
    if (request.op !== 'unwrapSystemLayer' &&
        request.op !== 'cngDecrypt' &&
        request.op !== 'createSnapshot') {
        throw new AbeBrokerProtocolError('shape_invalid');
    }
    const payload = Buffer.from(request.payload, 'base64');
    if (payload.length === 0 || payload.length > MAX_BROKER_PAYLOAD_BYTES) {
        throw new AbeBrokerProtocolError('payload_too_large');
    }
    const line = { op: request.op, payload: request.payload };
    if (request.keyName !== undefined)
        line.keyName = request.keyName;
    const encoded = JSON.stringify(line);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_BROKER_LINE_BYTES) {
        throw new AbeBrokerProtocolError('line_too_long');
    }
    return encoded;
}
/**
 * 解码 broker 的一次响应。
 *
 * 任何形状异常都抛 `AbeBrokerProtocolError`，绝不返回半成品 —— 上层一旦拿到
 * 长度错误的「明文」继续往下走，AES-GCM 会静默解出垃圾而不是报错。
 */
export function decodeBrokerResponse(line) {
    const trimmed = line.trim();
    if (trimmed.length === 0)
        throw new AbeBrokerProtocolError('empty_line');
    if (Buffer.byteLength(trimmed, 'utf8') > MAX_BROKER_LINE_BYTES) {
        throw new AbeBrokerProtocolError('line_too_long');
    }
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch {
        throw new AbeBrokerProtocolError('not_json');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new AbeBrokerProtocolError('shape_invalid');
    }
    const record = parsed;
    if (record.ok === true) {
        if (typeof record.payload !== 'string')
            throw new AbeBrokerProtocolError('shape_invalid');
        const payload = Buffer.from(record.payload, 'base64');
        if (payload.length === 0)
            throw new AbeBrokerProtocolError('payload_not_base64');
        if (payload.length > MAX_BROKER_PAYLOAD_BYTES) {
            throw new AbeBrokerProtocolError('payload_too_large');
        }
        // Buffer.from 对非法 base64 是宽容的（会静默丢弃坏字符），因此回写一遍再比对，
        // 长度不一致说明原文不是合法 base64。
        if (payload.toString('base64').replace(/=+$/, '') !== record.payload.replace(/=+$/, '')) {
            throw new AbeBrokerProtocolError('payload_not_base64');
        }
        return { ok: true, payload: record.payload };
    }
    if (record.ok === false) {
        const reason = record.reason;
        if (typeof reason !== 'string' || !isBrokerFailureReason(reason)) {
            throw new AbeBrokerProtocolError('shape_invalid');
        }
        const detail = typeof record.detail === 'string' ? record.detail : undefined;
        return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
    }
    throw new AbeBrokerProtocolError('shape_invalid');
}
function isBrokerFailureReason(value) {
    return BROKER_FAILURE_REASONS.includes(value);
}
/** Windows 路径分隔符。 */
const SEPARATOR = '\\';
/**
 * 卷影副本设备路径前缀。
 *
 * 用 SEPARATOR 拼装而不是写正则：正则里的反斜杠层级太多，
 * 而这段代码是安全边界，一个转义笔误就会让校验形同虚设。
 */
const SNAPSHOT_DEVICE_PREFIX = [
    '',
    '',
    '?',
    'GLOBALROOT',
    'Device',
    'HarddiskVolumeShadowCopy',
].join(SEPARATOR);
/** 副本序号：设备路径前缀之后必须全是数字。 */
const SNAPSHOT_INDEX_PATTERN = /^[0-9]{1,10}$/;
const MAX_SNAPSHOT_FIELD_CHARS = 2048;
/**
 * 解析 broker 回传的快照描述符。
 *
 * 严格校验是必要的：devicePath 与 databasePath 决定用户态进程接下来会打开哪个文件。
 * 若不校验，一个异常或有缺陷的 broker 就能把我们指向任意路径（设备命名空间、符号链接
 * 目标、甚至系统目录），把「读 Chrome Cookie」悄悄变成「读任意文件」。
 */
export function decodeSnapshotDescriptor(payload) {
    let parsed;
    try {
        parsed = JSON.parse(payload.toString('utf8'));
    }
    catch {
        throw new AbeBrokerProtocolError('not_json');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new AbeBrokerProtocolError('shape_invalid');
    }
    const record = parsed;
    const { snapshotId, devicePath, databasePath } = record;
    if (typeof snapshotId !== 'string' ||
        typeof devicePath !== 'string' ||
        typeof databasePath !== 'string') {
        throw new AbeBrokerProtocolError('shape_invalid');
    }
    if (snapshotId.length === 0 ||
        snapshotId.length > MAX_SNAPSHOT_FIELD_CHARS ||
        devicePath.length > MAX_SNAPSHOT_FIELD_CHARS ||
        databasePath.length > MAX_SNAPSHOT_FIELD_CHARS) {
        throw new AbeBrokerProtocolError('shape_invalid');
    }
    if (!devicePath.startsWith(SNAPSHOT_DEVICE_PREFIX)) {
        throw new AbeBrokerProtocolError('shape_invalid');
    }
    if (!SNAPSHOT_INDEX_PATTERN.test(devicePath.slice(SNAPSHOT_DEVICE_PREFIX.length))) {
        throw new AbeBrokerProtocolError('shape_invalid');
    }
    // databasePath 必须严格位于 devicePath 之下。
    const prefix = devicePath + SEPARATOR;
    if (!databasePath.startsWith(prefix) || databasePath.length === prefix.length) {
        throw new AbeBrokerProtocolError('shape_invalid');
    }
    // 不允许出现上跳片段，否则仍可能逃出卷影副本子树。
    if (databasePath.split(SEPARATOR).includes('..')) {
        throw new AbeBrokerProtocolError('shape_invalid');
    }
    return { snapshotId, devicePath, databasePath };
}
