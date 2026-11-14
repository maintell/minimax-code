/** Default on: waiting out a 5h window needs no user action. */
export const QUOTA_AUTO_RESUME_DEFAULTS = { enabled: true };
export function parseQuotaAutoResumeConfig(raw) {
    const value = raw.quotaAutoResume;
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
        return { ...QUOTA_AUTO_RESUME_DEFAULTS };
    }
    const enabled = value.enabled;
    return {
        enabled: typeof enabled === 'boolean' ? enabled : QUOTA_AUTO_RESUME_DEFAULTS.enabled,
    };
}
//# sourceMappingURL=quota-auto-resume-config.js.map