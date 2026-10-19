/**
 * 桌面端错误日志加密。
 *
 * 原始 `event_log` 不得以明文出现在 HTTP 请求体中。每个事件的 `event_log`
 * 使用 AES-256-GCM 加密为以下线上格式：
 *
 *     v1.<base64url(nonce)>.<base64url(ciphertext_and_tag)>
 *
 * 密钥管理（方案 §2「加密规则」）：
 * - 登录 token 是唯一密钥材料；token 长度不固定，因此用 HKDF-SHA256 派生固定的 32 字节密钥。
 * - `salt` 使用固定常量 {@link HKDF_SALT}，`info` 使用调用方的 `user_id`。
 *   派生过程绑定 `user_id`，因此在其他用户身份下重放 token 也无法解密原用户日志。
 * - 每个事件使用全新的 12 字节随机 nonce，绝不复用，满足 GCM 的安全要求。
 *
 * 关联数据（AAD）：明文元数据 `event_type` 与 `occurred_at_ms` 作为 GCM 关联数据，
 * 即使明文传输也能检测篡改。按当前要求，`code_location` 不属于 AAD，只认证事件类型
 * 和时间戳。Gateway 必须使用相同的 HKDF 参数派生密钥，并按
 * {@link buildAssociatedData} 的相同编码构造 AAD，否则 GCM 认证会失败。
 */
import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';
/** 线上格式版本前缀；KDF、加密算法或 AAD 规则变化时递增。 */
export const EVENT_LOG_WIRE_VERSION = 'v1';
/** 固定 HKDF salt（方案 §2），必须与 Gateway 完全一致。 */
export const HKDF_SALT = 'mcode-desktop-event-log-v1';
/** AES-256 派生密钥长度为 32 字节，GCM nonce 长度为 12 字节。 */
const AES_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
/**
 * 通过 HKDF-SHA256 从登录 token 派生用户维度的 AES-256 密钥。
 *
 * @param token 登录 access token，也是唯一密钥材料。
 * @param userId 真实用户 ID，作为 HKDF `info` 限定密钥范围。
 * @returns 32 字节密钥缓冲区。
 */
export function deriveEventLogKey(token, userId) {
    // `hkdfSync` 返回 ArrayBuffer，这里转为加密 API 所需的 Buffer。
    const derived = hkdfSync('sha256', Buffer.from(token, 'utf8'), Buffer.from(HKDF_SALT, 'utf8'), Buffer.from(userId, 'utf8'), AES_KEY_BYTES);
    return Buffer.from(derived);
}
/**
 * 对需要认证但保持明文的元数据进行固定字节编码。
 *
 * 只绑定 `event_type` 与 `occurred_at_ms`，明确排除 `code_location`。使用键顺序固定的
 * JSON 编码，保证客户端与 Gateway 生成完全一致的 AAD 字节。两项字段均为结构化低风险值
 * （类似枚举的字符串和整数），此处使用 JSON 不会产生歧义。
 */
export function buildAssociatedData(event) {
    return Buffer.from(JSON.stringify({ event_type: event.event_type, occurred_at_ms: event.occurred_at_ms }), 'utf8');
}
/**
 * 把一条原始 `event_log` 加密为 `v1.<nonce>.<ciphertext+tag>` 线上格式。
 *
 * @param plaintextLog 待保护的原始错误文本。
 * @param params.token 作为 HKDF 密钥材料的登录 token。
 * @param params.userId 作为 HKDF `info` 的真实用户 ID。
 * @param params.event 提供 AAD 字段（`event_type`、`occurred_at_ms`）。
 */
export function encryptEventLog(plaintextLog, params) {
    const key = deriveEventLogKey(params.token, params.userId);
    // 每个事件使用新的随机 nonce；同一密钥下复用 nonce 会破坏 GCM 安全性。
    const nonce = randomBytes(GCM_NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(buildAssociatedData(params.event));
    const ciphertext = Buffer.concat([cipher.update(plaintextLog, 'utf8'), cipher.final()]);
    // 追加 16 字节 GCM 认证标签，供 Gateway 校验完整性。
    const ciphertextAndTag = Buffer.concat([ciphertext, cipher.getAuthTag()]);
    return `${EVENT_LOG_WIRE_VERSION}.${nonce.toString('base64url')}.${ciphertextAndTag.toString('base64url')}`;
}
//# sourceMappingURL=crypto.js.map