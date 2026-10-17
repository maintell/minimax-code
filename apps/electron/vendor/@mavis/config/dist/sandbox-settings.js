/** 各平台默认完全访问且关闭删除防护；保留平台参数供调用方共用。 */
export function getDefaultSandboxSettings(_platform) {
    return { enabled: false, filesystemMode: 'full_access' };
}
/** 旧的总开关关闭值及完全访问均收敛为无沙箱，保留其他已启用等级。 */
export function normalizeSandboxSettings(settings) {
    return !settings.enabled || settings.filesystemMode === 'full_access'
        ? { enabled: false, filesystemMode: 'full_access' }
        : { ...settings };
}
//# sourceMappingURL=sandbox-settings.js.map