import { lstat, readFile } from "node:fs/promises";
import { windowsDpapiUnprotect } from "./platform-crypto";
import { extractAbeEnvelope, abeEnvelopeCngBlock, unwrapAbeEnvelope, AbeEnvelopeError, ABE_KEY_LENGTH } from "./abe-envelope";
/**
 * Chrome App-Bound Encryption (ABE) v20 Key 的获取编排。
 *
 * `Local State` 的 `os_crypt.app_bound_encrypted_key` 结构：
 *
 *   Base64( "APPB"[4] + ABE Blob )
 *
 * ABE Blob 需要两层 DPAPI（先 SYSTEM 上下文、再用户上下文）才能剥离，其中 SYSTEM
 * 那层必须由外部 broker 执行；broker 同时负责 v3 所需的 CNG 解密。本模块只负责：
 *
 *   1. 校验并剥离 `APPB` 前缀
 *   2. 把 Blob 交给 broker 拿回内层（本进程再剥用户层）
 *   3. 用 `extractAbeEnvelope` 切出私有 Envelope
 *   4. 用 `unwrapAbeEnvelope` 解出 32 字节 v20 Key
 *
 * 约束：本模块对 Chrome 数据严格只读，任何异常都 fail closed，绝不写回 `Local State`
 * 或 Cookies 库 —— 写入可能触发 Chrome 的故障恢复并清空用户 Cookie。
 */
const APPB_PREFIX = 'APPB';
const APPB_PREFIX_LENGTH = 4;
/**
 * `APPB` 头**只有 4 字节**，后面没有独立的版本字节。
 *
 * 本机 Chrome 156 实测，base64 解码后是：
 * `41 50 50 42 | 01 00 00 00 | d0 8c 9d df 01 15 d1 11 8c 7a 00 c0 4f c2 97 eb | ...`
 * 紧跟 `APPB` 的 `01 00 00 00` 是 DPAPI blob 自己的 version DWORD，之后是
 * DPAPI provider GUID `{d08c9ddf-0115-d111-8c7a-00c04fc297eb}`。
 * 按 5 字节剥离会把 DPAPI blob 的首字节削掉，`CryptUnprotectData` 恒定
 * 返回 `ERROR_INVALID_DATA`(13) —— 而且因为外层本来就需要 SYSTEM，
 * 这个错误在普通权限下排查时很容易被误判成「权限不够」。
 */
const APPB_HEADER_LENGTH = APPB_PREFIX_LENGTH;
/** ABE Blob 的合理上限，用于拒绝异常大的输入。 */
const MAX_ABE_BLOB_BYTES = 16 * 1024;
const MAX_LOCAL_STATE_BYTES = 4 * 1024 * 1024;
/**
 * 与 `MacSafeStorageAccessError` 保持一致：只携带稳定的 reason 枚举，
 * 原始异常由调用方就近记录，不挂到 error 上，避免把系统错误细节带进 UI 与日志。
 *
 * 唯一的例外是 `cause`：特权步骤失败时，`broker_failed` 这个粒度不足以让调用方
 * 分清「用户点了取消」和「broker 起不来」——前者只需要一句提示，后者需要用户去改
 * 系统设置。挂上底层异常是让上层能做这个区分的最省事也最不容易出错的办法，
 * 且它不进入 UI 或日志，只在进程内被读一次。
 */
export class AbeKeyError extends Error {
    constructor(reason, options) {
        super(`Chrome App-Bound key unavailable: ${reason}`);
        this.name = 'AbeKeyError';
        this.reason = reason;
        if (options && 'cause' in options)
            this.cause = options.cause;
    }
}

/**
 * 读取并校验 `os_crypt.app_bound_encrypted_key`，返回去掉 `APPB` 头部的 ABE Blob。
 *
 * 不做任何解密，便于单测与故障定位。
 */
