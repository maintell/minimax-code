import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
const DB_FILE = 'runtime-state.sqlite';
const DB_RELATIVE_PATH = join('v2', 'sqlite', DB_FILE);
export class DatabaseClient {
    rawDb_ = null;
    drizzleDb = null;
    dbPath;
    options;
    constructor(options) {
        this.options = options;
        this.dbPath = join(options.dataDir, DB_RELATIVE_PATH);
    }
    get db() {
        if (!this.drizzleDb)
            this.open();
        if (!this.drizzleDb)
            throw new Error('Database connection was not initialized');
        return this.drizzleDb;
    }
    /** 获取底层 better-sqlite3 句柄（用于 raw SQL / migration） */
    get rawDb() {
        if (!this.rawDb_)
            this.open();
        const rawDb = this.rawDb_;
        if (!rawDb)
            throw new Error('Database connection was not initialized');
        return rawDb;
    }
    /** 使用 SQLite 在线备份 API 将当前连接保存到指定文件。 */
    async backup(destinationPath) {
        await this.rawDb.backup(destinationPath);
    }
    /** 使用独立只读连接检查备份；只有单行 `ok` 视为通过。 */
    hasValidIntegrity(databasePath) {
        const Database = loadSqlite3Constructor(this.options.sqlite3ModulePath);
        const verificationDb = new Database(databasePath, {
            readonly: true,
            fileMustExist: true,
        });
        try {
            const rows = verificationDb.prepare('PRAGMA integrity_check').all();
            return rows.length === 1 && isIntegrityOkRow(rows[0]);
        }
        finally {
            verificationDb.close();
        }
    }
    /** 关闭连接并释放资源 */
    close() {
        if (this.rawDb_) {
            this.rawDb_.close();
            this.rawDb_ = null;
            this.drizzleDb = null;
        }
    }
    open() {
        if (!this.options.readonly)
            mkdirSync(dirname(this.dbPath), { recursive: true });
        const Database = loadSqlite3Constructor(this.options.sqlite3ModulePath);
        const sqlite = new Database(this.dbPath, this.options.readonly ? { readonly: true, fileMustExist: true } : undefined);
        try {
            // v1 和 v2 暂时通过独立 connection 访问同一数据库文件，PRAGMA 必须保持一致。
            if (!this.options.readonly)
                sqlite.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
      `);
            const drizzleDb = drizzle({ client: sqlite });
            this.rawDb_ = sqlite;
            this.drizzleDb = drizzleDb;
            return sqlite;
        }
        catch (error) {
            try {
                sqlite.close();
            }
            catch {
                // Preserve the connection initialization error.
            }
            throw error;
        }
    }
}
/** Resolve the native SQLite constructor for target and read-only source connections. */
export function loadSqlite3Constructor(overrideModulePath) {
    const overridePath = overrideModulePath?.trim() || process.env.MAVIS_SQLITE3_MODULE_PATH?.trim();
    const require = createRequire(import.meta.url);
    if (overridePath) {
        const loaded = createRequire(join(overridePath, 'package.json'))('better-sqlite3');
        return resolveSqliteConstructor(loaded);
    }
    const loaded = require('better-sqlite3');
    return resolveSqliteConstructor(loaded);
}
function resolveSqliteConstructor(loaded) {
    if (typeof loaded === 'function')
        return loaded;
    if (isObject(loaded) && typeof loaded.default === 'function') {
        return loaded.default;
    }
    throw new TypeError('better-sqlite3 module does not export a database constructor');
}
function isIntegrityOkRow(row) {
    return isObject(row) && row.integrity_check === 'ok';
}
function isObject(value) {
    return typeof value === 'object' && value !== null;
}
//# sourceMappingURL=client.js.map