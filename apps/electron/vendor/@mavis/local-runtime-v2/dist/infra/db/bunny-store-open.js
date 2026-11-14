import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { BUNNY_DATABASE_RELATIVE_PATH } from '@mavis/shared/local-runtime-paths';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { DatabaseClient, loadSqlite3Constructor } from './client.js';
import { runMigrations } from './migrate.js';
import { logger } from '../logging/logger.js';
import { incrementMetric } from '../logging/metrics.js';
import { BUNNY_INITIALIZED_AT_KEY, BUNNY_STORE_CREATED_AT_KEY, readBunnySetting, writeBunnySetting, } from './bunny-store.js';
import { BUNNY_STORE_MIGRATION_HISTORY_TABLE, BUNNY_STORE_MIGRATIONS, } from './bunny-store-migrations.js';
import { BUNNY_STORE_TABLE_METADATA } from './schema/bunny-store.js';
function bunnyStoreOpenMetricLabels(store) {
    if (store.unavailable !== undefined)
        return { outcome: 'unavailable', reason: 'open_error' };
    if (store.rebuiltFrom !== undefined) {
        return { outcome: 'rebuilt', reason: store.rebuildReason ?? 'integrity_check_failed' };
    }
    return { outcome: 'ok', reason: 'none' };
}
/** 每次 runtime 启动报一次 Bunny 库打开结果；指标失败不影响启动。 */
export function recordBunnyStoreOpenMetric(metrics, store) {
    // Metrics are observational only: incrementMetric never throws.
    incrementMetric(metrics, 'bunny_store_open_total', 1, bunnyStoreOpenMetricLabels(store));
}
/**
 * `<dataDir>/bunny/data/bunny.sqlite`，第一次用到时才打开：读 `db` 的任一成员、备份或 `open()`。
 * 打开走 openBunnyStoreOrUnavailable，打不开时换成 `unavailable` 的内存空库。没打开之前库文件
 * 不会被创建，`unavailable` 等状态都是 undefined；关闭之后不再打开。
 */
export function openBunnyStoreLazily(options) {
    const path = join(options.dataDir, BUNNY_DATABASE_RELATIVE_PATH);
    const listeners = [];
    let store;
    let closed = false;
    let hasData = false;
    const open = () => {
        // Closed wins over open: the store's connection would otherwise reconnect on the next query.
        if (closed)
            throw new Error('Bunny store is closed');
        if (store)
            return store;
        const opened = openBunnyStoreOrUnavailable(options);
        store = opened;
        for (const listener of listeners.splice(0))
            notify(listener, opened);
        return opened;
    };
    return {
        db: lazyConnection(() => open().db),
        get path() {
            return store?.path ?? path;
        },
        get unavailable() {
            return store?.unavailable;
        },
        get rebuiltFrom() {
            return store?.rebuiltFrom;
        },
        get rebuildReason() {
            return store?.rebuildReason;
        },
        backup: (destinationPath) => open().backup(destinationPath),
        hasData: () => {
            // Nothing deletes the file while the runtime runs, so once seen it stays seen.
            if (!hasData)
                hasData = store !== undefined || existsSync(path);
            return hasData;
        },
        open: () => {
            open();
        },
        whenOpened: (listener) => {
            if (store)
                notify(listener, store);
            else
                listeners.push(listener);
        },
        close: () => {
            closed = true;
            store?.close();
        },
    };
}
function notify(listener, store) {
    try {
        listener(store);
    }
    catch (error) {
        logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Bunny store open listener failed');
    }
}
/**
 * 代替连接的代理：第一次读它的成员时打开库，之后把成员转给真连接（方法绑定到真连接）。
 * 原型也取真连接的，Drizzle 按类判断连接种类时看到的是真连接。每次读成员都先经 `connect`，
 * 库关闭后它抛错，缓存的绑定方法不会再被交出去。
 */
function lazyConnection(connect) {
    const bound = new Map();
    return new Proxy({}, {
        get(_target, property) {
            const db = connect();
            if (bound.has(property))
                return bound.get(property);
            const value = Reflect.get(db, property, db);
            if (typeof value !== 'function')
                return value;
            const method = value.bind(db);
            bound.set(property, method);
            return method;
        },
        has: (_target, property) => Reflect.has(connect(), property),
        getPrototypeOf: () => Reflect.getPrototypeOf(connect()),
    });
}
/**
 * 打开 Bunny 库；打不开时（目录不可写、文件被占用、迁移失败等，损坏和结构不符
 * 已在 openBunnyStore 里改名重建）记 error，返回一个标了 `unavailable` 的内存空库。
 * Bunny 库的失败只关掉 Bunny，不挡住 runtime 启动；瞬时错误不改名、不重建，下次
 * 启动原样重试。
 *
 * @internal 运行时经 openBunnyStoreLazily 打开；导出只给测试用。
 */
