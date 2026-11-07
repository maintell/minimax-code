import fs from "node:fs";
import path from "node:path";
// Mirrors BROWSER_BACKEND_APOLLO_KEY; @mavis/shared/browser-backend is ESM-only
// and Main's CommonJS build may import only its types.
const BROWSER_BACKEND_APOLLO_KEY = 'agent_desktop_browser_backend';
const FILE_VERSION = 1;
const MAX_ENTRIES = 8;
function readFile(filePath) {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (parsed?.version === FILE_VERSION &&
            parsed.entries &&
            typeof parsed.entries === 'object' &&
            !Array.isArray(parsed.entries)) {
            return { version: FILE_VERSION, entries: parsed.entries };
        }
    }
    catch {
        // Missing or corrupt cache behaves like a first launch.
    }
    return { version: FILE_VERSION, entries: {} };
}
/**
 * Last valid backend policy per service origin and account, written only by
 * Main. Entries are re-validated by the policy parser on every read.
 */
export function createFileBrowserBackendPolicyStore(options) {
    const now = options.now ?? Date.now;
    const key = (accountId) => `${options.scope}\n${accountId}`;
    return {
        load(accountId) {
            return readFile(options.filePath).entries[key(accountId)]?.config;
        },
        save(accountId, config) {
            const file = readFile(options.filePath);
            file.entries[key(accountId)] = { config, savedAt: now() };
            const kept = Object.entries(file.entries)
                .sort(([, a], [, b]) => (b?.savedAt ?? 0) - (a?.savedAt ?? 0))
                .slice(0, MAX_ENTRIES);
            file.entries = Object.fromEntries(kept);
            fs.mkdirSync(path.dirname(options.filePath), { recursive: true });
            const temp = `${options.filePath}.${process.pid}.tmp`;
            fs.writeFileSync(temp, JSON.stringify(file), { mode: 0o600 });
            fs.renameSync(temp, options.filePath);
        },
    };
}
/**
 * Reads the public common_config key directly from Main. Rollout membership is
 * evaluated locally, so the request carries no credentials or user identity.
 * Resolves to the raw value, or undefined when the key is authoritatively absent.
 */
export async function fetchBrowserBackendRemotePolicy(options) {
    const url = new URL('/v1/api/config/web/common_config', options.origin);
    url.search = new URLSearchParams({
        filter: BROWSER_BACKEND_APOLLO_KEY,
        device_platform: 'web',
        biz_id: '3',
        app_id: '3001',
        is_desktop: '1',
        client: 'desktop',
    }).toString();
    const response = await options.fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        headers: { Accept: 'application/json' },
        signal: options.signal,
    });
    if (!response.ok)
        throw new Error(`Browser backend policy unavailable (HTTP ${response.status}).`);
    const body = (await response.json());
    const status = body?.statusInfo;
    const base = body?.base_resp;
    if ((status?.code !== undefined && status.code !== 0) || (base?.status_code ?? 0) !== 0) {
        throw new Error('Browser backend policy request was rejected.');
    }
    const data = body?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Malformed browser backend policy response.');
    }
    return data[BROWSER_BACKEND_APOLLO_KEY];
}
