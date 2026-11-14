import { eq } from 'drizzle-orm';
import { bunnySettings } from './schema/bunny-store.js';
/** 建库时间，记忆捕获的下限之一。 */
export const BUNNY_STORE_CREATED_AT_KEY = 'storeCreatedAtMs';
export const BUNNY_INITIALIZED_AT_KEY = 'bunny.initializedAtMs';
/** @internal Exported only for focused tests. */
export const BUNNY_PERMISSION_MODE_KEY = 'bunny.permissionMode';
/** @internal Exported only for focused tests. */
export const BUNNY_TASK_MODEL_KEY = 'bunny.taskModel';
/** 向用户介绍过的能力及其时间，Bunny 重置时一起清掉。 */
const BUNNY_INTRODUCED_KEY = 'bunny.introduced';
/** reset snapshot、反馈报告按这个前缀列出 Bunny 设置项。 */
export const BUNNY_SETTING_PREFIX = 'bunny.';
export function readBunnySetting(db, key) {
    const row = db
        .select({ valueJson: bunnySettings.valueJson })
        .from(bunnySettings)
        .where(eq(bunnySettings.key, key))
        .get();
    if (!row)
        return undefined;
    try {
        return JSON.parse(row.valueJson);
    }
    catch {
        return undefined;
    }
}
export function writeBunnySetting(db, key, value) {
    const valueJson = JSON.stringify(value);
    if (valueJson === undefined)
        throw new TypeError('Bunny setting must be JSON-serializable');
    db.insert(bunnySettings)
        .values({ key, valueJson })
        .onConflictDoUpdate({ target: bunnySettings.key, set: { valueJson } })
        .run();
}
/** 删除一个设置项；行不存在时什么也不做。回到“从未设置过”，与写成 null 不同。 */
export function deleteBunnySetting(db, key) {
    db.delete(bunnySettings).where(eq(bunnySettings.key, key)).run();
}
/** Bunny 在第一次发生时向用户介绍一次的能力。 */
const BUNNY_FIRST_USES = ['dispatch', 'space', 'report'];
/** 还没有向用户介绍过的能力。 */
export function readPendingBunnyFirstUses(db) {
    const introduced = readBunnySetting(db, BUNNY_INTRODUCED_KEY) ?? {};
    return BUNNY_FIRST_USES.filter((item) => introduced[item] === undefined);
}
/** 重置 Bunny 时清掉已介绍记录，让每项能力重新介绍一次。 */
export function clearBunnyFirstUses(db) {
    db.delete(bunnySettings).where(eq(bunnySettings.key, BUNNY_INTRODUCED_KEY)).run();
}
/** 记下这项能力已经发生过。只记第一次的时间。 */
export function markBunnyFirstUse(db, item, atMs) {
    const introduced = readBunnySetting(db, BUNNY_INTRODUCED_KEY) ?? {};
    if (introduced[item] !== undefined)
        return;
    writeBunnySetting(db, BUNNY_INTRODUCED_KEY, { ...introduced, [item]: atMs });
}
/**
 * 按 key 前缀列出设置项；值解析失败时保留原文。
 * @internal Exported only for focused tests.
 */
export function listBunnySettings(db, prefix = BUNNY_SETTING_PREFIX) {
    return db
        .select()
        .from(bunnySettings)
        .all()
        .filter((row) => row.key.startsWith(prefix))
        .sort((left, right) => left.key.localeCompare(right.key))
        .map((row) => {
        try {
            return { key: row.key, value: JSON.parse(row.valueJson) };
        }
        catch {
            return { key: row.key, value: row.valueJson };
        }
    });
}
/** Bunny 的“初始化时间”，UI 和记忆都用它过滤更早的会话；没有记录时为 0。 */
export function readBunnyInitializedAt(db) {
    const value = readBunnySetting(db, BUNNY_INITIALIZED_AT_KEY);
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
/** 新库的建库时间；没有记录时为 0。 */
export function readBunnyStoreCreatedAt(db) {
    const value = readBunnySetting(db, BUNNY_STORE_CREATED_AT_KEY);
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
//# sourceMappingURL=bunny-store.js.map