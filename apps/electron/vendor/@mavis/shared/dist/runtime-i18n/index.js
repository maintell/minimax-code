import { EN_RUNTIME_TRANSLATIONS, } from './en.js';
import { ZH_HANS_RUNTIME_TRANSLATIONS } from './zh-Hans.js';
const DEFAULT_RUNTIME_LOCALE = 'en';
const RUNTIME_TRANSLATIONS = {
    en: EN_RUNTIME_TRANSLATIONS,
    'zh-Hans': ZH_HANS_RUNTIME_TRANSLATIONS,
};
/** Extract the canonical language subtag from a BCP 47 locale. */
export function getRuntimeLocaleLanguage(locale) {
    const candidate = locale?.trim().replace(/_/gu, '-');
    if (!candidate)
        return DEFAULT_RUNTIME_LOCALE;
    try {
        return new Intl.Locale(candidate).language.toLowerCase();
    }
    catch {
        return candidate.split('-')[0]?.toLowerCase() || DEFAULT_RUNTIME_LOCALE;
    }
}
function resolveRuntimeLocale(locale) {
    return getRuntimeLocaleLanguage(locale) === 'zh' ? 'zh-Hans' : DEFAULT_RUNTIME_LOCALE;
}
export function translateRuntimeText(locale, key) {
    return RUNTIME_TRANSLATIONS[resolveRuntimeLocale(locale)][key];
}
//# sourceMappingURL=index.js.map