import { isBuiltin } from 'node:module';
import path from 'node:path';
import { init, parse } from 'es-module-lexer';
import { ModelAccessPackageError } from './errors.js';
const RELATIVE_MODULE = /^(?:\.\/|\.\.\/)[a-zA-Z0-9_@./-]+$/u;
function dependencyPath(importer, specifier) {
    // Builtins belong to the host's Node/ABI, not to the package's content digest.
    if (specifier.startsWith('node:') && isBuiltin(specifier))
        return undefined;
    if (!RELATIVE_MODULE.test(specifier))
        throw new ModelAccessPackageError('dependency_unsupported');
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
    if (resolved.startsWith('../') || !['.mjs', '.json'].includes(path.posix.extname(resolved)))
        throw new ModelAccessPackageError('dependency_unsupported');
    return resolved;
}
function validateModule(importer, bytes, files) {
    const code = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const [imports] = parse(code);
    for (const item of imports) {
        if (item.d === -2)
            continue; // import.meta (including resource URLs) is not a module import.
        if ((item.t !== 1 && item.t !== 2) || item.n === undefined)
            throw new ModelAccessPackageError('dependency_unsupported');
        const dependency = dependencyPath(importer, item.n);
        if (dependency === undefined)
            continue;
        const content = files.get(dependency);
        if (!content)
            throw new ModelAccessPackageError('dependency_missing');
        if (dependency.endsWith('.json'))
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content));
    }
}
/**
 * Packaging contract: bundle third-party JS/SDK and emit .mjs chunks with literal imports.
 * Validate every chunk, including lazy/unreachable ones, against the exact copied bytes.
 * No module resolution through ambient node_modules, file/data URLs or computed imports.
 * This is NOT a sandbox: trusted native code can still use fs, exec, eval or native loaders.
 * Native companions need a separately declared platform/ABI contract before use.
 */
export async function validatePackageModules(files) {
    await init;
    try {
        for (const [name, bytes] of files) {
            if (name.endsWith('.mjs'))
                validateModule(name, bytes, files);
        }
    }
    catch (error) {
        if (error instanceof ModelAccessPackageError)
            throw error;
        throw new ModelAccessPackageError('invalid_package');
    }
}
//# sourceMappingURL=package-modules.js.map