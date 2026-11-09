import { createDecipheriv, timingSafeEqual } from "node:crypto";
/**
 * Chrome App-Bound Encryption (ABE) 私有 Envelope 解封装。
 *
 * `Local State` 的 `os_crypt.app_bound_encrypted_key` 去掉 `APPB` 前缀后，是
 * SYSTEM 上下文 DPAPI 与用户上下文 DPAPI 的双层封装。两层剥离后得到的明文仍不是
 * v20 Key，而是 Chrome / Edge 各自的私有 Envelope：
 *
 *   - 32 字节            原始 v20 Key，无 Envelope
 *   - 61 字节 v1         version[1] + nonce[12] + ciphertext[32] + tag[16]，AES-256-GCM
 *   - 61 字节 v2         同上布局，ChaCha20-Poly1305
 *   - 93 字节 v3         version[1] + cng_block[32] + nonce[12] + ciphertext[32] + tag[16]
 *
 * v1 / v2 使用编译期硬编码密钥；v3 先用 SYSTEM 上下文从 CNG/KSP 取出被包裹的
 * Envelope AES Key，与固定 Mask 异或后再解 AEAD。
 *
 * 本模块只做纯计算：所有需要特权的输入（双层 DPAPI 结果、CNG 解密结果）都由调用方
 * 以依赖注入方式提供，因此可以完全离线单测。任何格式异常都必须 fail closed —— 返回
 * 长度不为 32 的 Key 会让上层把错误密钥交给 AES-GCM，进而产生静默的错误解密。
 */
/** v20 Key 固定为 32 字节 AES-256 密钥。 */
export let ABE_KEY_LENGTH = 32;
/**
 * v1 与 v2 的信封等长，具体是哪一个由首字节的版本号决定；
 * 长度只能把它们与 v3 分开，因此不按版本各设一个常量。
 */
const ENVELOPE_LEGACY_LENGTH = 61;
const ENVELOPE_V3_LENGTH = 93;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const CNG_BLOCK_LENGTH = 32;
const VERSION_V1 = 1;
const VERSION_V2 = 2;
const VERSION_V3 = 3;
/** v1 AES-256-GCM 硬编码密钥（编译期内置于 Chrome / Edge 二进制）。 */
const ENVELOPE_V1_KEY = Buffer.from('b31c6e241ac846728da9c1fac4936651cffb944d143ab816276bcc6da0284787', 'hex');
/** v2 ChaCha20-Poly1305 硬编码密钥。 */
const ENVELOPE_V2_KEY = Buffer.from('e98f37d7f4e1fa433d19304dc2258042090e2d1d7eea7670d41f738d08729660', 'hex');
/** v3 用于还原 Envelope AES Key 的固定异或 Mask。 */
const ENVELOPE_V3_MASK = Buffer.from('ccf8a1cec56605b8517552ba1a2d061c03a29e90274fb2fcf59ba4b75c392390', 'hex');
export class AbeEnvelopeError extends Error {
    constructor(reason) {
        super(reason);
        this.name = 'AbeEnvelopeError';
        this.reason = reason;
    }
}

function openAead(cipher, key, nonce, ciphertext, tag) {
    // 分支调用而非传联合类型：两种算法在 @types/node 中属于不同重载。
    const decipher = cipher === 'aes-256-gcm'
        ? createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LENGTH })
        : createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
function assertKeyLength(key) {
    if (key.length !== ABE_KEY_LENGTH)
        throw new AbeEnvelopeError('key_length_invalid');
    return key;
}
/** 双层 DPAPI 剥离后、Envelope 之前的路径字段上限。 */
const MAX_PATH_FIELD_BYTES = 4 * 1024;
/**
 * 从双层 DPAPI 明文中取出私有 Envelope。
 *
 * 真实明文不是裸 Envelope，而是一个长度前缀结构（本机 Chrome 156 实测 133 字节）：
 *
 *   uint32 LE  pathFieldLength  = 32
 *   byte[32]   pathField         = uint16 LE(3) + "C:\Program Files\Google\Chrome"
 *   uint32 LE  envelopeLength   = 93
 *   byte[93]   envelope          = version[1] + cng_block[32] + nonce[12]
 *                                  + ciphertext[32] + tag[16]
 *
 * 因此不能直接拿明文长度去分派 Envelope 版本 —— 必须先按长度前缀切出来。
 * 任何长度不自洽都 fail closed：切错一个字节就会把垃圾喂给 AES-GCM，
 * 而 AEAD 校验失败只会报「解密失败」，把真正的解析 bug 掩盖掉。
 */
export function extractAbeEnvelope(plaintext) {
    if (plaintext.length < 8)
        throw new AbeEnvelopeError('empty_input');
    const pathFieldLength = plaintext.readUInt32LE(0);
    if (pathFieldLength > MAX_PATH_FIELD_BYTES)
        throw new AbeEnvelopeError('unknown_length');
    const envelopeLengthOffset = 4 + pathFieldLength;
    if (envelopeLengthOffset + 4 > plaintext.length)
        throw new AbeEnvelopeError('unknown_length');
    const envelopeLength = plaintext.readUInt32LE(envelopeLengthOffset);
    const envelopeStart = envelopeLengthOffset + 4;
    // 声明长度必须与实际剩余字节严格一致，多一个字节都说明结构理解错了。
    if (envelopeStart + envelopeLength !== plaintext.length) {
        throw new AbeEnvelopeError('unknown_length');
    }
    return {
        pathField: Buffer.from(plaintext.subarray(4, envelopeLengthOffset)),
        envelope: Buffer.from(plaintext.subarray(envelopeStart)),
    };
}
/**
 * 解开 ABE 私有 Envelope，返回 32 字节 v20 Key。
 *
 * 按明文长度判定 Envelope 版本；长度与版本字节必须自洽，否则 fail closed。
 */
