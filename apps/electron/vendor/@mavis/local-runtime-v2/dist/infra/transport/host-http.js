// ─── HTTP response header constants ─────────────────────────────────────
const JSON_HEADERS = { 'Content-Type': 'application/json' };
export const SSE_HEADERS = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
};
// ─── SSE writer wrapper used by the streaming routes ───────────────────
export class SseWriter {
    controller;
    encoder = new TextEncoder();
    closed = false;
    constructor(controller) {
        this.controller = controller;
    }
    write(data) {
        if (this.closed)
            return;
        try {
            this.controller.enqueue(this.encoder.encode(encodeSSEData(data)));
        }
        catch {
            this.closed = true;
        }
    }
    writeJson(value) {
        this.write(JSON.stringify(value));
    }
    writeEvent(data, options) {
        if (this.closed)
            return;
        try {
            this.controller.enqueue(this.encoder.encode(encodeSSEEvent(data, options)));
        }
        catch {
            this.closed = true;
        }
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        try {
            this.controller.close();
        }
        catch {
            // Consumer may have cancelled the stream.
        }
    }
}
// ─── Pure URL/path helpers ─────────────────────────────────────────────
export function splitPath(pathname) {
    return pathname.split('/').filter(Boolean);
}
// ─── Response factories ────────────────────────────────────────────────
export function json(data, init) {
    return new Response(JSON.stringify(data), {
        status: init?.status ?? 200,
        statusText: init?.statusText,
        headers: { ...JSON_HEADERS, ...(init?.headers ?? {}) },
    });
}
export function notFound(pathname) {
    return json({ error: `Local runtime route not found: ${pathname}` }, { status: 404 });
}
export async function readJsonBody(request) {
    try {
        const data = (await request.json());
        return data && typeof data === 'object' && !Array.isArray(data)
            ? data
            : {};
    }
    catch {
        return {};
    }
}
// ─── Field readers ─────────────────────────────────────────────────────
export function readString(data, key) {
    const value = data[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
export function readVisibility(data) {
    const value = data.visibility;
    return value === 'visible' || value === 'hidden' ? value : undefined;
}
export function readRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
export function readRequestedFramework(data) {
    const raw = data.frameworkType ?? data.framework_type ?? data.engine;
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}
// ─── Agent name + model id helpers ─────────────────────────────────────
export function buildGeneratedAgentName() {
    const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '').slice(0, 12) ??
        `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.slice(0, 12);
    return `agent-${random}`;
}
export function isValidLocalAgentName(name) {
    return /^[a-z][a-z0-9_-]*$/.test(name);
}
export function splitModelId(model) {
    // Split at the FIRST slash only and keep the remainder as the model id:
    // custom model ids may themselves contain slashes (OpenRouter-style
    // vendor/model). Aligned with parseModelKey / parseSourceQualifiedModelKey;
    // behavior is unchanged for all zero- and one-slash inputs.
    const slash = model.indexOf('/');
    if (slash < 0)
        return [model || undefined, undefined];
    return [model.slice(0, slash) || undefined, model.slice(slash + 1) || undefined];
}
export function readFirstString(data, keys) {
    for (const key of keys) {
        const value = data[key];
        if (typeof value === 'string' && value.length > 0)
            return value;
    }
    return undefined;
}
// ─── SSE encoding + ID generation ──────────────────────────────────────
function encodeSSEData(data) {
    return `data: ${data.replace(/\r\n|\r|\n/g, '\ndata: ')}\n\n`;
}
function encodeSSEEvent(data, options) {
    const lines = [];
    if (options?.id)
        lines.push(`id: ${options.id}`);
    if (options?.event)
        lines.push(`event: ${options.event}`);
    lines.push(`data: ${data.replace(/\r\n|\r|\n/g, '\ndata: ')}`);
    return `${lines.join('\n')}\n\n`;
}
export function makeId(prefix) {
    const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '') ??
        `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    return `${prefix}_${random}`;
}
export function safeJsonStringify(value) {
    try {
        return JSON.stringify(value);
    }
    catch {
        return undefined;
    }
}
// ─── Config sanitization (mask secrets in API responses) ───────────────
// Generic over the runtime config shape so the helpers compile here
// without importing `LocalRuntimeConfig` (keeps this file dependency-free
// against the host's type surface).
export function sanitizeConfig(config) {
    return {
        ...sanitizeRecord(config),
        provider: sanitizeProviderConfig((config.provider ?? {})),
    };
}
export function sanitizeProviderConfig(provider) {
    return Object.fromEntries(Object.entries(provider).map(([providerId, providerConfig]) => [
        providerId,
        sanitizeRecord(providerConfig),
    ]));
}
function sanitizeRecord(record) {
    return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, sanitizeConfigValue(key, value)]));
}
export function sanitizeConfigValue(key, value) {
    if (isSensitiveKey(key)) {
        return typeof value === 'string' ? maskSecret(value) : '****';
    }
    if (typeof value === 'string') {
        return maskUrlCredentials(value);
    }
    if (Array.isArray(value)) {
        return value.map((item) => sanitizeConfigValue(key, item));
    }
    if (value && typeof value === 'object') {
        if (key === 'headers') {
            return Object.fromEntries(Object.entries(value).map(([headerKey, headerValue]) => [
                headerKey,
                typeof headerValue === 'string' ? maskSecret(headerValue) : '****',
            ]));
        }
        return sanitizeRecord(value);
    }
    return value;
}
function isSensitiveKey(key) {
    return /api[-_]?key|token|secret|authorization|password|credential/i.test(key);
}
function maskSecret(value) {
    return value.length > 8 ? `${value.slice(0, 4)}****${value.slice(-4)}` : '****';
}
function maskUrlCredentials(value) {
    try {
        const url = new URL(value);
        if (!url.username && !url.password)
            return value;
        if (url.username)
            url.username = '****';
        if (url.password)
            url.password = '****';
        return url.toString();
    }
    catch {
        return value;
    }
}
//# sourceMappingURL=host-http.js.map