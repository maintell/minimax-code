import path from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { parseMiniAppPermissionId, } from '@mavis/shared/miniapp-surface';
import { PluginInstallationPolicy, } from '@mavis/thrift-gen/generated/desktop-service/types';
import { pluginDisabledLocalRoots, pluginMiniAppPermissions, pluginOfficialStates, } from '../../../../infra/db/schema/plugin.js';
const CONTENT_DIGEST = /^sha256-tree-v1:[0-9a-f]{64}$/u;
const ARCHIVE_DIGEST = /^[0-9a-f]{64}$/u;
const CACHE_KEY = /^sha256-tree-v1-[0-9a-f]{64}$/u;
export function effectiveInstallationPolicy(installation) {
    return installation.installationPolicy === PluginInstallationPolicy.DEFAULT_INSTALLED_UNREMOVABLE
        ? PluginInstallationPolicy.DEFAULT_INSTALLED_UNREMOVABLE
        : PluginInstallationPolicy.USER_MANAGED;
}
class PluginRepositoryError extends Error {
    code;
    detail;
    constructor(code, detail) {
        super(`${code}: ${detail}`);
        this.code = code;
        this.detail = detail;
        this.name = 'PluginRepositoryError';
    }
}
export class SqlitePluginRepository {
    db;
    nowMs;
    /**
     * Disabled Mini App permissions per `source\0pluginId`, filled on first read. Gateways read
     * them at every call; this repository is the table's only writer, so writes keep it exact.
     */
    disabledMiniAppPermissions = new Map();
    constructor(db, nowMs = Date.now) {
        this.db = db;
        this.nowMs = nowMs;
    }
    loadOfficialState(scope) {
        assertScope(scope);
        const row = this.db
            .select({ stateJson: pluginOfficialStates.stateJson })
            .from(pluginOfficialStates)
            .where(and(eq(pluginOfficialStates.principalId, scope.principalId), eq(pluginOfficialStates.deployment, scope.deployment)))
            .get();
        if (!row)
            return undefined;
        if (typeof row.stateJson !== 'string') {
            fail('STATE_CORRUPT', 'official Plugin state row has no JSON payload');
        }
        let parsed;
        try {
            parsed = JSON.parse(row.stateJson);
        }
        catch {
            fail('STATE_CORRUPT', 'official Plugin state JSON cannot be parsed');
        }
        assertOfficialState(parsed);
        return parsed;
    }
    saveOfficialState(scope, state) {
        assertScope(scope);
        assertOfficialState(state);
        const stateJson = JSON.stringify(state);
        const updatedAtMs = this.nowMs();
        this.db
            .insert(pluginOfficialStates)
            .values({
            principalId: scope.principalId,
            deployment: scope.deployment,
            stateJson,
            updatedAtMs,
        })
            .onConflictDoUpdate({
            target: [pluginOfficialStates.principalId, pluginOfficialStates.deployment],
            set: { stateJson, updatedAtMs },
        })
            .run();
    }
    deleteOfficialState(scope) {
        assertScope(scope);
        this.db
            .delete(pluginOfficialStates)
            .where(and(eq(pluginOfficialStates.principalId, scope.principalId), eq(pluginOfficialStates.deployment, scope.deployment)))
            .run();
    }
    listReferencedOfficialCacheKeys() {
        const keys = new Set();
        const rows = this.db
            .select({ stateJson: pluginOfficialStates.stateJson })
            .from(pluginOfficialStates)
            .all();
        for (const row of rows) {
            if (typeof row.stateJson !== 'string') {
                fail('STATE_CORRUPT', 'official Plugin state row has no JSON payload');
            }
            let parsed;
            try {
                parsed = JSON.parse(row.stateJson);
            }
            catch {
                fail('STATE_CORRUPT', 'official Plugin state JSON cannot be parsed');
            }
            assertOfficialState(parsed);
            for (const installation of parsed.installations) {
                for (const cached of installation.cachedPackages)
                    keys.add(cached.cacheKey);
            }
        }
        return keys;
    }
    isLocalPluginEnabled(canonicalRoot) {
        const identity = assertCanonicalRoot(canonicalRoot);
        const row = this.db
            .select({ canonicalRoot: pluginDisabledLocalRoots.canonicalRoot })
            .from(pluginDisabledLocalRoots)
            .where(eq(pluginDisabledLocalRoots.canonicalRoot, identity))
            .get();
        return row === undefined;
    }
    setLocalPluginEnabled(canonicalRoot, enabled) {
        const identity = assertCanonicalRoot(canonicalRoot);
        if (enabled) {
            this.db
                .delete(pluginDisabledLocalRoots)
                .where(eq(pluginDisabledLocalRoots.canonicalRoot, identity))
                .run();
            return;
        }
        const updatedAtMs = this.nowMs();
        this.db
            .insert(pluginDisabledLocalRoots)
            .values({ canonicalRoot: identity, updatedAtMs })
            .onConflictDoUpdate({
            target: pluginDisabledLocalRoots.canonicalRoot,
            set: { updatedAtMs },
        })
            .run();
    }
    listDisabledLocalPluginRoots() {
        return this.db
            .select({ canonicalRoot: pluginDisabledLocalRoots.canonicalRoot })
            .from(pluginDisabledLocalRoots)
            .orderBy(asc(pluginDisabledLocalRoots.canonicalRoot))
            .all()
            .map((row) => {
            if (typeof row.canonicalRoot !== 'string') {
                fail('STATE_CORRUPT', 'local disabled Plugin row has an invalid identity');
            }
            return row.canonicalRoot;
        });
    }
    pruneMissingLocalPlugins(existingCanonicalRoots) {
        const existing = new Set([...existingCanonicalRoots].map((root) => assertCanonicalRoot(root)));
        for (const disabledRoot of this.listDisabledLocalPluginRoots()) {
            if (!existing.has(disabledRoot)) {
                this.db
                    .delete(pluginDisabledLocalRoots)
                    .where(eq(pluginDisabledLocalRoots.canonicalRoot, disabledRoot))
                    .run();
            }
        }
    }
    listDisabledMiniAppPermissions(pluginName, source) {
        return new Set(this.disabledMiniAppPermissionSet(assertPermissionPluginId(pluginName), source));
    }
    /** Only a disabled permission keeps a row; enabling one restores the declared default. */
    setMiniAppPermissionEnabled(pluginName, source, permission, enabled) {
        const pluginId = assertPermissionPluginId(pluginName);
        if (!parseMiniAppPermissionId(permission)) {
            fail('MINIAPP_PERMISSION_IDENTITY_INVALID', 'Mini App permission is invalid');
        }
        const disabled = this.disabledMiniAppPermissionSet(pluginId, source);
        const identity = and(eq(pluginMiniAppPermissions.pluginId, pluginId), eq(pluginMiniAppPermissions.pluginSource, source), eq(pluginMiniAppPermissions.permission, permission));
        if (enabled) {
            this.db.delete(pluginMiniAppPermissions).where(identity).run();
            disabled.delete(permission);
            return;
        }
        const updatedAtMs = this.nowMs();
        this.db
            .insert(pluginMiniAppPermissions)
            .values({ pluginId, pluginSource: source, permission, enabled: 0, updatedAtMs })
            .onConflictDoUpdate({
            target: [
                pluginMiniAppPermissions.pluginId,
                pluginMiniAppPermissions.pluginSource,
                pluginMiniAppPermissions.permission,
            ],
            set: { enabled: 0, updatedAtMs },
        })
            .run();
        disabled.add(permission);
    }
    deleteMiniAppPermissions(pluginName, source) {
        const pluginId = assertPermissionPluginId(pluginName);
        this.db
            .delete(pluginMiniAppPermissions)
            .where(and(eq(pluginMiniAppPermissions.pluginId, pluginId), eq(pluginMiniAppPermissions.pluginSource, source)))
            .run();
        this.disabledMiniAppPermissions.delete(miniAppPermissionKey(pluginId, source));
    }
    /** Local plugin ids with stored switches; official ones are kept across accounts and reinstalls. */
    listLocalMiniAppPermissionOwners() {
        return this.db
            .selectDistinct({ pluginId: pluginMiniAppPermissions.pluginId })
            .from(pluginMiniAppPermissions)
            .where(eq(pluginMiniAppPermissions.pluginSource, 'local'))
            .orderBy(asc(pluginMiniAppPermissions.pluginId))
            .all()
            .map(({ pluginId }) => pluginId);
    }
    disabledMiniAppPermissionSet(pluginId, source) {
        const key = miniAppPermissionKey(pluginId, source);
        let disabled = this.disabledMiniAppPermissions.get(key);
        if (!disabled) {
            const rows = this.db
                .select({ permission: pluginMiniAppPermissions.permission })
                .from(pluginMiniAppPermissions)
                .where(and(eq(pluginMiniAppPermissions.pluginId, pluginId), eq(pluginMiniAppPermissions.pluginSource, source), eq(pluginMiniAppPermissions.enabled, 0)))
                .all();
            disabled = new Set(rows.map(({ permission }) => permission));
            this.disabledMiniAppPermissions.set(key, disabled);
        }
        return disabled;
    }
}
function assertScope(scope) {
    if (!scope.principalId.trim() || !scope.deployment.trim()) {
        fail('SCOPE_INVALID', 'principal and deployment are required');
    }
}
function assertOfficialState(value) {
    if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.installations)) {
        fail('STATE_CORRUPT', 'official Plugin state has an unsupported schema');
    }
    const installationNames = new Set();
    for (const installation of value.installations) {
        assertInstallation(installation, installationNames);
    }
    if (value.lastSuccessfulFullState !== undefined && !isJsonValue(value.lastSuccessfulFullState)) {
        fail('STATE_CORRUPT', 'last successful full-state is not JSON');
    }
    if (value.currentSnapshot !== undefined)
        assertSnapshot(value.currentSnapshot);
}
function assertInstallation(value, installationNames) {
    if (!isRecord(value) ||
        !isNonEmptyString(value.name) ||
        typeof value.installed !== 'boolean' ||
        typeof value.enabled !== 'boolean' ||
        !Array.isArray(value.cachedPackages)) {
        fail('STATE_CORRUPT', 'official Plugin installation record is invalid');
    }
    if (installationNames.has(value.name)) {
        fail('STATE_CORRUPT', 'official Plugin installation names are duplicated');
    }
    if (value.enabled && !value.installed) {
        fail('STATE_CORRUPT', 'an uninstalled official Plugin cannot be enabled');
    }
    assertInstallationPolicy(value.installationPolicy);
    assertCurrentPackage(value.package, value.name);
    installationNames.add(value.name);
    assertCachedPackages(value.name, value.cachedPackages);
}
function assertInstallationPolicy(value) {
    if (value === undefined ||
        value === 0 ||
        value === PluginInstallationPolicy.USER_MANAGED ||
        value === PluginInstallationPolicy.DEFAULT_INSTALLED_UNREMOVABLE) {
        return;
    }
    fail('STATE_CORRUPT', 'official Plugin installation policy is invalid');
}
function assertCurrentPackage(value, installationName) {
    if (value === undefined)
        return;
    assertPackageIdentity(value);
    if (value.name !== installationName) {
        fail('STATE_CORRUPT', 'current Plugin package belongs to another installation');
    }
}
function assertPackageIdentity(value) {
    if (!isRecord(value) ||
        !isNonEmptyString(value.name) ||
        !isNonEmptyString(value.version) ||
        typeof value.archiveSha256 !== 'string' ||
        !ARCHIVE_DIGEST.test(value.archiveSha256) ||
        typeof value.contentDigest !== 'string' ||
        !CONTENT_DIGEST.test(value.contentDigest)) {
        fail('STATE_CORRUPT', 'current Plugin package identity is invalid');
    }
}
function assertCachedPackages(installationName, values) {
    const cachedIdentities = new Set();
    for (const cached of values) {
        assertCachedPackage(cached);
        if (cached.name !== installationName) {
            fail('STATE_CORRUPT', 'cached Plugin package belongs to another installation');
        }
        const identity = `${cached.version}\0${cached.archiveSha256}\0${cached.contentDigest}`;
        if (cachedIdentities.has(identity)) {
            fail('STATE_CORRUPT', 'cached Plugin package identities are duplicated');
        }
        cachedIdentities.add(identity);
    }
}
function assertCachedPackage(value) {
    if (!isRecord(value) || !hasValidCachedPackageFields(value)) {
        fail('STATE_CORRUPT', 'cached Plugin package identity is invalid');
    }
}
function hasValidCachedPackageFields(value) {
    if (!isNonEmptyString(value.name) || !isNonEmptyString(value.version))
        return false;
    if (typeof value.archiveSha256 !== 'string' || !ARCHIVE_DIGEST.test(value.archiveSha256)) {
        return false;
    }
    if (typeof value.contentDigest !== 'string' || !CONTENT_DIGEST.test(value.contentDigest)) {
        return false;
    }
    return (typeof value.cacheKey === 'string' &&
        CACHE_KEY.test(value.cacheKey) &&
        value.cacheKey === value.contentDigest.replace(':', '-'));
}
function isNonEmptyString(value) {
    return typeof value === 'string' && Boolean(value.trim());
}
function assertSnapshot(value) {
    if (!isRecord(value) ||
        typeof value.revision !== 'string' ||
        !value.revision.trim() ||
        !Number.isInteger(value.publishedAtMs) ||
        value.publishedAtMs < 0 ||
        !Array.isArray(value.packageContentDigests) ||
        value.packageContentDigests.some((digest) => typeof digest !== 'string' || !CONTENT_DIGEST.test(digest))) {
        fail('STATE_CORRUPT', 'published Plugin snapshot metadata is invalid');
    }
}
function miniAppPermissionKey(pluginId, source) {
    return `${source}\0${pluginId}`;
}
function assertPermissionPluginId(value) {
    if (!value.trim() || value.length > 256) {
        fail('MINIAPP_PERMISSION_IDENTITY_INVALID', 'Mini App permission owner is invalid');
    }
    return value;
}
function assertCanonicalRoot(value) {
    if (!path.isAbsolute(value))
        fail('LOCAL_IDENTITY_INVALID', 'local Plugin root must be absolute');
    return path.normalize(value);
}
function isJsonValue(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return true;
    }
    if (typeof value === 'number')
        return Number.isFinite(value);
    if (Array.isArray(value))
        return value.every(isJsonValue);
    return isRecord(value) && Object.values(value).every(isJsonValue);
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fail(code, detail) {
    throw new PluginRepositoryError(code, detail);
}
//# sourceMappingURL=repository.js.map