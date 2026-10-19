import { getRuntimeLocaleLanguage } from '@mavis/shared/runtime-i18n';
/** Extract the canonical language subtag from a BCP 47 locale. */
export function getLocaleLanguage(locale) {
    return getRuntimeLocaleLanguage(locale);
}
export function isChineseLocale(locale) {
    return getRuntimeLocaleLanguage(locale) === 'zh';
}
//# sourceMappingURL=locale.js.map