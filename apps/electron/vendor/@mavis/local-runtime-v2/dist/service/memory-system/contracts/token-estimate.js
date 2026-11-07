/**
 * 抽取预算的固定估算口径：按 UTF-8 字节数 / 4 估算 token，不随 tokenizer 实现漂移。
 * 历史裁剪、合同上限扣除提示词开销、重抽时为旧文档预留额度都用同一口径，保证各项可相加。
 */
export function estimateCaptureTokens(value) {
    return Math.ceil(Buffer.byteLength(value, 'utf8') / 4);
}
//# sourceMappingURL=token-estimate.js.map