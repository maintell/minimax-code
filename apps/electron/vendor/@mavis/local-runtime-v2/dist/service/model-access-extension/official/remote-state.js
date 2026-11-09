import { createHash } from 'node:crypto';
import { parseModelAccessAttestation, parseModelAccessCatalog, remoteEntryKey, } from './catalog.js';
const LOCAL_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const CONTENT_DIGEST = /^sha256-tree-v1:[0-9a-f]{64}$/u;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const LANE = /^[A-Za-z0-9._-]{1,128}$/u;
/** state.json is capped at 1 MiB; the stored catalog must leave room for everything else. */
export const MAX_STORED_CATALOG_BYTES = 512 * 1024;
export const EMPTY_REMOTE_DELIVERY = Object.freeze({
    schemaVersion: 1,
    digests: Object.freeze([]),
    revokedDigests: Object.freeze([]),
});
function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function optionalTime(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
export function catalogTextDigest(text) {
    return createHash('sha256').update(text).digest('hex');
}
function storedLane(value) {
    return typeof value === 'string' && LANE.test(value) ? { lane: value } : {};
}
function storedDigests(value) {
    if (!Array.isArray(value))
        return [];
    return value
        .filter((item) => isRecord(item) &&
        typeof item.contentDigest === 'string' &&
        CONTENT_DIGEST.test(item.contentDigest) &&
        typeof item.localDigest === 'string' &&
        LOCAL_DIGEST.test(item.localDigest))
        .slice(0, 512)
        .map((item) => ({
        contentDigest: item.contentDigest,
        localDigest: item.localDigest,
        origin: item.origin === 'remote' ? 'remote' : 'local',
    }));
}
/** Distinct strings `keep` accepts, at most `limit`; anything else stored is dropped. */
function uniqueStrings(value, keep, limit) {
    if (!Array.isArray(value))
        return [];
    const items = value.filter((item) => typeof item === 'string' && keep(item));
    return [...new Set(items)].slice(0, limit);
}
/**
 * Lenient where safe (unknown/invalid bookkeeping is dropped), strict where it matters: a stored
 * catalog is only kept when it still parses and matches its digest. A corrupt section never
 * blocks the package state; the next successful sync rewrites it.
 */
export function parseRemoteDeliveryState(value) {
    if (value === undefined)
        return undefined;
    if (!isRecord(value) || value.schemaVersion !== 1)
        return undefined;
    const digests = storedDigests(value.digests);
    const revocationDisabled = uniqueStrings(value.revocationDisabled, (item) => item.length <= 128, 128);
    const revokedDigests = uniqueStrings(value.revokedDigests, (item) => CONTENT_DIGEST.test(item), 4096);
    const catalog = storedCatalog(value);
    return {
        schemaVersion: 1,
        ...(typeof value.optIn === 'boolean' ? { optIn: value.optIn } : {}),
        ...storedLane(value.lane),
        ...(value.serviceDisabled === true ? { serviceDisabled: true } : {}),
        ...catalog,
        digests,
        revokedDigests,
        ...(revocationDisabled.length ? { revocationDisabled } : {}),
        ...storedSyncTimes(value),
    };
}
/** Last success, last error and next retry, each kept only when valid. */
function storedSyncTimes(value) {
    const lastSuccessAt = optionalTime(value.lastSuccessAt);
    const nextRetryAt = optionalTime(value.nextRetryAt);
    return {
        ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
        ...(typeof value.lastErrorCode === 'string' && ERROR_CODE.test(value.lastErrorCode)
            ? { lastErrorCode: value.lastErrorCode }
            : {}),
        ...(nextRetryAt !== undefined ? { nextRetryAt } : {}),
    };
}
/** Shallow on purpose: readCurrent() runs per model resolve; the policy verifies and parses once. */
function storedCatalog(value) {
    const { catalogJson, sequence, catalogDigest, environment } = value;
    if (typeof catalogJson !== 'string' ||
        catalogJson.length > MAX_STORED_CATALOG_BYTES ||
        !Number.isSafeInteger(sequence) ||
        sequence < 1 ||
        typeof catalogDigest !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(catalogDigest) ||
        (environment !== 'test' && environment !== 'prod'))
        return {};
    const attestations = Array.isArray(value.attestations)
        ? value.attestations
            .filter((item) => isRecord(item) &&
            typeof item.name === 'string' &&
            typeof item.version === 'string' &&
            typeof item.attestationJson === 'string')
            .slice(0, 64)
            .map(({ name, version, attestationJson }) => ({ name, version, attestationJson }))
        : [];
    return {
        environment,
        sequence: sequence,
        catalogDigest,
        catalogJson,
        attestations,
    };
}
/** Mutable owner of the effective remote rules; exposes RemotePolicy to every consumer. */
export class ModelAccessRemotePolicy {
    active = false;
    disabledByServer = false;
    current;
    loadedDigest;
    revoked = new Set();
    revokedLocalDigests = new Set();
    revision = 0;
    listeners = new Set();
    installationOrigin = () => true;
    installationName = () => undefined;
    enabled() {
        return this.active;
    }
    /** The package service tells which installations are official (catalog rules apply). */
    setOfficialResolver(resolver, name) {
        this.installationOrigin = resolver;
        if (name)
            this.installationName = name;
    }
    /** Catalog v2 rules for the package an installation belongs to. */
    packageRules(installationId) {
        const name = this.installationName(installationId);
        return name ? this.catalog()?.packagePolicy?.[name] : undefined;
    }
    /** Catalog v2: a user/dev package stopped remotely by exact local digest or package name. */
    userPackageRevoked(name, localDigest) {
        const user = this.catalog()?.userPackages;
        if (!user)
            return false;
        return (user.revokedNames.includes(name) ||
            (!!localDigest && user.revokedDigests.includes(localDigest)));
    }
    /** Catalog provider/source rules never govern a user or dev package with the same ids. */
    officialInstallation(installationId) {
        return this.installationOrigin(installationId);
    }
    /** providerBlock scoped to one installation: v2 package rules first, then v1 global rules. */
    providerBlockFor(installationId, providerId) {
        if (!this.officialInstallation(installationId))
            return undefined;
        return (this.packageRules(installationId)?.providerPolicy[providerId] ??
            this.providerBlock(providerId));
    }
    /** capabilityBlock scoped to one installation: a v2 package source rule wins. */
    capabilityBlockFor(installationId, capability, sourceId, entry) {
        if (!this.officialInstallation(installationId))
            return undefined;
        const scoped = this.packageRules(installationId)?.sourcePolicy[sourceId];
        if (scoped) {
            const names = capability === 'apiKeyScan' ? ['apiKeyScan'] : [capability, 'subscriptions'];
            if (entry) {
                const entryKey = remoteEntryKey(capability, entry.entryId, entry.target);
                const rule = scoped.entries?.[entryKey];
                if (rule)
                    return { ...rule, scope: { kind: 'entry', sourceId, entryKey } };
            }
            for (const name of names) {
                const rule = scoped[name];
                if (rule)
                    return { ...rule, scope: { kind: 'source', sourceId, capability: name } };
            }
        }
        return this.capabilityBlock(capability, sourceId, entry);
    }
    /** Model access master switch is off: nothing is shown, admitted or run. */
    serviceDisabled() {
        return this.active && this.disabledByServer;
    }
    catalog() {
        return this.active ? this.current : undefined;
    }
    version() {
        return this.revision;
    }
    /** Rebuild from persisted state. Returns true when the effective rules changed. */
    load(state, enabled) {
        const before = this.fingerprint();
        this.active = enabled;
        this.disabledByServer = state?.serviceDisabled === true;
        if (state?.catalogDigest !== this.loadedDigest) {
            this.loadedDigest = state?.catalogDigest;
            this.current = verifiedCatalog(state);
        }
        this.revoked = new Set([
            ...(state?.revokedDigests ?? []),
            ...(this.current?.revokedDigests ?? []),
        ]);
        this.revokedLocalDigests = new Set((state?.digests ?? [])
            .filter((item) => this.revoked.has(item.contentDigest))
            .map((item) => item.localDigest));
        const changed = before !== this.fingerprint();
        if (changed) {
            this.revision += 1;
            for (const listener of [...this.listeners])
                listener();
        }
        return changed;
    }
    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    revokedContent(contentDigest) {
        return this.active && this.revoked.has(contentDigest);
    }
    revokedLocal(localDigest) {
        return this.active && this.revokedLocalDigests.has(localDigest);
    }
    providerBlock(providerId) {
        return this.catalog()?.providerPolicy[providerId];
    }
    capabilityBlock(capability, sourceId, entry) {
        const catalog = this.catalog();
        if (!catalog)
            return undefined;
        const names = capability === 'apiKeyScan' ? ['apiKeyScan'] : [capability, 'subscriptions'];
        const source = catalog.sourcePolicy[sourceId];
        if (entry) {
            const entryKey = remoteEntryKey(capability, entry.entryId, entry.target);
            const rule = source?.entries?.[entryKey];
            if (rule)
                return { ...rule, scope: { kind: 'entry', sourceId, entryKey } };
        }
        for (const name of names) {
            const rule = source?.[name];
            if (rule)
                return { ...rule, scope: { kind: 'source', sourceId, capability: name } };
        }
        for (const name of names) {
            const rule = catalog.capabilityPolicy[name];
            if (rule)
                return { ...rule, scope: { kind: 'capability', capability: name } };
        }
        return undefined;
    }
    /** Whole-capability switch for UI totals ("智能体订阅"), independent of any source. */
    globalBlock(capability) {
        return this.catalog()?.capabilityPolicy[capability];
    }
    fingerprint() {
        if (!this.active)
            return 'off';
        if (this.disabledByServer)
            return 'service-disabled';
        const catalog = this.current;
        return JSON.stringify([
            catalog?.sequence,
            catalog?.providerPolicy,
            catalog?.capabilityPolicy,
            catalog?.sourcePolicy,
            catalog?.packagePolicy,
            catalog?.userPackages,
            [...this.revokedLocalDigests].sort(),
        ]);
    }
}
/** A stored catalog counts only when it still matches its digest and parses strictly. */
function verifiedCatalog(state) {
    if (!state?.catalogJson || state.sequence === undefined || !state.catalogDigest)
        return undefined;
    if (catalogTextDigest(state.catalogJson) !== state.catalogDigest)
        return undefined;
    try {
        return parseModelAccessCatalog(state.catalogJson, { sequence: state.sequence });
    }
    catch {
        return undefined;
    }
}
/** Attestations are re-validated on every use against the catalog entry they belong to. */
export function storedAttestationFor(state, entry) {
    const stored = state.attestations?.find((item) => item.name === entry.name && item.version === entry.version);
    if (!stored)
        return undefined;
    try {
        return parseModelAccessAttestation(stored.attestationJson, entry);
    }
    catch {
        return undefined;
    }
}
/**
 * Whether a local snapshot is revoked by the active remote rules. Official packages are revoked by
 * content (sha256-tree-v1, computed once for snapshots without a persisted mapping); user and dev
 * packages only by local digest or package name (catalog v2).
 */
export class ModelAccessRevocationCheck {
    host;
    /** localDigest -> sha256-tree-v1. */
    computed = new Map();
    constructor(host) {
        this.host = host;
    }
    async revoked(localDigest, directory, installationId) {
        const policy = this.host.policy;
        if (!policy.enabled())
            return false;
        if (installationId && !this.host.official(installationId))
            return policy.userPackageRevoked(this.host.nameOf(installationId) ?? '', localDigest);
        if (policy.revokedLocal(localDigest))
            return true;
        const content = await this.contentDigest(localDigest, directory);
        return !!content && policy.revokedContent(content);
    }
    /** The portable content digest of a snapshot; undefined for a development import. */
    async contentDigest(localDigest, directory) {
        const known = this.host.delivery().digests.find((item) => item.localDigest === localDigest)
            ?.contentDigest ?? this.computed.get(localDigest);
        const treeDigest = this.host.treeDigest();
        if (known || !treeDigest)
            return known;
        try {
            const content = await treeDigest(directory
                ? await this.host.realpath(directory)
                : await this.host.snapshotDirectory(localDigest));
            this.computed.set(localDigest, content);
            return content;
        }
        catch {
            // Not a portable package (development import): it can never be a remote version.
            return undefined;
        }
    }
}
//# sourceMappingURL=remote-state.js.map