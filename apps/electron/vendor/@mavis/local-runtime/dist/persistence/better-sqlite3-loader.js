import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
export function loadBetterSqlite3Module() {
    const overridePath = getBetterSqlite3ModuleOverridePath(process.env.MAVIS_SQLITE3_MODULE_PATH);
    const mod = overridePath
        ? createRequire(path.join(overridePath, 'package.json'))('better-sqlite3')
        : require('better-sqlite3');
    return normalizeBetterSqlite3Module(mod);
}
export function getBetterSqlite3ModuleOverridePath(value) {
    const overridePath = value?.trim();
    if (!overridePath)
        return undefined;
    return isAsarUnpackedPath(overridePath) ? undefined : overridePath;
}
function normalizeBetterSqlite3Module(mod) {
    return mod.default ?? mod;
}
function isAsarUnpackedPath(value) {
    return path.normalize(value).split(path.sep).includes('app.asar.unpacked');
}
//# sourceMappingURL=better-sqlite3-loader.js.map