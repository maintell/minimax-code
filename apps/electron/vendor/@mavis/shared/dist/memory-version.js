/** 选择版本，也是 V2 的启用开关；`memory.enabled` 只约束 V1。旧字段仅用于缺失新字段的配置兼容。 */
export function isMemoryV2Enabled(memory) {
    if (typeof memory !== 'object' || memory === null)
        return false;
    if ('v2_enabled' in memory && typeof memory.v2_enabled === 'boolean')
        return memory.v2_enabled;
    if (!('v2' in memory))
        return false;
    const v2 = memory.v2;
    if (typeof v2 !== 'object' || v2 === null)
        return false;
    if ('enabled' in v2 && typeof v2.enabled === 'boolean')
        return v2.enabled;
    return (('writeEnabled' in v2 && v2.writeEnabled === true) ||
        ('recallEnabled' in v2 && v2.recallEnabled === true));
}
//# sourceMappingURL=memory-version.js.map