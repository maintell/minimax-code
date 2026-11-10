/** SDK majors this build understands (`engines.mcodeSdk` is `^<major>`). */
export const MODEL_ACCESS_SDK_MAJORS = [1, 2];
export class ModelAccessContractError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'ModelAccessContractError';
    }
}
const ID = /^[a-z][a-z0-9-]{0,63}$/u;
const RESERVED = new Set(['constructor', 'prototype', '__proto__']);
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9-]*$/u;
const LOGIN_KINDS = ['browser-pkce', 'device-code', 'secret-form', 'cli'];
const CREDENTIAL_KINDS = ['direct-owned', 'borrowed-current', 'public'];
const PLATFORMS = ['darwin', 'win32', 'linux'];
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
function invalid() {
    throw new ModelAccessContractError('invalid_manifest');
}
function record(value, allowed, required) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || !allowed.includes(key) || !('value' in descriptors[key]))
            invalid();
    }
    if (required.some((key) => !Object.hasOwn(value, key)))
        invalid();
    return value;
}
function text(value, pattern, max = 128) {
    if (typeof value !== 'string' || value.length > max || !pattern.test(value))
        invalid();
    return value;
}
function id(value) {
    const result = text(value, ID, 64);
    if (RESERVED.has(result))
        invalid();
    return result;
}
function array(value, parse, minimum = 1) {
    if (!Array.isArray(value) || value.length < minimum || value.length > 128)
        invalid();
    return Object.freeze(Array.from(value, parse));
}
function unique(values, key) {
    if (new Set(values.map(key)).size !== values.length)
        invalid();
    return values;
}
function enumValue(value, values) {
    if (typeof value !== 'string' || !values.includes(value))
        invalid();
    return value;
}
function integer(value) {
    if (!Number.isSafeInteger(value) || value < 1)
        invalid();
    return value;
}
/** Portable relative path. File existence, symlinks and content belong to the package loader. */
export function validateModelAccessEntry(value) {
    const entry = text(value, /^\.\/[A-Za-z0-9_./-]+\.mjs$/u, 256);
    const segments = entry.slice(2).split('/');
    if (segments.length > 16 ||
        segments.some((part) => !part || part === '.' || part === '..' || part.endsWith('.') || WINDOWS_RESERVED.test(part)))
        invalid();
    return entry;
}
function capabilityEntry(value) {
    const item = record(value, ['id', 'targets'], ['id', 'targets']);
    return Object.freeze({
        id: id(item.id),
        targets: unique(array(item.targets, id), (target) => target),
    });
}
function source(value) {
    const item = record(value, ['id', 'hostAgentId', 'capabilities'], ['id', 'hostAgentId', 'capabilities']);
    const caps = record(item.capabilities, ['login', 'subscriptionBorrow', 'apiKeyScan'], []);
    if (Object.keys(caps).length === 0)
        invalid();
    const capabilities = {};
    if (Object.hasOwn(caps, 'login')) {
        const login = record(caps.login, ['methods'], ['methods']);
        capabilities.login = Object.freeze({
            methods: unique(array(login.methods, (methodValue) => {
                const method = record(methodValue, ['id', 'kind', 'targets'], ['id', 'kind', 'targets']);
                return Object.freeze({
                    ...capabilityEntry({ id: method.id, targets: method.targets }),
                    kind: enumValue(method.kind, LOGIN_KINDS),
                });
            }), (method) => method.id),
        });
    }
    if (Object.hasOwn(caps, 'subscriptionBorrow')) {
        const borrow = record(caps.subscriptionBorrow, ['variants'], ['variants']);
        capabilities.subscriptionBorrow = Object.freeze({
            variants: unique(array(borrow.variants, capabilityEntry), (variant) => variant.id),
        });
    }
    if (Object.hasOwn(caps, 'apiKeyScan')) {
        const scan = record(caps.apiKeyScan, ['readers'], ['readers']);
        capabilities.apiKeyScan = Object.freeze({
            readers: unique(array(scan.readers, capabilityEntry), (reader) => reader.id),
        });
    }
    return Object.freeze({
        id: id(item.id),
        hostAgentId: id(item.hostAgentId),
        capabilities: Object.freeze(capabilities),
    });
}
function provider(value) {
    const item = record(value, ['id', 'credentialSchema', 'credentialKinds'], ['id', 'credentialSchema', 'credentialKinds']);
    const kinds = unique(array(item.credentialKinds, (kind) => enumValue(kind, CREDENTIAL_KINDS)), (kind) => kind);
    if (kinds.includes('public') && kinds.length !== 1)
        invalid();
    return Object.freeze({
        id: id(item.id),
        credentialSchema: integer(item.credentialSchema),
        credentialKinds: kinds,
    });
}
const DESKTOP_RANGE = /^>=(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/u;
const ASSET = /^\.\/[A-Za-z0-9_./-]+\.(?:png|jpe?g|webp)$/u;
function localized(value) {
    const item = record(value, ['en', 'zhHans'], ['en', 'zhHans']);
    const read = (entry) => {
        if (typeof entry !== 'string' ||
            !entry.trim() ||
            entry.length > 64 ||
            /[\u0000-\u001f]/u.test(entry))
            invalid();
        return entry;
    };
    return Object.freeze({ en: read(item.en), zhHans: read(item.zhHans) });
}
/** Package-relative image path; existence and content are checked by the package loader. */
export function validateModelAccessAsset(value) {
    const asset = text(value, ASSET, 256);
    const segments = asset.slice(2).split('/');
    if (segments.length > 8 ||
        segments.some((part) => !part || part === '.' || part === '..' || part.endsWith('.') || WINDOWS_RESERVED.test(part)))
        invalid();
    return asset;
}
function presentationEntry(value) {
    const item = record(value, ['displayName', 'icon', 'darkIcon'], []);
    return Object.freeze({
        ...(item.displayName === undefined ? {} : { displayName: localized(item.displayName) }),
        ...(item.icon === undefined ? {} : { icon: validateModelAccessAsset(item.icon) }),
        ...(item.darkIcon === undefined ? {} : { darkIcon: validateModelAccessAsset(item.darkIcon) }),
    });
}
function presentationMap(value, declared) {
    const keys = value && typeof value === 'object' ? Object.keys(value) : [];
    if (keys.length > 128)
        invalid();
    const item = record(value, keys, []);
    const result = Object.create(null);
    for (const key of keys) {
        // Presentation only names what the manifest declares.
        if (!declared.has(id(key)))
            invalid();
        result[key] = presentationEntry(item[key]);
    }
    return Object.freeze(result);
}
function presentation(value, providers, sources) {
    const item = record(value, ['providers', 'sources'], []);
    return Object.freeze({
        ...(item.providers === undefined
            ? {}
            : {
                providers: presentationMap(item.providers, new Set(providers.map((entry) => entry.id))),
            }),
        ...(item.sources === undefined
            ? {}
            : { sources: presentationMap(item.sources, new Set(sources.map((entry) => entry.id))) }),
    });
}
/** True when a host at `hostVersion` satisfies `>=x.y.z`. */
export function desktopVersionSatisfies(range, hostVersion) {
    const want = DESKTOP_RANGE.exec(range);
    const have = /^(\d+)\.(\d+)\.(\d+)/u.exec(hostVersion);
    if (!want || !have)
        return false;
    for (let index = 1; index <= 3; index++) {
        const difference = Number(have[index]) - Number(want[index]);
        if (difference !== 0)
            return difference > 0;
    }
    return true;
}
/** Pure, no imports or I/O. Returns a detached, frozen manifest suitable for preview. */
export function parseModelAccessManifest(value) {
    const required = [
        'schemaVersion',
        'name',
        'version',
        'entry',
        'engines',
        'trust',
        'platforms',
        'providers',
        'sources',
    ];
    const schema = value?.schemaVersion;
    const item = record(value, schema === 2 ? [...required, 'presentation'] : required, required);
    if ((item.schemaVersion !== 1 && item.schemaVersion !== 2) || item.trust !== 'native-code')
        invalid();
    const v2 = item.schemaVersion === 2;
    const engines = record(item.engines, v2 ? ['mcodeSdk', 'desktop'] : ['mcodeSdk'], ['mcodeSdk']);
    // Each schema pins its SDK major: schema 1 is ^1, schema 2 is ^2.
    if (engines.mcodeSdk !== (v2 ? '^2' : '^1'))
        throw new ModelAccessContractError('incompatible_sdk');
    if (engines.desktop !== undefined &&
        (typeof engines.desktop !== 'string' || !DESKTOP_RANGE.test(engines.desktop)))
        invalid();
    const providers = unique(array(item.providers, provider, 0), (entry) => entry.id);
    const sources = unique(array(item.sources, source, 0), (entry) => entry.id);
    if (providers.length + sources.length === 0)
        invalid();
    return Object.freeze({
        schemaVersion: v2 ? 2 : 1,
        name: text(item.name, PACKAGE_NAME),
        version: text(item.version, VERSION, 64),
        entry: validateModelAccessEntry(item.entry),
        engines: Object.freeze({
            mcodeSdk: v2 ? '^2' : '^1',
            ...(engines.desktop === undefined ? {} : { desktop: engines.desktop }),
        }),
        trust: 'native-code',
        platforms: unique(array(item.platforms, (platform) => enumValue(platform, PLATFORMS)), (platform) => platform),
        providers,
        sources,
        ...(v2 && item.presentation !== undefined
            ? { presentation: presentation(item.presentation, providers, sources) }
            : {}),
    });
}
//# sourceMappingURL=manifest.js.map