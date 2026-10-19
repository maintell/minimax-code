export const PERMISSION_MODE_OPTIONS = [
    {
        value: 'default',
        labelI18n: { zhHans: '主动询问', en: 'Ask for approval' },
        descriptionI18n: {
            zhHans: '需要权限时主动询问确认',
            en: 'Ask for confirmation when permission is required',
        },
    },
    {
        value: 'auto',
        labelI18n: { zhHans: '智能授权', en: 'Smart authorization' },
        descriptionI18n: {
            zhHans: 'AI 判断操作安全性，仅高风险时询问',
            en: 'AI evaluates risk, only asks on high-risk ops',
        },
    },
    {
        value: 'bypassPermissions',
        labelI18n: { zhHans: '始终授权', en: 'Full access' },
        descriptionI18n: {
            zhHans: '跳过所有权限检查，不再弹出授权确认',
            en: 'Skip all permission checks, no confirmation',
        },
    },
    {
        value: 'acceptEdits',
        labelI18n: { zhHans: '接受编辑', en: 'Accept Edits' },
        descriptionI18n: {
            zhHans: '允许读写，阻止命令',
            en: 'Allow read & write, block commands',
        },
    },
    {
        value: 'off',
        labelI18n: { zhHans: '关闭权限检查', en: 'Disable Permission Checks' },
        descriptionI18n: {
            zhHans: '关闭权限检查流程，仅供内部或无人值守场景使用',
            en: 'Disable the permission-check pipeline for internal or unattended scenarios',
        },
    },
];
const VALID_PERMISSION_MODES = new Set(PERMISSION_MODE_OPTIONS.map((item) => item.value));
export function isLocalPermissionModeString(value) {
    return typeof value === 'string' && VALID_PERMISSION_MODES.has(value);
}
export function normalizePermissionModeConfigBody(body) {
    const mode = body.permissionMode;
    if (!isLocalPermissionModeString(mode))
        return body;
    return {
        ...body,
        permissionMode: mode,
    };
}
const EXPOSED_PERMISSION_MODE_VALUES = new Set(['default', 'auto', 'bypassPermissions']);
export function resolvePermissionModeOptionLocale() {
    const fromDesktop = process.env.NEXT_PUBLIC_LOCALE || process.env.MAVIS_ELECTRON_LOCALE;
    return normalizePermissionModeOptionLocale(fromDesktop || Intl.DateTimeFormat().resolvedOptions().locale || process.env.LANG);
}
function normalizePermissionModeOptionLocale(locale) {
    const normalized = locale?.trim().toLowerCase().replace('_', '-');
    return normalized?.startsWith('zh') ? 'zhHans' : 'en';
}
export function buildPermissionModeOptionsResponse(locale = resolvePermissionModeOptionLocale()) {
    return PERMISSION_MODE_OPTIONS.filter((item) => EXPOSED_PERMISSION_MODE_VALUES.has(item.value)).map((item) => ({
        value: item.value,
        label_i18n: item.labelI18n[locale],
        description_i18n: item.descriptionI18n[locale],
    }));
}
//# sourceMappingURL=permission-mode-mapping.js.map