import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
function normalizeBetterSqlite3Module(mod) {
    return mod.default ?? mod;
}
export function loadBetterSqlite3() {
    const overridePath = process.env.MAVIS_SQLITE3_MODULE_PATH?.trim();
    if (overridePath) {
        const overrideRequire = createRequire(path.join(overridePath, 'package.json'));
        return normalizeBetterSqlite3Module(overrideRequire('better-sqlite3'));
    }
    return normalizeBetterSqlite3Module(require('better-sqlite3'));
}
//# sourceMappingURL=sqlite-driver.js.map