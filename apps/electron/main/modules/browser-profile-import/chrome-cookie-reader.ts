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
/**
 * 直读失败后值得改走卷影副本的原因。
 *
 * 只包含「被占用」类原因：access_denied 是权限问题，corrupt 是库损坏，
 * 两者都不会因为换个副本能解决，反而会把真实原因掩盖成卷影失败。
 */
const SHADOW_RETRY_REASONS = new Set([
    'busy',
    'locked',
    'cannot_open',
]);
/**
 * 判断直读失败后是否值得改走卷影副本。
 *
 * 导出成纯函数是为了能穷举决策矩阵：文件系统层面无法跨平台稳定构造出
 * `cannot_open`（Windows 上要靠 Chrome 的独占锁才有），所以这条分支的正确性
 * 只能靠纯函数单测，加上真机验证（本机 Chrome 156 实测卷影副本可读出全部 897 条）。
 */
/**
 * Decide what a failed shadow copy means for the user.
 *
 * Only a snapshot that was attempted and did not produce a readable copy is a
 * shadow_unavailable, because that is the case where closing Chrome actually
 * helps. The privileged path classifies its own failures before they get here,
 * and those classifications carry the action the user can take: a declined UAC
 * prompt is a choice to retry, and a failed elevation is a system setting to
 * change. Collapsing either into shadow_unavailable tells the user to close
 * Chrome, which is neither the cause nor something they can act on from there.
 */
export function classifyShadowSnapshotFailure(error) {
    if (error instanceof BrowserProfileImportFailure)
        return error;
    return new CookieDatabaseDiagnosticError('shadow_snapshot', 'shadow_unavailable');
}
export function shouldUseShadowSnapshot(input) {
    if (input.platform !== 'win32')
        return false;
    if (!input.hasHook)
        return false;
    return SHADOW_RETRY_REASONS.has(input.reason);
}
/**
 * 打开 Cookies 库的可读快照，必要时先绕开 Chrome 的独占锁。
 *
 * Chrome 在 Windows 上以无共享方式持有 Cookies 库（实测裸文件只读打开即 EBUSY），
 * 因此直读失败且原因是「被占用」时，改从卷影副本读同一文件。
 * 卷影副本由已提权的 broker 创建，读取仍在用户态完成，cookie 数据不经过特权管道。
 *
 * 先直读再降级是有意的：Chrome 已退出时直读本就可用，
 * 而创建卷影副本约需 20 秒，不该为不需要的场景付这个代价。
 */
async function openCookieDatabaseSnapshot(source, signal, context) {
    try {
        return await snapshotCookieDatabase(source, signal);
    }
    catch (error) {
        if (signal.aborted)
            throw error;
        const failure = asCookieDatabaseDiagnosticError(error, 'snapshot_backup');
        const { platform, options, report, requestId } = context;
        const shadowHook = options.createWindowsShadowSnapshot;
        if (!shadowHook ||
            !shouldUseShadowSnapshot({ platform, reason: failure.reason, hasHook: true })) {
            throw failure;
        }
        const shadowStartedAt = Date.now();
        // The grant is announced before it is requested, not after it fails: on this
        // path the shadow copy is the first privileged call, so this is where the
        // UAC prompt actually appears. Leaving the phase as "reading" means the user
        // sees a system dialog with no explanation of what asked for it.
        options.onAuthorizationRequired?.();
        let shadowPath;
        try {
            shadowPath = await shadowHook(source, signal);
        }
        catch (shadowError) {
            if (signal.aborted)
                throw shadowError;
            throw classifyShadowSnapshotFailure(shadowError);
        }
        if (requestId && report) {
            report({
                event: 'cookie_shadow_snapshot_completed',
                requestId,
                platform,
                durationMs: Date.now() - shadowStartedAt,
            });
        }
        try {
            return await snapshotCookieDatabase(shadowPath, signal);
        }
        catch (shadowReadError) {
            if (signal.aborted)
                throw shadowReadError;
            throw asCookieDatabaseDiagnosticError(shadowReadError, 'snapshot_backup');
        }
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
        snapshot = await openCookieDatabaseSnapshot(profile.cookieDatabasePath, signal, {
            platform,
            options,
            report,
            requestId,
        });
    }
    catch (error) {
        if (signal.aborted)
            throw error;
        // A failure the privileged path already classified carries the action the
        // user can actually take, so it travels unchanged. Re-deriving a code here
        // would turn a declined UAC prompt back into "close Chrome and retry".
        if (error instanceof BrowserProfileImportFailure)
            throw error;
        const failure = asCookieDatabaseDiagnosticError(error, 'snapshot_backup');
        reportCookieDatabaseFailure(report, requestId, platform, failure);
        // A blocked shadow fallback is reported apart from an unreadable database,
        // because the fix is in the user's hands: close Chrome and the direct read
        // works. Reporting it as a database problem sends them looking at file
        // permissions, where nothing is wrong.
        throw new BrowserProfileImportFailure(failure.reason === 'shadow_unavailable'
            ? 'shadow_unavailable'
            : 'cookie_database_unavailable');
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
    // Declared out here rather than beside the lookups so the finally block can
    // reach them: a let inside the try is a sibling scope, not a visible one.
    let windowsMasterKey;
    let windowsAppBoundKey;
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
            if (platform === 'win32' &&
                options.getWindowsAppBoundKey &&
                encryptedRows.some((row) => row.encrypted_value.subarray(0, 3).toString('ascii') === 'v20')) {
                // v20 需要 SYSTEM 上下文，属于用户可见的授权动作，沿用 authorizing 生命周期。
                options.onAuthorizationRequired?.();
                secretAccess = { provider: 'windows_dpapi', startedAt: Date.now() };
                if (requestId && report) {
                    report({ event: 'secret_access_started', requestId, provider: 'windows_dpapi' });
                }
                windowsAppBoundKey = await options.getWindowsAppBoundKey(profile.localStatePath, signal);
                if (windowsAppBoundKey.length !== 32) {
                    throw new BrowserProfileImportFailure('decryption_failed');
                }
                options.onAuthorizationCompleted?.();
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
            // 已经分好类的失败原样上抛。压平成 decryption_failed 会丢掉「用户取消了
            // UAC」这类信息，而那恰恰是唯一需要区别对待的一种。
            if (error instanceof BrowserProfileImportFailure)
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
                            appBoundKey: windowsAppBoundKey,
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
        // Both keys are cleared before the buffers become garbage. abe-key-provider
        // zeroes every intermediate plaintext it handles, so leaving the final key
        // sitting in a reachable buffer until collection would be the one place in
        // this path where key material outlives its use.
        windowsAppBoundKey?.fill(0);
        windowsMasterKey?.fill(0);
        database?.close();
        await snapshot.cleanup();
    }
}