export async function readAppBoundEncryptedKey(localStatePath) {
    let raw;
    try {
        const stats = await lstat(localStatePath);
        if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_LOCAL_STATE_BYTES) {
            throw new Error('not a regular file');
        }
        raw = await readFile(localStatePath, 'utf8');
    }
    catch (error) {
        throw new AbeKeyError('local_state_unreadable');
    }
    let encoded;
    try {
        const localState = JSON.parse(raw);
        encoded = localState.os_crypt?.app_bound_encrypted_key;
    }
    catch (error) {
        throw new AbeKeyError('local_state_unreadable');
    }
    if (encoded === undefined || encoded === null)
        throw new AbeKeyError('app_bound_key_absent');
    if (typeof encoded !== 'string' || encoded.length === 0) {
        throw new AbeKeyError('app_bound_key_malformed');
    }
    let decoded;
    try {
        decoded = Buffer.from(encoded, 'base64');
    }
    catch (error) {
        throw new AbeKeyError('app_bound_key_malformed');
    }
    if (decoded.length <= APPB_HEADER_LENGTH)
        throw new AbeKeyError('app_bound_key_malformed');
    if (decoded.subarray(0, APPB_PREFIX_LENGTH).toString('ascii') !== APPB_PREFIX) {
        throw new AbeKeyError('app_bound_key_malformed');
    }
    const blob = decoded.subarray(APPB_HEADER_LENGTH);
    if (blob.length === 0 || blob.length > MAX_ABE_BLOB_BYTES) {
        throw new AbeKeyError('app_bound_key_malformed');
    }
    return Buffer.from(blob);
}
/**
 * 完整获取 v20 Key：读 `Local State` → broker 剥离双层 DPAPI → 解 Envelope。
 *
 * 返回的 Key 只应保存在内存中，用完即弃；不得写盘、进日志或传给 renderer。
 */
export async function readWindowsChromeAppBoundKey(localStatePath, dependencies, signal) {
    signal?.throwIfAborted();
    const blob = await readAppBoundEncryptedKey(localStatePath);
    const dpapiUnprotect = dependencies.dpapiUnprotect ?? windowsDpapiUnprotect;
    // 第一层：SYSTEM 上下文 DPAPI，只能由 broker 完成。
    let inner;
    try {
        inner = await dependencies.privileged.unwrapSystemLayer(blob, signal);
    }
    catch (error) {
        if (signal?.aborted)
            throw error;
        throw new AbeKeyError('broker_failed', { cause: error });
    }
    // 第二层：用户上下文 DPAPI，当前进程即可完成。
    let plaintext;
    try {
        plaintext = await dpapiUnprotect(inner, signal);
    }
    catch (error) {
        if (signal?.aborted)
            throw error;
        throw new AbeKeyError('user_layer_failed');
    }
    finally {
        inner.fill(0);
    }
    try {
        signal?.throwIfAborted();
        // 明文是长度前缀结构（路径字段 + Envelope），必须先切出 Envelope 再分派版本。
        let envelope;
        try {
            envelope = extractAbeEnvelope(plaintext).envelope;
        }
        catch (error) {
            throw new AbeKeyError('envelope_invalid');
        }
        // v3 的 cng_block 必须在 SYSTEM 上下文解开，先异步取回再注入同步解封。
        const cngBlock = abeEnvelopeCngBlock(envelope);
        let cngPlain;
        if (cngBlock) {
            try {
                cngPlain = await dependencies.privileged.cngDecrypt(cngBlock, signal);
            }
            catch (error) {
                if (signal?.aborted)
                    throw error;
                throw new AbeKeyError('broker_failed', { cause: error });
            }
        }
        try {
            const { key } = unwrapAbeEnvelope(envelope, {
                cngDecrypt: () => {
                    if (!cngPlain)
                        throw new AbeEnvelopeError('cng_unavailable');
                    return cngPlain;
                },
            });
            return assertAbeKey(key);
        }
        catch (error) {
            throw new AbeKeyError('envelope_invalid');
        }
        finally {
            cngPlain?.fill(0);
            envelope.fill(0);
        }
    }
    finally {
        plaintext.fill(0);
    }
}
function assertAbeKey(key) {
    if (key.length !== ABE_KEY_LENGTH)
        throw new AbeKeyError('envelope_invalid');
    return key;
}
