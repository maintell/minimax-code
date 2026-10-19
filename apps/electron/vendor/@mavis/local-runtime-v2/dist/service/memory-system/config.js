import { isMemoryV2Enabled, MEMORY_V2_DEFAULTS } from '@mavis/config';
/** 显式 undefined 保持应用配置的默认值。 */
export function resolveMemoryV2Config(overrides = {}) {
    return {
        ...MEMORY_V2_DEFAULTS,
        // 直接装配领域服务沿用显式启用语义；应用总开关由完整配置入口合成。
        active: true,
        ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)),
        enabled: isMemoryV2Enabled({ v2: overrides }),
    };
}
/** 保留持久偏好，领域服务只消费当前有效权限。 */
export function resolveMemorySystemConfig(memory = {}) {
    const active = memory.enabled !== false && isMemoryV2Enabled(memory);
    const preferences = resolveMemoryV2Config(memory.v2);
    return {
        ...preferences,
        active,
        // 旧服务仍读取嵌套版本字段；统一映射为有效启用状态。
        enabled: active,
        writeEnabled: active && preferences.writeEnabled,
        recallEnabled: active && preferences.recallEnabled,
    };
}
//# sourceMappingURL=config.js.map