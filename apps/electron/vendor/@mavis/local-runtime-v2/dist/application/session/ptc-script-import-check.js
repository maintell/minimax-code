import { initSync, parse } from 'es-module-lexer';
import { normalizePtcScriptSpecifier } from '../../service/turn-system/index.js';
/**
 * Resolution only. The three categories that refuse a save — a UNC path, a
 * URI scheme (a drive letter stays a path) and a bare package name — are
 * decided before the loader consults any directory, so nothing here is read.
 * A specifier that resolves is left to load time, exactly as before this check
 * existed.
 */
const RESOLUTION_ONLY_ROOTS = {
    user: '/nonexistent/user/ptc',
    skills: [],
    homeDir: '/nonexistent/home',
    workspaceDir: '/nonexistent/workspace',
};
/** A module's own name is its absolute path; the program's is `run_code.js`. */
const PROGRAM_BASE = 'run_code.js';
let lexerReady = false;
/**
 * The first module specifier in `content` that the loader always refuses, or
 * undefined when every import is a file path the loader can at least try.
 *
 * A real ES module lexer rather than a line scan: the earlier scan could not
 * tell source from text, so Node code inside a template literal or a string
 * was refused, while `import fs\n  from 'node:fs'` and
 * `await import(\n  'node:fs'\n)` were missed. `es-module-lexer` ships its
 * WASM inline, so `initSync` costs one synchronous compile on the first save
 * of the process and the save path stays synchronous.
 *
 * `import.meta` and `import(x)` with a computed argument carry no specifier
 * to judge and are skipped, as is an empty specifier, which the loader refuses
 * for a different reason than the three categories above.
 */
export function ptcScriptRefusedImport(content) {
    if (!lexerReady) {
        initSync();
        lexerReady = true;
    }
    let imports;
    try {
        [imports] = parse(content);
    }
    catch {
        // The lexer could not read the script, which means the script has a syntax
        // error. It is saved exactly as it came, the same as before this check
        // existed: what the check prevents is a script that fails later on an
        // import the loader always refuses, and a script that does not parse has
        // no imports to refuse.
        return undefined;
    }
    for (const item of imports) {
        if (item.d === -2)
            continue; // import.meta is not a module import.
        if (item.n === undefined)
            continue; // import(x) with a computed argument.
        if (refusedByLoader(item.n))
            return item.n;
    }
    return undefined;
}
/** The loader's own answer, so this check never becomes a second rule. */
function refusedByLoader(specifier) {
    if (!specifier.trim())
        return false;
    try {
        normalizePtcScriptSpecifier(PROGRAM_BASE, specifier, RESOLUTION_ONLY_ROOTS);
        return false;
    }
    catch {
        return true;
    }
}
//# sourceMappingURL=ptc-script-import-check.js.map