export function unwrapAbeEnvelope(input, dependencies) {
    if (input.length === 0)
        throw new AbeEnvelopeError('empty_input');
    // 无 Envelope：双层 DPAPI 剥离后直接就是 v20 Key。
    if (input.length === ABE_KEY_LENGTH) {
        return { kind: 'raw', key: assertKeyLength(Buffer.from(input)) };
    }
    const isV3 = input.length === ENVELOPE_V3_LENGTH;
    if (!isV3 && input.length !== ENVELOPE_LEGACY_LENGTH) {
        throw new AbeEnvelopeError('unknown_length');
    }
    const version = input[0];
    if (isV3) {
        if (version !== VERSION_V3)
            throw new AbeEnvelopeError('version_mismatch');
        return { kind: 'v3', key: assertKeyLength(unwrapV3(input, dependencies)) };
    }
    // v1 与 v2 长度相同，只能靠版本字节区分。
    if (version === VERSION_V1) {
        return { kind: 'v1', key: assertKeyLength(unwrapV1(input)) };
    }
    if (version === VERSION_V2) {
        return { kind: 'v2', key: assertKeyLength(unwrapV2(input)) };
    }
    throw new AbeEnvelopeError('version_mismatch');
}
function splitV1V2(input) {
    // version[1] + nonce[12] + ciphertext[32] + tag[16]
    return {
        nonce: input.subarray(1, 1 + NONCE_LENGTH),
        ciphertext: input.subarray(1 + NONCE_LENGTH, input.length - TAG_LENGTH),
        tag: input.subarray(input.length - TAG_LENGTH),
    };
}
function unwrapV1(input) {
    const { nonce, ciphertext, tag } = splitV1V2(input);
    try {
        return openAead('aes-256-gcm', ENVELOPE_V1_KEY, nonce, ciphertext, tag);
    }
    catch {
        throw new AbeEnvelopeError('auth_failed');
    }
}
function unwrapV2(input) {
    const { nonce, ciphertext, tag } = splitV1V2(input);
    try {
        return openAead('chacha20-poly1305', ENVELOPE_V2_KEY, nonce, ciphertext, tag);
    }
    catch {
        throw new AbeEnvelopeError('auth_failed');
    }
}
function unwrapV3(input, dependencies) {
    // version[1] + cng_block[32] + nonce[12] + ciphertext[32] + tag[16]
    const cngBlock = input.subarray(1, 1 + CNG_BLOCK_LENGTH);
    const nonce = input.subarray(1 + CNG_BLOCK_LENGTH, 1 + CNG_BLOCK_LENGTH + NONCE_LENGTH);
    const ciphertext = input.subarray(1 + CNG_BLOCK_LENGTH + NONCE_LENGTH, input.length - TAG_LENGTH);
    const tag = input.subarray(input.length - TAG_LENGTH);
    if (typeof dependencies.cngDecrypt !== 'function') {
        throw new AbeEnvelopeError('cng_unavailable');
    }
    let cngPlain;
    try {
        cngPlain = dependencies.cngDecrypt(Buffer.from(cngBlock));
    }
    catch {
        throw new AbeEnvelopeError('cng_unavailable');
    }
    if (cngPlain.length !== CNG_BLOCK_LENGTH)
        throw new AbeEnvelopeError('cng_result_invalid');
    const envelopeKey = Buffer.allocUnsafe(CNG_BLOCK_LENGTH);
    for (let index = 0; index < CNG_BLOCK_LENGTH; index += 1) {
        envelopeKey[index] = cngPlain[index] ^ ENVELOPE_V3_MASK[index];
    }
    try {
        return openAead('aes-256-gcm', envelopeKey, nonce, ciphertext, tag);
    }
    catch {
        throw new AbeEnvelopeError('auth_failed');
    }
    finally {
        envelopeKey.fill(0);
        cngPlain.fill(0);
    }
}
/**
 * 仅用于测试与自检：验证内置常量长度符合各自算法的要求。
 * 生产路径不调用，导出以便单测断言常量未被误改。
 */
export function describeAbeEnvelopeConstants() {
    return {
        v1KeyLength: ENVELOPE_V1_KEY.length,
        v2KeyLength: ENVELOPE_V2_KEY.length,
        v3MaskLength: ENVELOPE_V3_MASK.length,
    };
}
/**
 * 判断给定长度的 Envelope 是否需要 CNG 解密（即是否为 v3）。
 *
 * v3 需要在 SYSTEM 上下文访问 CNG/KSP，因此调用方必须先异步取回 `cng_block` 的明文，
 * 再调用 `unwrapAbeEnvelope`。把格式判断收敛在本模块，避免调用方重复实现长度常量。
 */
export function abeEnvelopeNeedsCng(inputLength) {
    return inputLength === ENVELOPE_V3_LENGTH;
}
/**
 * 取出 v3 Envelope 中的 `cng_block`；非 v3 返回 null。
 */
export function abeEnvelopeCngBlock(input) {
    if (!abeEnvelopeNeedsCng(input.length))
        return null;
    return Buffer.from(input.subarray(1, 1 + CNG_BLOCK_LENGTH));
}
/** 常量时间比较，供上层校验 broker 回传数据时使用。 */
export function constantTimeEquals(left, right) {
    if (left.length !== right.length)
        return false;
    return timingSafeEqual(left, right);
}
