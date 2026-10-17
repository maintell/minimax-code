export const DEFAULT_LOCAL_APP_MODE = 'coding';
export function resolveLocalAppMode(value) {
    return value === 'work' || value === 'coding' ? value : DEFAULT_LOCAL_APP_MODE;
}
export function canUseRunLocationForAppMode(appMode) {
    return appMode === 'coding';
}
//# sourceMappingURL=app-mode.js.map