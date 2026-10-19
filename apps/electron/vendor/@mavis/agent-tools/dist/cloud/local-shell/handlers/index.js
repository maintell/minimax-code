/**
 * Local handler registry — map command names to their fast-path handler.
 *
 * Adding a new handler:
 *   1. Implement `<name>.ts` in this directory exporting a `Handler`.
 *   2. Add the mapping below.
 *   3. Update the dispatcher tests to cover the happy + error path.
 */
import { catHandler } from './cat.js';
import { echoHandler } from './echo.js';
import { findHandler } from './find.js';
import { grepHandler } from './grep.js';
import { headHandler } from './head.js';
import { lsHandler } from './ls.js';
import { pwdHandler } from './pwd.js';
import { tailHandler } from './tail.js';
import { wcHandler } from './wc.js';
export const LOCAL_HANDLERS = {
    ls: lsHandler,
    cat: catHandler,
    head: headHandler,
    tail: tailHandler,
    wc: wcHandler,
    pwd: pwdHandler,
    echo: echoHandler,
    find: findHandler,
    grep: grepHandler,
};
//# sourceMappingURL=index.js.map