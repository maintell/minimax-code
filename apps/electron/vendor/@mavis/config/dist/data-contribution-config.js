export const DATA_CONTRIBUTION_CONFIG_DEFAULTS = {
    enabled: true,
    enabledSource: 'default',
};
export function parseDataContributionConfig(raw, defaults = DATA_CONTRIBUTION_CONFIG_DEFAULTS) {
    const rawDataContribution = raw.dataContribution;
    if (rawDataContribution == null ||
        typeof rawDataContribution !== 'object' ||
        Array.isArray(rawDataContribution)) {
        return { ...defaults, enabledSource: 'default' };
    }
    const obj = rawDataContribution;
    const hasExplicitEnabled = typeof obj.enabled === 'boolean';
    return {
        enabled: hasExplicitEnabled ? obj.enabled : defaults.enabled,
        enabledSource: hasExplicitEnabled ? 'explicit' : 'default',
    };
}
/**
 * 从一个 config getter 里读开关，永不抛错。
 *
 * 传 getter 而不是 config 对象，是为了让调用方每次求值都拿到最新的 `config.yaml`
 * 结果(`getConfig()` 自带进程内缓存，写盘方会 `resetConfig()`),这样用户在设置里
 * 改完开关后无需重启进程即可生效。
 */
export function readDataContributionEnabled(configGetter) {
    try {
        const value = configGetter()?.dataContribution?.enabled;
        return typeof value === 'boolean' ? value : DATA_CONTRIBUTION_CONFIG_DEFAULTS.enabled;
    }
    catch {
        return DATA_CONTRIBUTION_CONFIG_DEFAULTS.enabled;
    }
}
//# sourceMappingURL=data-contribution-config.js.map