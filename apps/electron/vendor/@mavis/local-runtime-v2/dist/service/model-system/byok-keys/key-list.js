import { createHash } from 'node:crypto';
import { resolveProviderCredential } from '@mavis/config';
import { LocalModelProviderError, } from '../contracts.js';
import { assertValidRawApiKey } from '../management/service-input.js';
import { maskSecret } from '../secret.js';
const BYOK_API_KEY_LIMIT = 200;
const NAME_LIMIT = 64;
/** `k_` and the first 10 hex characters of the key value's sha256. @internal */
export function apiKeyId(key) {
    return `k_${createHash('sha256').update(key.trim()).digest('hex').slice(0, 10)}`;
}
/** Splits pasted text into keys on newlines, commas and spaces. @internal */
export function splitApiKeys(text) {
    return [
        ...new Set(text
            .split(/[\s,]+/u)
            .map((part) => part.trim())
            .filter(Boolean)),
    ];
}
function readName(value) {
    if (typeof value !== 'string')
        return undefined;
    const name = value.trim().slice(0, NAME_LIMIT);
    return name || undefined;
}
/** The provider's keys. Malformed entries are skipped; duplicates keep their first place. */
export function readApiKeys(provider) {
    const listed = readListedKeys(provider?.options?.apiKeys);
    if (listed.length > 0)
        return listed;
    const single = typeof provider?.options?.apiKey === 'string' ? provider.options.apiKey.trim() : '';
    return single ? [{ id: apiKeyId(single), key: single, enabled: true }] : [];
}
function readListedKeys(raw) {
    if (!Array.isArray(raw))
        return [];
    const seen = new Set();
    const keys = [];
    for (const item of raw) {
        const key = readListedKey(item);
        if (!key || seen.has(key.id))
            continue;
        seen.add(key.id);
        keys.push(key);
    }
    return keys;
}
function readListedKey(item) {
    if (!item || typeof item !== 'object')
        return undefined;
    const entry = item;
    const key = typeof entry.key === 'string' ? entry.key.trim() : '';
    if (!key)
        return undefined;
    const name = readName(entry.name);
    return { id: apiKeyId(key), key, enabled: entry.enabled !== false, ...(name ? { name } : {}) };
}
export function enabledApiKeys(provider) {
    return readApiKeys(provider).filter((key) => key.enabled);
}
/** The stored key value for a request, `${VAR}` resolved; throws on a broken reference. */
export function resolveApiKeyValue(key, provider) {
    return resolveProviderCredential({
        field: 'custom_provider options.apiKeys',
        provider,
        value: key.key,
    });
}
/** Display form: masked value, or the reference itself for `${VAR}` (it holds no secret). */
export function maskApiKey(key) {
    return /^\$\{[^}]+\}$/u.test(key.key) ? key.key : maskSecret(key.key);
}
/** A key's label for the user: its name, else its masked value. */
export function apiKeyLabel(key) {
    return key.name ?? maskApiKey(key);
}
function validationError(message) {
    return new LocalModelProviderError(400, message, 'VALIDATION_ERROR');
}
/**
 * The key list a save produces. Drafts are taken in order; one naming an id without a value keeps
 * that stored key (its name and switch may change), one with a value adds it or replaces the value.
 * Stored keys the drafts don't name are dropped. Rejects an unknown id, a duplicate, a masked
 * value, too many keys, or no enabled key at all.
 */
export function mergeApiKeyDrafts(current, drafts) {
    if (drafts.length > BYOK_API_KEY_LIMIT) {
        throw validationError(`At most ${BYOK_API_KEY_LIMIT} API keys are allowed`);
    }
    const byId = new Map(current.map((key) => [key.id, key]));
    const seen = new Set();
    const next = [];
    for (const draft of drafts) {
        let key;
        if (draft.key !== undefined) {
            key = assertValidRawApiKey(draft.key);
        }
        else {
            const stored = draft.id ? byId.get(draft.id) : undefined;
            if (!stored) {
                throw new LocalModelProviderError(404, 'API key not found', 'API_KEY_NOT_FOUND');
            }
            key = stored.key;
        }
        const id = apiKeyId(key);
        if (seen.has(id))
            throw new LocalModelProviderError(400, 'Duplicate API key', 'API_KEY_DUPLICATE');
        seen.add(id);
        const name = readName(draft.name);
        next.push({ id, key, enabled: draft.enabled, ...(name ? { name } : {}) });
    }
    if (!next.some((key) => key.enabled)) {
        throw new LocalModelProviderError(400, 'At least one API key must be enabled', 'NO_API_KEY');
    }
    return next;
}
/**
 * A legacy single-key write (`apiKey` only): replaces the first key and keeps the rest, so an
 * older client never wipes keys it cannot see.
 */
export function replaceFirstApiKey(current, rawKey) {
    const key = assertValidRawApiKey(rawKey);
    const id = apiKeyId(key);
    const rest = current.slice(1).filter((entry) => entry.id !== id);
    const first = current[0];
    return [{ id, key, enabled: true, ...(first?.name ? { name: first.name } : {}) }, ...rest];
}
/**
 * Writes the list onto provider options. One enabled key with no name is stored as plain `apiKey`
 * (the shape every older reader knows); otherwise `apiKeys` is written and `apiKey` mirrors the
 * first enabled key.
 */
export function writeApiKeys(options, keys) {
    const first = keys.find((key) => key.enabled);
    if (!first) {
        delete options.apiKey;
        delete options.apiKeys;
        return;
    }
    options.apiKey = first.key;
    if (keys.length === 1 && !first.name) {
        delete options.apiKeys;
        return;
    }
    options.apiKeys = keys.map((key) => ({
        id: key.id,
        ...(key.name ? { name: key.name } : {}),
        key: key.key,
        enabled: key.enabled,
    }));
}
//# sourceMappingURL=key-list.js.map