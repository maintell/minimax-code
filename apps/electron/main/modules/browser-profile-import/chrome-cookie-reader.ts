import { mkdtemp, lstat, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { decryptMacChromeCookie, decryptWindowsChromeCookie, normalizeChromeCookie } from "./chrome-cookie";
import { MacSafeStorageAccessError, readMacChromeSafeStoragePassword, readWindowsChromeMasterKey, windowsDpapiUnprotect } from "./platform-crypto";
import { BrowserProfileImportFailure } from "./errors";
const requireForMain = createRequire(__filename);
const MAX_COOKIE_ROWS = 20000;
class CookieDatabaseDiagnosticError extends Error {
    constructor(stage, reason) {
        super('Chrome Cookie database is unavailable');
        this.stage = stage;
        this.reason = reason;
        this.name = 'CookieDatabaseDiagnosticError';
    }
}
function macSafeStorageErrorCode(error) {
    switch (error.reason) {
        case 'denied':
            return 'keychain_access_denied';
        case 'timeout':
            return 'keychain_access_timeout';
        case 'not_found':
            return 'keychain_item_not_found';
        case 'unavailable':
        default:
            return 'decryption_failed';
    }
}
function secretFailureReason(error) {
    if (error instanceof MacSafeStorageAccessError)
        return error.reason;
    if (error instanceof Error && error.message.includes('master key'))
        return 'invalid_key';
    return 'unavailable';
}
function errorField(error, field) {
    if (typeof error !== 'object' || error === null)
        return undefined;
    try {
        return Reflect.get(error, field);
    }
    catch {
        return undefined;
    }
}
export function classifyCookieDatabaseFailureReason(error) {
    const code = errorField(error, 'code');
    if (typeof code === 'string') {
        switch (code) {
            case 'ENOENT':
            case 'ENOTDIR':
                return 'not_found';
            case 'EACCES':
            case 'EPERM':
            case 'SQLITE_PERM':
                return 'access_denied';
            case 'EBUSY':
            case 'SQLITE_BUSY':
                return 'busy';
            case 'SQLITE_LOCKED':
                return 'locked';
            case 'SQLITE_CORRUPT':
                return 'corrupt';
            case 'SQLITE_NOTADB':
                return 'not_a_database';
            case 'SQLITE_CANTOPEN':
                return 'cannot_open';
            case 'SQLITE_IOERR':
                return 'io_error';
            case 'SQLITE_READONLY':
                return 'read_only';
        }
    }
    const errcode = errorField(error, 'errcode');
    if (typeof errcode === 'number' && Number.isInteger(errcode)) {
        switch (errcode & 0xff) {
            case 1:
                return 'sqlite_error';
            case 3:
                return 'access_denied';
            case 5:
                return 'busy';
            case 6:
                return 'locked';
            case 8:
                return 'read_only';
            case 10:
                return 'io_error';
            case 11:
                return 'corrupt';
            case 14:
                return 'cannot_open';
            case 26:
                return 'not_a_database';
        }
    }
    if (code === 'ERR_SQLITE_ERROR')
        return 'sqlite_error';
    return 'unknown';
}
function asCookieDatabaseDiagnosticError(error, stage) {
    if (error instanceof CookieDatabaseDiagnosticError)
        return error;
    return new CookieDatabaseDiagnosticError(stage, classifyCookieDatabaseFailureReason(error));
}
function reportCookieDatabaseFailure(report, requestId, platform, failure) {
    if (!requestId || !report)
        return;
    try {
        report({
            event: 'cookie_database_failed',
            requestId,
            platform,
            stage: failure.stage,
            reason: failure.reason,
        });
    }
    catch {
        // Diagnostic reporting must never replace the stable public import error.
    }
}
async function snapshotCookieDatabase(source, signal) {
    signal.throwIfAborted();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'mavis-chrome-cookies-'));
    const databasePath = path.join(directory, 'Cookies');
    let sourceDatabase = null;
    let stage = 'source_stat';
    try {
        const stats = await lstat(source);
        if (!stats.isFile() || stats.isSymbolicLink()) {
            throw new CookieDatabaseDiagnosticError('source_stat', 'invalid_source');
        }
        const sqlite = requireForMain('node:sqlite');
        stage = 'source_open';
        sourceDatabase = new sqlite.DatabaseSync(source, {
            readOnly: true,
            enableForeignKeyConstraints: false,
        });
        stage = 'snapshot_backup';
        await sqlite.backup(sourceDatabase, databasePath);
        signal.throwIfAborted();
        return {
            databasePath,
            cleanup: () => rm(directory, { recursive: true, force: true }),
        };
    }
    catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw asCookieDatabaseDiagnosticError(error, stage);
    }
    finally {
        sourceDatabase?.close();
    }
}
function asBigInt(value) {
    if (typeof value === 'bigint')
        return value;
    if (typeof value === 'number' && Number.isSafeInteger(value))
        return BigInt(value);
    if (typeof value === 'string')
        return BigInt(value);
    return 0n;
}
function asBuffer(value) {
    if (Buffer.isBuffer(value))
        return value;
    if (value instanceof Uint8Array)
        return Buffer.from(value);
    return Buffer.alloc(0);
}
function toCookieRow(row) {
    return {
        host_key: typeof row.host_key === 'string' ? row.host_key : '',
        name: typeof row.name === 'string' ? row.name : '',
        value: typeof row.value === 'string' ? row.value : '',
        encrypted_value: asBuffer(row.encrypted_value),
        path: typeof row.path === 'string' ? row.path : '/',
        expires_utc: asBigInt(row.expires_utc),
        is_secure: asBigInt(row.is_secure),
        is_httponly: asBigInt(row.is_httponly),
        samesite: asBigInt(row.samesite),
    };
}
export async function readChromeCookies(profile, signal, options = {}) {
    const platform = options.platform ?? process.platform;
    if (platform !== 'darwin' && platform !== 'win32') {
        throw new Error(`Unsupported Chrome Cookie platform: ${platform}`);
    }
    const requestId = options.requestId;
    const report = options.onDiagnostic;
    const snapshotStartedAt = Date.now();
    let snapshot;
    try {
        snapshot = await snapshotCookieDatabase(profile.cookieDatabasePath, signal);
    }
    catch (error) {
        if (signal.aborted)
            throw error;
        reportCookieDatabaseFailure(report, requestId, platform, asCookieDatabaseDiagnosticError(error, 'snapshot_backup'));
        throw new BrowserProfileImportFailure('cookie_database_unavailable');
    }
    if (requestId && report) {
        report({
            event: 'cookie_snapshot_completed',
            requestId,
            durationMs: Date.now() - snapshotStartedAt,
        });
    }
    let database = null;
    let databaseStage = 'snapshot_open';
    try {
        let databaseVersion = 0;
        let rows;
        let truncatedCount = 0;
        try {
            signal.throwIfAborted();
            const { DatabaseSync } = requireForMain('node:sqlite');
            database = new DatabaseSync(snapshot.databasePath, {
                readOnly: true,
                enableForeignKeyConstraints: false,
            });
            databaseStage = 'schema_query';
            const versionRow = database.prepare("SELECT value FROM meta WHERE key = 'version'").get();
            databaseVersion = Number(versionRow?.value ?? 0);
            const hostFilter = options.currentHost
                ? `WHERE (
             substr(host_key, 1, 1) <> '.' AND lower(host_key) = lower(?)
           ) OR (
             substr(host_key, 1, 1) = '.' AND (
               lower(ltrim(host_key, '.')) = lower(?)
               OR lower(?) LIKE '%.' || lower(ltrim(host_key, '.'))
             )
           )`
                : '';
            const parameters = options.currentHost
                ? [options.currentHost, options.currentHost, options.currentHost]
                : [];
            databaseStage = 'cookie_query';
            const countRow = database
                .prepare(`SELECT COUNT(*) AS count FROM cookies ${hostFilter}`)
                .get(...parameters);
            const totalRowCount = Number(countRow?.count ?? 0);
            const statement = database.prepare(`
        SELECT host_key, name, value, encrypted_value, path, expires_utc,
               is_secure, is_httponly, samesite
        FROM cookies
        ${hostFilter}
        LIMIT ${MAX_COOKIE_ROWS + 1}
      `);
            statement.setReadBigInts(true);
            rows = statement.all(...parameters);
            if (Number.isFinite(totalRowCount) && totalRowCount > MAX_COOKIE_ROWS) {
                rows.length = Math.min(rows.length, MAX_COOKIE_ROWS);
                truncatedCount = totalRowCount - MAX_COOKIE_ROWS;
            }
        }
        catch (error) {
            if (signal.aborted)
                throw error;
            reportCookieDatabaseFailure(report, requestId, platform, asCookieDatabaseDiagnosticError(error, databaseStage));
            throw new BrowserProfileImportFailure('cookie_database_unavailable');
        }
        let skippedCount = truncatedCount;
        let unsupportedCount = 0;
        const cookies = [];
        const cookieRows = rows.map(toCookieRow);
        const encryptedRows = cookieRows.filter((row) => !row.value && row.encrypted_value.length > 0);
        if (requestId && report) {
            report({
                event: 'cookie_rows_read',
                requestId,
                platform,
                rowCount: cookieRows.length,
                encryptedCount: encryptedRows.length,
                truncatedCount,
            });
        }
        let macPassword;
        let windowsMasterKey;
        let secretAccess;
        try {
            if (platform === 'darwin' && encryptedRows.length > 0) {
                options.onAuthorizationRequired?.();
                secretAccess = { provider: 'macos_keychain', startedAt: Date.now() };
                if (requestId && report) {
                    report({ event: 'secret_access_started', requestId, provider: 'macos_keychain' });
                }
                macPassword = options.getMacSafeStoragePassword
                    ? await options.getMacSafeStoragePassword(signal)
                    : await readMacChromeSafeStoragePassword(signal, (lookup) => {
                        if (!requestId || !report)
                            return;
                        if (lookup.phase === 'started') {
                            report({
                                event: 'keychain_lookup_started',
                                requestId,
                                strategy: lookup.strategy,
                            });
                        }
                        else if (lookup.phase === 'completed') {
                            report({
                                event: 'keychain_lookup_completed',
                                requestId,
                                strategy: lookup.strategy,
                                durationMs: lookup.durationMs,
                            });
                        }
                        else {
                            report({
                                event: 'keychain_lookup_failed',
                                requestId,
                                strategy: lookup.strategy,
                                durationMs: lookup.durationMs,
                                reason: lookup.reason,
                            });
                        }
                    });
                options.onAuthorizationCompleted?.();
                if (requestId && report) {
                    report({
                        event: 'secret_access_completed',
                        requestId,
                        provider: 'macos_keychain',
                        durationMs: Date.now() - secretAccess.startedAt,
                    });
                }
            }
            if (platform === 'win32' &&
                encryptedRows.some((row) => {
                    const prefix = row.encrypted_value.subarray(0, 3).toString('ascii');
                    return prefix === 'v10' || prefix === 'v11';
                })) {
                secretAccess = { provider: 'windows_dpapi', startedAt: Date.now() };
                if (requestId && report) {
                    report({ event: 'secret_access_started', requestId, provider: 'windows_dpapi' });
                }
                windowsMasterKey = await (options.getWindowsMasterKey ??
                    ((localStatePath, abortSignal) => readWindowsChromeMasterKey(localStatePath, options.dpapiUnprotect ?? windowsDpapiUnprotect, abortSignal)))(profile.localStatePath, signal);
                if (requestId && report) {
                    report({
                        event: 'secret_access_completed',
                        requestId,
                        provider: 'windows_dpapi',
                        durationMs: Date.now() - secretAccess.startedAt,
                    });
                }
            }
        }
        catch (error) {
            if (requestId && report && secretAccess) {
                report({
                    event: 'secret_access_failed',
                    requestId,
                    provider: secretAccess.provider,
                    durationMs: Date.now() - secretAccess.startedAt,
                    reason: signal.aborted ? 'cancelled' : secretFailureReason(error),
                });
            }
            if (signal.aborted)
                throw error;
            throw new BrowserProfileImportFailure(error instanceof MacSafeStorageAccessError
                ? macSafeStorageErrorCode(error)
                : 'decryption_failed');
        }
        let decryptionFailureCount = 0;
        for (const row of cookieRows) {
            signal.throwIfAborted();
            const requiresDecryption = !row.value && row.encrypted_value.length > 0;
            try {
                if (requiresDecryption) {
                    if (platform === 'darwin') {
                        if (!macPassword)
                            throw new Error('Chrome Safe Storage password is unavailable');
                        row.value = decryptMacChromeCookie({
                            encryptedValue: row.encrypted_value,
                            hostKey: row.host_key,
                            safeStoragePassword: macPassword,
                            databaseVersion,
                        });
                    }
                    else {
                        const decrypted = await decryptWindowsChromeCookie({
                            encryptedValue: row.encrypted_value,
                            masterKey: windowsMasterKey,
                            hostKey: row.host_key,
                            databaseVersion,
                            dpapiUnprotect: (encrypted) => (options.dpapiUnprotect ?? windowsDpapiUnprotect)(encrypted, signal),
                        });
                        if (decrypted.unsupported) {
                            unsupportedCount += 1;
                            continue;
                        }
                        row.value = decrypted.value ?? '';
                    }
                }
                const normalized = normalizeChromeCookie(row);
                if (normalized)
                    cookies.push(normalized);
                else
                    skippedCount += 1;
            }
            catch {
                if (requiresDecryption)
                    decryptionFailureCount += 1;
                skippedCount += 1;
            }
        }
        if (requestId && report) {
            report({
                event: 'cookies_decoded',
                requestId,
                cookieCount: cookies.length,
                skippedCount,
                unsupportedCount,
                decryptionFailureCount,
            });
        }
        return { cookies, skippedCount, unsupportedCount };
    }
    finally {
        database?.close();
        await snapshot.cleanup();
    }
}