export function openBunnyStoreOrUnavailable(options) {
    try {
        return openBunnyStore(options);
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logger.error({ dataDir: options.dataDir, reason }, 'Bunny store could not be opened; Bunny is off for this run and the rest of the runtime starts');
        return openUnavailableBunnyStore(options, reason);
    }
}
function openUnavailableBunnyStore(options, reason) {
    const Database = loadSqlite3Constructor(options.sqlite3ModulePath);
    const sqlite = new Database(':memory:');
    try {
        // Same connection rules as a file-backed Bunny store.
        sqlite.exec('PRAGMA foreign_keys = ON;');
        runMigrations(sqlite, BUNNY_STORE_MIGRATIONS, {
            historyTable: BUNNY_STORE_MIGRATION_HISTORY_TABLE,
        });
        const appDb = drizzle({ client: sqlite });
        const db = appDb;
        seedSettings(db, (options.nowMs ?? Date.now)());
        return {
            db,
            path: ':memory:',
            unavailable: reason,
            backup: () => Promise.reject(new Error(`Bunny store is unavailable: ${reason}`)),
            hasData: () => true,
            open: () => undefined,
            close: () => sqlite.close(),
        };
    }
    catch (error) {
        sqlite.close();
        throw error;
    }
}
/**
 * 打开 `<dataDir>/bunny/data/bunny.sqlite` 并跑完 Bunny 库迁移。
 *
 * 不套用大库的备份、隔离和严格通道：文件损坏或表结构对不上时，把它改名为
 * `bunny.sqlite.corrupt-<ms>` 再建一个空库，并打 error 日志。迁移可以重复执行。
 * 其余打开失败照常抛出。
 *
 * @internal 运行时经 openBunnyStoreLazily 打开；导出只给需要真实 Bunny 库的测试用。
 */
export function openBunnyStore(options) {
    const nowMs = options.nowMs ?? Date.now;
    const clientOptions = {
        dataDir: options.dataDir,
        relativePath: BUNNY_DATABASE_RELATIVE_PATH,
        ...(options.sqlite3ModulePath ? { sqlite3ModulePath: options.sqlite3ModulePath } : {}),
    };
    let client = new DatabaseClient(clientOptions);
    const path = client.databasePath;
    let rebuild;
    if (existsSync(path) && !hasIntegrity(client, path)) {
        // The check uses its own read-only connection; drop any handle before moving the files.
        client.close();
        rebuild = quarantine(path, nowMs(), 'integrity_check_failed');
        client = new DatabaseClient(clientOptions);
    }
    try {
        migrate(client);
        const mismatch = schemaMismatch(client);
        if (mismatch) {
            client.close();
            rebuild = quarantine(path, nowMs(), 'schema_mismatch', mismatch);
            client = new DatabaseClient(clientOptions);
            migrate(client);
            const again = schemaMismatch(client);
            if (again)
                throw new Error(`Bunny store schema mismatch after rebuild: ${again}`);
        }
        seedSettings(client.db, nowMs());
    }
    catch (error) {
        try {
            client.close();
        }
        catch {
            // Keep the initialization error.
        }
        throw error;
    }
    const opened = client;
    return {
        get db() {
            return opened.db;
        },
        path,
        ...(rebuild ? { rebuiltFrom: rebuild.from, rebuildReason: rebuild.reason } : {}),
        backup: (destinationPath) => opened.backup(destinationPath),
        hasData: () => true,
        open: () => undefined,
        close: () => opened.close(),
    };
}
function migrate(client) {
    runMigrations(client.rawDb, BUNNY_STORE_MIGRATIONS, {
        historyTable: BUNNY_STORE_MIGRATION_HISTORY_TABLE,
    });
}
function hasIntegrity(client, path) {
    try {
        return client.hasValidIntegrity(path);
    }
    catch {
        // "file is not a database" and similar open failures count as corruption.
        return false;
    }
}
/** 返回第一处结构不符的描述；结构正确时返回 undefined。 */
function schemaMismatch(client) {
    for (const table of BUNNY_STORE_TABLE_METADATA) {
        const columns = new Set(client.rawDb
            .prepare(`PRAGMA table_info(${table.name})`)
            .all()
            .map((row) => row.name));
        for (const column of table.columns)
            if (!columns.has(column))
                return `${table.name}.${column}`;
    }
    return undefined;
}
/** 首次建库写入建库时间和初始化时间；已有值保持不变。 */
function seedSettings(db, now) {
    db.transaction((tx) => {
        if (readBunnySetting(tx, BUNNY_STORE_CREATED_AT_KEY) === undefined)
            writeBunnySetting(tx, BUNNY_STORE_CREATED_AT_KEY, now);
        if (readBunnySetting(tx, BUNNY_INITIALIZED_AT_KEY) === undefined)
            writeBunnySetting(tx, BUNNY_INITIALIZED_AT_KEY, now);
    });
}
function quarantine(path, now, reason, detail) {
    const target = `${path}.corrupt-${now}`;
    for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(`${path}${suffix}`))
            renameSync(`${path}${suffix}`, `${target}${suffix}`);
    }
    logger.error({ path, quarantinedTo: target, reason: detail ? `${reason}:${detail}` : reason }, 'Bunny store was unreadable; moved it aside and created an empty one');
    return { from: target, reason };
}
//# sourceMappingURL=bunny-store-open.js.map