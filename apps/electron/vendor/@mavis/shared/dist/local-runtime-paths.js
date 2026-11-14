import path from 'node:path';
import { BUNNY_AGENT_NAME } from './agent-avatar.js';
/** Home directory of the built-in Bunny Agent inside a profile data directory. */
export function resolveBunnyHomeDir(dataDir) {
    return path.join(resolveDataDir(dataDir), BUNNY_AGENT_NAME);
}
/** Bunny 独立 SQLite 相对 profile data directory 的路径段。 */
export const BUNNY_DATABASE_RELATIVE_PATH = path.join(BUNNY_AGENT_NAME, 'data', 'bunny.sqlite');
/** Bunny 独立 SQLite：`<dataDir>/bunny/data/bunny.sqlite`，与桌面端大库分开。 */
export function resolveBunnyDatabasePath(dataDir) {
    return path.join(resolveDataDir(dataDir), BUNNY_DATABASE_RELATIVE_PATH);
}
export function resolveV2Root(dataDir) {
    return path.join(resolveDataDir(dataDir), 'v2');
}
export function resolveV2DirectoryContract(dataDir) {
    const root = resolveV2Root(dataDir);
    const sessions = path.join(root, 'sessions');
    const sqlite = path.join(root, 'sqlite');
    const runtimeStateDb = path.join(sqlite, 'runtime-state.sqlite');
    const sessionIndexDb = path.join(sqlite, 'session-index.sqlite');
    const usageStateDb = path.join(sqlite, 'usage-state.sqlite');
    const legacyImportDb = path.join(sqlite, 'legacy-import.sqlite');
    const legacyDraftChats = path.join(root, 'chats');
    const observability = path.join(root, 'observability');
    const migration = path.join(root, 'migration');
    return {
        root,
        sessions,
        sqlite,
        runtimeStateDb,
        sessionIndexDb,
        usageStateDb,
        legacyImportDb,
        chats: legacyDraftChats,
        db: runtimeStateDb,
        ledgers: path.join(legacyDraftChats, 'ledgers'),
        snapshots: path.join(legacyDraftChats, 'snapshots'),
        legacyDraftChats,
        legacyDraftDb: path.join(legacyDraftChats, 'local-runtime.sqlite'),
        legacyDraftLedgers: path.join(legacyDraftChats, 'ledgers'),
        legacyDraftSnapshots: path.join(legacyDraftChats, 'snapshots'),
        officialPluginCache: path.join(root, 'plugin-cache', 'official'),
        assets: path.join(root, 'assets'),
        workspaces: path.join(root, 'workspaces'),
        observability,
        logs: path.join(observability, 'logs'),
        events: path.join(observability, 'events'),
        diagnostics: path.join(observability, 'diagnostics'),
        migration,
        migrationManifests: path.join(migration, 'manifests'),
        migrationBackups: path.join(migration, 'backups'),
    };
}
export function resolveV2DatedDir(root, epochMs) {
    const stamp = formatV2TimestampParts(epochMs);
    return path.join(root, stamp.year, stamp.month, stamp.day);
}
export function resolveV2AssetDir(dataDir, epochMs) {
    return resolveV2DatedDir(resolveV2DirectoryContract(dataDir).assets, epochMs);
}
export function resolveV2EventDir(dataDir, epochMs) {
    return resolveV2DatedDir(resolveV2DirectoryContract(dataDir).events, epochMs);
}
export function resolveV2DiagnosticDir(dataDir, epochMs) {
    return resolveV2DatedDir(resolveV2DirectoryContract(dataDir).diagnostics, epochMs);
}
export function resolveV2MigrationManifestDir(dataDir, epochMs) {
    return resolveV2DatedDir(resolveV2DirectoryContract(dataDir).migrationManifests, epochMs);
}
export function resolveV2MigrationBackupDir(dataDir, epochMs) {
    return resolveV2DatedDir(resolveV2DirectoryContract(dataDir).migrationBackups, epochMs);
}
export function formatV2TimestampParts(epochMs) {
    const d = new Date(epochMs);
    const year = d.getFullYear().toString().padStart(4, '0');
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const day = d.getDate().toString().padStart(2, '0');
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    const ss = d.getSeconds().toString().padStart(2, '0');
    const ms = d.getMilliseconds().toString().padStart(3, '0');
    return {
        year,
        month,
        day,
        date: `${year}-${month}-${day}`,
        time: `${hh}-${mm}-${ss}-${ms}`,
        compact: `${year}${month}${day}-${hh}${mm}${ss}-${ms}`,
    };
}
const MAX_V2_PATH_SEGMENT_CHARS = 180;
export function sanitizeV2PathSegment(value, fallback = 'item') {
    const trimmed = value.trim();
    const cleaned = trimmed
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/^\.+/g, '')
        .replace(/^\.+$/g, '')
        .trim();
    const sanitized = truncatePathSegmentPreservingExtension(cleaned, MAX_V2_PATH_SEGMENT_CHARS);
    return sanitized || fallback;
}
function truncatePathSegmentPreservingExtension(value, maxChars) {
    if (value.length <= maxChars)
        return value;
    const extMatch = /^(.+?)(\.[A-Za-z0-9]{1,16})$/u.exec(value);
    const rawStem = extMatch?.[1];
    const ext = extMatch?.[2];
    if (rawStem && ext) {
        const stemBudget = maxChars - ext.length;
        if (stemBudget > 0) {
            const stem = rawStem.slice(0, stemBudget).trim();
            if (stem)
                return `${stem}${ext}`;
        }
    }
    return value.slice(0, maxChars).trim();
}
export function isPathInside(parent, child) {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return (relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative)));
}
function resolveDataDir(dataDir) {
    return typeof dataDir === 'function' ? dataDir() : dataDir;
}
//# sourceMappingURL=local-runtime-paths.js.map