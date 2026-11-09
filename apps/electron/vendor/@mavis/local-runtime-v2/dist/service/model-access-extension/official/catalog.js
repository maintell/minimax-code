import { MODEL_ACCESS_SDK_MAJORS } from '@minimax/model-access-sdk';
import { parseStrictJson } from './text.js';
/**
 * Desktop reader of `model-access-catalog-v1` / `model-access-attestation-v1`. The delivery
 * service validates the same schema on publish. Anything this reader does not understand is
 * rejected, never partially applied.
 */
export class ModelAccessCatalogError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'ModelAccessCatalogError';
    }
}
export const REMOTE_ACCESS_CAPABILITIES = [
    'subscriptions',
    'login',
    'subscriptionBorrow',
    'apiKeyScan',
];
export function remoteEntryKey(capability, entryId, target) {
    return `${capability}/${entryId}/${target}`;
}
const PACKAGE_NAME = /^@[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const CONTENT_DIGEST = /^sha256-tree-v1:[0-9a-f]{64}$/u;
const IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/u;
const REASON = /^[a-z][a-z0-9_]{0,63}$/u;
// Same id rule as manifest entry / target ids; capability is concrete (never `subscriptions`).
const ENTRY_KEY = /^(login|subscriptionBorrow|apiKeyScan)\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u;
const MAX_SOURCE_ENTRIES = 64;
const GIT_COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const SDK_RANGE = /^\^[1-9]\d{0,8}$/u;
const ICON_PATH = /\/model-access\/v1\/icons\/([0-9a-f]{64})\.(png|jpg|jpeg|webp)$/u;
const PLATFORMS = new Set(['darwin', 'win32', 'linux']);
const MAX_STATEMENT_BYTES = 1024 * 1024;
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const MAX_ICON_BYTES = 1024 * 1024;
function record(value, required, optional, fail) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        fail();
    const item = value;
    for (const key of Object.keys(item))
        if (!required.includes(key) && !optional.includes(key))
            fail();
    for (const key of required)
        if (!Object.hasOwn(item, key))
            fail();
    return item;
}
function map(value, limit, fail) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        fail();
    const item = value;
    if (Object.keys(item).length > limit)
        fail();
    return item;
}
function list(value, limit, fail) {
    if (!Array.isArray(value) || value.length > limit)
        fail();
    return value;
}
function text(value, pattern, fail, maxLength = 128) {
    if (typeof value !== 'string' || value.length > maxLength || !pattern.test(value))
        fail();
    return value;
}
function integer(value, minimum, maximum, fail) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
        fail();
    return value;
}
function reason(value, fail) {
    // The server accepts "" as "no reason"; anything else must be a localizable machine code.
    if (value === undefined || value === '')
        return undefined;
    return text(value, REASON, fail, 64);
}
function rule(value, visibilityRequired, fail) {
    const item = record(value, visibilityRequired ? ['state', 'visibility'] : ['state'], visibilityRequired ? ['reason'] : ['visibility', 'reason'], fail);
    if (item.state !== 'disabled')
        fail();
    const visibility = item.visibility ?? (visibilityRequired ? undefined : 'visible');
    if (visibility !== 'visible' && visibility !== 'hidden')
        fail();
    const code = reason(item.reason, fail);
    return Object.freeze({
        visibility: visibility,
        ...(code ? { reason: code } : {}),
    });
}
function capabilityRules(value, fail) {
    const item = map(value, REMOTE_ACCESS_CAPABILITIES.length, fail);
    const keys = Object.keys(item);
    const result = {};
    for (const key of keys) {
        if (!REMOTE_ACCESS_CAPABILITIES.includes(key))
            fail();
        result[key] = rule(item[key], true, fail);
    }
    return Object.freeze(result);
}
/** Capability keys and/or `entries`; at least one of them. */
function sourceRules(value, fail) {
    const item = record(value, [], [...REMOTE_ACCESS_CAPABILITIES, 'entries'], fail);
    const { entries: rawEntries, ...capabilities } = item;
    const result = {
        ...capabilityRules(capabilities, fail),
    };
    let entries;
    if (rawEntries !== undefined) {
        entries = {};
        for (const [entryKey, raw] of Object.entries(map(rawEntries, MAX_SOURCE_ENTRIES, fail))) {
            text(entryKey, ENTRY_KEY, fail, 300);
            entries[entryKey] = rule(raw, false, fail);
        }
    }
    if (Object.keys(result).length + Object.keys(entries ?? {}).length === 0)
        fail();
    return Object.freeze({ ...result, ...(entries ? { entries: Object.freeze(entries) } : {}) });
}
function entryPresentations(value, fail) {
    const result = {};
    for (const [entryKey, raw] of Object.entries(map(value, MAX_SOURCE_ENTRIES, fail))) {
        text(entryKey, ENTRY_KEY, fail, 300);
        const entry = record(raw, ['displayName'], ['order'], fail);
        result[entryKey] = Object.freeze({
            displayName: localized(entry.displayName, 128, fail),
            ...(entry.order !== undefined ? { order: integer(entry.order, 0, 1_000_000, fail) } : {}),
        });
    }
    return Object.freeze(result);
}
function localized(value, maxBytes, fail) {
    const item = record(value, ['en', 'zh-Hans'], [], fail);
    const read = (field) => {
        if (typeof field !== 'string' ||
            !field ||
            field.trim() !== field ||
            Buffer.byteLength(field) > maxBytes)
            fail();
        return field;
    };
    return Object.freeze({ en: read(item.en), zhHans: read(item['zh-Hans']) });
}
function icon(value, fail) {
    const item = record(value, ['url', 'sha256', 'sizeBytes'], [], fail);
    const url = text(item.url, /^https:\/\//u, fail, 2048);
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return fail();
    }
    if (parsed.protocol !== 'https:' ||
        !parsed.hostname ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash)
        fail();
    const sha256 = text(item.sha256, SHA256, fail);
    const match = ICON_PATH.exec(parsed.pathname);
    if (!match || match[1] !== sha256)
        fail();
    return Object.freeze({
        url,
        sha256,
        sizeBytes: integer(item.sizeBytes, 1, MAX_ICON_BYTES, fail),
        extension: match[2],
    });
}
function presentationEntries(value, fail, withEntries = false) {
    if (value === undefined)
        return Object.freeze({});
    const item = map(value, 512, fail);
    const result = {};
    for (const [id, raw] of Object.entries(item)) {
        text(id, IDENTIFIER, fail);
        // Only sources name their entry points; providers never carry entries.
        const entry = record(raw, [], [
            'displayName',
            'description',
            'order',
            'icon',
            'darkIcon',
            ...(withEntries ? ['entries'] : []),
        ], fail);
        result[id] = Object.freeze({
            ...(entry.displayName !== undefined
                ? { displayName: localized(entry.displayName, 128, fail) }
                : {}),
            ...(entry.description !== undefined
                ? { description: localized(entry.description, 1024, fail) }
                : {}),
            ...(entry.order !== undefined ? { order: integer(entry.order, 0, 1_000_000, fail) } : {}),
            ...(entry.icon !== undefined ? { icon: icon(entry.icon, fail) } : {}),
            ...(entry.darkIcon !== undefined ? { darkIcon: icon(entry.darkIcon, fail) } : {}),
            ...(entry.entries !== undefined ? { entries: entryPresentations(entry.entries, fail) } : {}),
        });
    }
    return Object.freeze(result);
}
function catalogPackage(value, fail) {
    const item = record(value, ['name', 'version', 'archiveSha256', 'contentDigest'], ['rollbackReason'], fail);
    const rollbackReason = item.rollbackReason;
    if (rollbackReason !== undefined &&
        (typeof rollbackReason !== 'string' || rollbackReason.length > 512))
        fail();
    return Object.freeze({
        name: text(item.name, PACKAGE_NAME, fail),
        version: text(item.version, SEMVER, fail, 64),
        archiveSha256: text(item.archiveSha256, SHA256, fail),
        contentDigest: text(item.contentDigest, CONTENT_DIGEST, fail, 128),
        ...(rollbackReason ? { rollbackReason: rollbackReason } : {}),
    });
}
function providerRules(value, fail) {
    const result = {};
    for (const [id, entry] of Object.entries(map(value, 256, fail))) {
        text(id, IDENTIFIER, fail);
        result[id] = rule(entry, false, fail);
    }
    return Object.freeze(result);
}
const LOCAL_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ANY_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,63}$/u;
/** Per-source rules, each source id validated. */
function sourcePolicyOf(value, fail) {
    const sourcePolicy = {};
    for (const [id, sourceValue] of Object.entries(map(value ?? {}, 256, fail))) {
        text(id, IDENTIFIER, fail);
        sourcePolicy[id] = sourceRules(sourceValue, fail);
    }
    return Object.freeze(sourcePolicy);
}
/** Official rules scoped to one delivered package. */
function packagePolicyOf(value, delivered, fail) {
    const official = value === undefined ? {} : record(value, [], ['packages'], fail);
    const packagePolicy = {};
    for (const [name, entryValue] of Object.entries(map(official.packages ?? {}, 64, fail))) {
        // A rule can only name a package this catalog delivers.
        if (!delivered.has(text(name, PACKAGE_NAME, fail)))
            fail();
        const entry = record(entryValue, [], ['providers', 'sources'], fail);
        packagePolicy[name] = Object.freeze({
            providerPolicy: providerRules(entry.providers ?? {}, fail),
            sourcePolicy: sourcePolicyOf(entry.sources, fail),
        });
    }
    return Object.freeze(packagePolicy);
}
function userPackagesOf(value, fail) {
    const user = value === undefined ? {} : record(value, [], ['revokedDigests', 'revokedNames'], fail);
    const revokedDigests = list(user.revokedDigests ?? [], 1024, fail).map((item) => text(item, LOCAL_DIGEST, fail));
    const revokedNames = list(user.revokedNames ?? [], 256, fail).map((item) => text(item, ANY_PACKAGE_NAME, fail));
    return Object.freeze({
        revokedDigests: Object.freeze([...new Set(revokedDigests)]),
        revokedNames: Object.freeze([...new Set(revokedNames)]),
    });
}
/** Package-scoped official rules and user-package revocations (catalog v2 only). */
function catalogV2Fields(root, delivered, fail) {
    return {
        packagePolicy: packagePolicyOf(root.officialPolicy, delivered, fail),
        credentialMigrations: credentialMigrations(root.credentialMigrations, delivered, fail),
        userPackages: userPackagesOf(root.userPackages, fail),
    };
}
/**
 * `to` must be delivered by this catalog; one provider moves at most once per catalog. An empty
 * `providers` moves only the capability switches of the sources `to` declares.
 */
