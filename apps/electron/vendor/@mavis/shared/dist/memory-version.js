/**
 * 配置自己选择的版本：`v2_enabled`；缺失时兼容旧字段 `v2.enabled`；再缺失时，打开过生成或使用即为 V2
 * （开关只在 V2 下有意义）。都没有时返回 undefined，由调用方决定缺省版本。版本字段及其优先级只在这里定义。
 */
export function explicitMemoryVersion(memory) {
    if (typeof memory !== 'object' || memory === null)
        return undefined;
    if ('v2_enabled' in memory && typeof memory.v2_enabled === 'boolean')
        return memory.v2_enabled;
    if (!('v2' in memory))
        return undefined;
    const v2 = memory.v2;
    if (typeof v2 !== 'object' || v2 === null)
        return undefined;
    if ('enabled' in v2 && typeof v2.enabled === 'boolean')
        return v2.enabled;
    const switchedOn = ('writeEnabled' in v2 && v2.writeEnabled === true) ||
        ('recallEnabled' in v2 && v2.recallEnabled === true);
    return switchedOn ? true : undefined;
}
/**
 * 选择版本，也是 V2 的启用开关；`memory.enabled` 只约束 V1。没有显式选择时为旧版：经
 * `parseMemoryConfig` 解析的配置总会写出 `v2_enabled`，缺省版本在那里补齐。
 */
export function isMemoryV2Enabled(memory) {
    return explicitMemoryVersion(memory) ?? false;
}
//# sourceMappingURL=memory-version.js.map