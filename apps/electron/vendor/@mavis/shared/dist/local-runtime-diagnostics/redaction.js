const DEFAULT_POLICY_VERSION = 1;
export function isSensitiveObservabilityKey(key) {
    return /api[-_]?key|token|secret|authorization|password|credential|signature|sig/i.test(key);
}
export function maskObservabilitySecret(value) {
    return value.length > 8 ? `${value.slice(0, 4)}****${value.slice(-4)}` : '****';
}
export function maskUrlCredentials(value) {
    try {
        const parsed = new URL(value);
        if (parsed.username)
            parsed.username = '****';
        if (parsed.password)
            parsed.password = '****';
        for (const key of Array.from(parsed.searchParams.keys())) {
            if (isSensitiveObservabilityKey(key))
                parsed.searchParams.set(key, '****');
        }
        return parsed.toString();
    }
    catch {
        return value;
    }
}
export function sanitizeObservabilityText(value) {
    return value
        .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/giu, (url) => maskUrlCredentials(url))
        .replace(/\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]+/giu, '$1****')
        .replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|SIGNATURE|SIG)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)[^"',\s}]+/gu, '$1$2$3****')
        .replace(/(["'])([^"']*(?:api[-_]?key|token|secret|authorization|password|credential|signature|sig)[^"']*)\1(\s*:\s*)(["']?)[^"',\s}]+/giu, '$1$2$1$3$4****')
        .replace(/\b(api[-_]?key|token|secret|authorization|password|credential|signature|sig)\b(\s*[:=]\s*)(["']?)[^"',\s}]+/giu, '$1$2$3****');
}
function sanitizeValue(key, value) {
    if (key === 'headers' && value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.fromEntries(Object.entries(value).map(([headerKey, headerValue]) => [
            headerKey,
            typeof headerValue === 'string' ? maskObservabilitySecret(headerValue) : '****',
        ]));
    }
    if (isSensitiveObservabilityKey(key)) {
        return typeof value === 'string' ? maskObservabilitySecret(value) : '****';
    }
    if (typeof value === 'string')
        return sanitizeObservabilityText(value);
    if (Array.isArray(value))
        return value.map((item) => sanitizeValue(key, item));
    if (value && typeof value === 'object')
        return sanitizeRecord(value);
    return value;
}
function sanitizeRecord(record) {
    return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, sanitizeValue(key, value)]));
}
export function createDefaultObservabilityRedactionPolicy() {
    return {
        policyVersion: DEFAULT_POLICY_VERSION,
        sanitizeValue,
        sanitizeFields: sanitizeRecord,
    };
}
export const DEFAULT_OBSERVABILITY_REDACTION_POLICY = createDefaultObservabilityRedactionPolicy();
//# sourceMappingURL=redaction.js.map