function credentialMigrations(value, delivered, fail) {
    if (value === undefined)
        return Object.freeze([]);
    const moved = new Set();
    return Object.freeze(list(value, 64, fail).map((item) => {
        const entry = record(item, ['from', 'to', 'providers'], [], fail);
        const from = text(entry.from, PACKAGE_NAME, fail);
        const to = text(entry.to, PACKAGE_NAME, fail);
        if (from === to || !delivered.has(to))
            fail();
        const providers = list(entry.providers, 64, fail).map((id) => text(id, IDENTIFIER, fail));
        for (const id of providers) {
            const key = `${from}\0${id}`;
            if (moved.has(key))
                fail();
            moved.add(key);
        }
        return Object.freeze({ from, to, providers: Object.freeze(providers) });
    }));
}
function statement(json, fail) {
    if (!json || Buffer.byteLength(json) > MAX_STATEMENT_BYTES)
        fail();
    try {
        return parseStrictJson(json);
    }
    catch {
        return fail();
    }
}
const CATALOG_V1_KEYS = {
    required: ['schema', 'environment', 'sequence', 'packages', 'providerPolicy', 'revokedDigests'],
    optional: ['accessPolicy', 'presentation'],
};
const CATALOG_V2_KEYS = {
    required: ['schema', 'environment', 'sequence', 'packages', 'revokedDigests'],
    optional: [
        'providerPolicy',
        'accessPolicy',
        'presentation',
        'officialPolicy',
        'userPackages',
        'credentialMigrations',
    ],
};
/** The envelope: schema, environment and a sequence that matches and is not stale. */
function catalogSequence(root, v2, input, fail) {
    if (!v2 && root.schema !== 'model-access-catalog-v1')
        fail();
    if (root.environment !== 'test' && root.environment !== 'prod')
        fail();
    const sequence = integer(root.sequence, 1, Number.MAX_SAFE_INTEGER, fail);
    // The envelope sequence is what the server compares; a mismatch means a tampered body.
    if (sequence !== input.sequence)
        fail();
    if (input.appliedSequence !== undefined && sequence < input.appliedSequence)
        throw new ModelAccessCatalogError('catalog_stale');
    return sequence;
}
function catalogPackages(value, fail) {
    const packages = list(value, 64, fail).map((item) => catalogPackage(item, fail));
    if (packages.length === 0)
        fail();
    if (new Set(packages.map((item) => item.name)).size !== packages.length)
        fail();
    return packages;
}
function accessPolicyOf(value, fail) {
    const access = value === undefined ? {} : record(value, [], ['capabilities', 'sources'], fail);
    return {
        capabilityPolicy: access.capabilities === undefined
            ? Object.freeze({})
            : capabilityRules(access.capabilities, fail),
        sourcePolicy: sourcePolicyOf(access.sources, fail),
    };
}
function presentationOf(value, fail) {
    const presentation = value === undefined ? {} : record(value, [], ['providers', 'sources'], fail);
    const providers = presentationEntries(presentation.providers, fail);
    const sources = presentationEntries(presentation.sources, fail, true);
    if (Object.keys(providers).length + Object.keys(sources).length > 512)
        fail();
    return Object.freeze({ providers, sources });
}
/** Rejects an older sequence than the last applied one; equal re-applies are idempotent. */
export function parseModelAccessCatalog(catalogJson, input) {
    const fail = () => {
        throw new ModelAccessCatalogError('catalog_invalid');
    };
    const parsed = statement(catalogJson, fail);
    const v2 = parsed?.schema === 'model-access-catalog-v2';
    const keys = v2 ? CATALOG_V2_KEYS : CATALOG_V1_KEYS;
    const root = record(parsed, keys.required, keys.optional, fail);
    const sequence = catalogSequence(root, v2, input, fail);
    const packages = catalogPackages(root.packages, fail);
    const providerPolicy = providerRules(root.providerPolicy ?? {}, fail);
    const revokedDigests = list(root.revokedDigests, 1024, fail).map((item) => text(item, CONTENT_DIGEST, fail));
    const access = accessPolicyOf(root.accessPolicy, fail);
    const presentation = presentationOf(root.presentation, fail);
    const v2Fields = v2
        ? catalogV2Fields(root, new Set(packages.map((item) => item.name)), fail)
        : {};
    return Object.freeze({
        ...v2Fields,
        environment: root.environment,
        sequence,
        packages: Object.freeze(packages),
        providerPolicy: Object.freeze(providerPolicy),
        ...access,
        presentation,
        revokedDigests: Object.freeze([...new Set(revokedDigests)]),
    });
}
function attestationPlatforms(value, fail) {
    const platforms = list(value, 3, fail).map((item) => {
        if (typeof item !== 'string' || !PLATFORMS.has(item))
            fail();
        return item;
    });
    if (platforms.length === 0 || new Set(platforms).size !== platforms.length)
        fail();
    return platforms;
}
function attestationProviders(value, fail) {
    const providers = list(value, 256, fail).map((item) => {
        const provider = record(item, ['id', 'credentialSchema'], [], fail);
        return Object.freeze({
            id: text(provider.id, IDENTIFIER, fail),
            credentialSchema: integer(provider.credentialSchema, 0, Number.MAX_SAFE_INTEGER, fail),
        });
    });
    if (new Set(providers.map((item) => item.id)).size !== providers.length)
        fail();
    return providers;
}
/** Same identity and digests as the catalog entry, stored under its fixed object key. */
function attestationMatches(attestation, expected, dataOssKey) {
    const key = `model-access/v1/packages/${attestation.name}/${attestation.version}/${attestation.archiveSha256}.zip`;
    return (attestation.name === expected.name &&
        attestation.version === expected.version &&
        attestation.archiveSha256 === expected.archiveSha256 &&
        attestation.contentDigest === expected.contentDigest &&
        dataOssKey === key);
}
/** Attestation must describe exactly the catalog entry it is delivered for. */
export function parseModelAccessAttestation(attestationJson, expected) {
    const fail = () => {
        throw new ModelAccessCatalogError('attestation_invalid');
    };
    const root = record(statement(attestationJson, fail), [
        'schema',
        'name',
        'version',
        'sourceCommit',
        'archiveSha256',
        'contentDigest',
        'packageSizeBytes',
        'dataOssKey',
        'sdkRange',
        'minDesktopVersion',
        'platforms',
        'providers',
    ], [], fail);
    if (root.schema !== 'model-access-attestation-v1')
        fail();
    text(root.sourceCommit, GIT_COMMIT, fail);
    if (typeof root.dataOssKey !== 'string')
        fail();
    const platforms = attestationPlatforms(root.platforms, fail);
    const providers = attestationProviders(root.providers, fail);
    const attestation = Object.freeze({
        name: text(root.name, PACKAGE_NAME, fail),
        version: text(root.version, SEMVER, fail, 64),
        archiveSha256: text(root.archiveSha256, SHA256, fail),
        contentDigest: text(root.contentDigest, CONTENT_DIGEST, fail),
        packageSizeBytes: integer(root.packageSizeBytes, 1, MAX_PACKAGE_BYTES, fail),
        sdkRange: text(root.sdkRange, SDK_RANGE, fail),
        minDesktopVersion: text(root.minDesktopVersion, SEMVER, fail, 64),
        platforms: Object.freeze(platforms),
        providers: Object.freeze(providers),
    });
    if (!attestationMatches(attestation, expected, root.dataOssKey))
        fail();
    return attestation;
}
/**
 * True when the host can load a package declaring the "^N" range: the host's own major, or an
 * older major it still supports (SDK 2 hosts load schema-1 `^1` packages unchanged).
 */
export function modelAccessSdkCompatible(sdkRange, hostVersion) {
    const match = SEMVER.exec(hostVersion);
    if (!match || !SDK_RANGE.test(sdkRange))
        return false;
    const wanted = Number(sdkRange.slice(1));
    return (MODEL_ACCESS_SDK_MAJORS.includes(wanted) && wanted <= Number(match[1]));
}
//# sourceMappingURL=catalog.js.map