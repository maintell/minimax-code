import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../common/logger.js';
import { loadBetterSqlite3Module } from '../persistence/better-sqlite3-loader.js';
const PINNED_ITEMS_ORDER_PREFERENCE_KEY = 'pinned-items-order';
export async function readPreviewTrainPinnedItemsOrderPreference(dataDir) {
    // preview_train daemon 的 preferences 表固定落在 dataDir/sqlite.db；新版 runtime state db 不读这张表。
    const dbPath = path.join(dataDir, 'sqlite.db');
    // 老用户可能已经没有 legacy sqlite.db，按“无旧数据”处理，不能影响新版 pin 服务启动。
    if (!fs.existsSync(dbPath))
        return [];
    let db;
    try {
        // 只读打开旧库，避免迁移读取过程意外修改 preview_train 数据。
        const Database = loadBetterSqlite3Module();
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
        // 部分测试 profile 或更早版本没有 preferences 表；缺表说明没有可迁移的旧 pin 顺序。
        const hasPreferencesTable = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'preferences'")
            .get()?.name;
        if (!hasPreferencesTable)
            return [];
        // 旧 KV 里保存的是用户拖拽后的 session/agent 混排顺序，是本次修复的权威来源。
        const row = db
            .prepare('SELECT value FROM preferences WHERE key = ?')
            .get(PINNED_ITEMS_ORDER_PREFERENCE_KEY);
        if (!row?.value)
            return [];
        const parsed = JSON.parse(row.value);
        return readLegacyPinnedItems(parsed).flatMap((item) => {
            if (item.type !== 'agent' && item.type !== 'session')
                return [];
            const id = item.id?.trim();
            if (!id)
                return [];
            return [{ type: item.type, id }];
        });
    }
    catch (err) {
        // 旧库损坏或 JSON 异常时只降级为“无旧 preferences”，后续 legacy pinned 列仍可继续补漏。
        logger.warn({ err, dbPath }, 'Failed to read preview_train pinned-items-order preference');
        return [];
    }
    finally {
        db?.close();
    }
}
function readLegacyPinnedItems(value) {
    if (!Array.isArray(value))
        return [];
    return value.flatMap((item) => {
        if (!item || typeof item !== 'object')
            return [];
        const record = item;
        const type = typeof record.type === 'string' ? record.type : undefined;
        const id = typeof record.id === 'string'
            ? record.id
            : typeof record.name === 'string'
                ? record.name
                : undefined;
        return type && id ? [{ type, id }] : [];
    });
}
//# sourceMappingURL=legacy-preferences.js.map