/**
 * Locale resolution for channel-facing receipt/notice text.
 *
 * Migration copy (MR1) of the two tiny v1 helpers the channel system used
 * (`runtime/locale.ts` + `utils/locale.ts`). Copied instead of imported
 * because the v1 modules sit outside the migrated ownership and hold no
 * state; the language detection itself stays in @mavis/shared/runtime-i18n.
 */
import { getRuntimeLocaleLanguage } from '@mavis/shared/runtime-i18n';
/** Electron locale first; system locale fallback for CLI/headless hosts. */
export function resolveLocalRuntimeLocale() {
    const electronLocale = process.env.MAVIS_ELECTRON_LOCALE?.trim();
    if (electronLocale === 'en' || electronLocale === 'zh')
        return electronLocale;
    const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale;
    if (intlLocale)
        return intlLocale;
    const lang = process.env.LANG?.split('.')[0]?.replace('_', '-');
    return lang || 'en';
}
export function isChineseLocale(locale) {
    return getRuntimeLocaleLanguage(locale) === 'zh';
}
//# sourceMappingURL=receipt-locale.js.map