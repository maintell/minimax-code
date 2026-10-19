// 交接组合须与 archon_server_config.models 的 provider:model key 对齐。
// 当前 M3 登记为 minimax:MiniMax-M3；不能仅因 model_providers 存在 minimax_m3
// 就切换 provider，否则 catalog 校验未命中会回退到服务端默认模型。
const CLOUD_MODEL_BY_LOCAL_KEY = new Map([
    ['minimax/MiniMax-M3', { providerId: 'minimax', modelId: 'MiniMax-M3' }],
]);
// 保留未映射模型使用 M3 的交接策略，fallback 也必须对齐云端 catalog。
// BYOK (`custom_provider:*`) 凭据只在本机，不把其 provider 或凭据传到云端。
const CLOUD_MODEL_FALLBACK = {
    providerId: 'minimax',
    modelId: 'MiniMax-M3',
};
/**
 * 把本地会话选中的模型翻译成云端 catalog 认识的组合。始终返回一个选择:服务端把
 * "没传" 与 "传了但认不出" 同等处理,两者都会静默降级,不会报错。
 */
export function handoffCloudModel(session) {
    const localKey = session.effectiveModel?.trim();
    const mapped = localKey ? CLOUD_MODEL_BY_LOCAL_KEY.get(localKey) : undefined;
    if (!mapped)
        return { ...CLOUD_MODEL_FALLBACK };
    // variant 只在模型本身对得上时透传:换成 fallback 模型后原 variant 未必被目标
    // 模型支持,而服务端的 alias 匹配把 variant 也算在内,带错反而又是一次 miss。
    //
    // thinking(effort / off_behavior / budgets)这里不带:服务端
    // explicitModelFromInput 只复制 provider/model/variant 三元组,
    // archon_server_base.ModelSelection 也只有这三个字段,传上去会被静默丢弃。
    // 要支持得先改 IDL 再打通 server 解析/持久化/provisioning,不在本次范围内。
    return { ...mapped, ...(cloudVariant(session.effectiveModelVariant) ?? {}) };
}
// 端上把「关闭思考」编码成空串(catalog 把 `none-thinking` 规范化成 ''),而云端的
// 空串是另一个意思 —— assembler 的 VariantNone 表示"模型本身无 variant 概念,沿用
// Host 默认",显式关闭是字面量 VariantNoneThinking(`none-thinking`)。原样上传会
// 把"用户关掉了思考"变成"用默认",而云端 M3 的默认可能正是开启,用户意图就反了。
//
// 没选 variant 时本地存的是 null(model-provider-application.ts:69 的
// `input.variant ?? null`),与显式的空串可区分,所以这里的翻译不会误伤单档模型。
const CLOUD_VARIANT_NONE_THINKING = 'none-thinking';
function cloudVariant(value) {
    if (typeof value !== 'string')
        return undefined;
    const normalized = value.trim();
    if (normalized === '' || normalized === CLOUD_VARIANT_NONE_THINKING) {
        return { variant: CLOUD_VARIANT_NONE_THINKING };
    }
    return { variant: normalized };
}
//# sourceMappingURL=model-selection.js.map