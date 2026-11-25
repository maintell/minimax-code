import path from 'node:path';
import { HOOK_MODULES_INVALID_FIX } from '@mavis/plugin-hooks';
import { resolvePluginFile } from '../filesystem.js';
import { PluginReaderError } from '../reader-errors.js';
const MODS_NOT_SUPPORTED_YET_FIX = '一期不加载 `.\u0063\u006c\u0061\u0075\u0064\u0065-plugin` 的 mod；改用 `.minimax-plugin` 格式并按一 §4 改写模块';
const HOOK_MODULES_UNSUPPORTED_FORMAT_FIX = '删掉 `.codex-plugin` 包里的 `modules`，或改用 `.minimax-plugin` 格式';
/**
 * Records the one extension module of a MiniMax package. The module must be a
 * regular file inside the package root; it is never read here.
 */
export async function readMiniMaxExtension(root, declarations) {
    const [declaration, ...extra] = declarations;
    if (!declaration)
        return { diagnostics: [] };
    if (extra.length > 0) {
        return { diagnostics: extra.map((entry) => modulesInvalid(entry.sourcePath)) };
    }
    // The parser already reported a malformed value.
    if (!declaration.modulePath)
        return { diagnostics: [] };
    const modulePath = path.posix.normalize(path.posix.join(path.posix.dirname(declaration.sourcePath), declaration.modulePath));
    if (modulePath === '..' || modulePath.startsWith('../')) {
        return { diagnostics: [modulesInvalid(declaration.sourcePath)] };
    }
    try {
        await resolvePluginFile(root, modulePath, { portable: true });
    }
    catch (error) {
        if (!(error instanceof PluginReaderError))
            throw error;
        return { diagnostics: [modulesInvalid(declaration.sourcePath)] };
    }
    return { extension: { modulePath, hooksPath: declaration.sourcePath }, diagnostics: [] };
}
/** Compatible formats never load modules; each declaring document gets one diagnostic. */
export function compatibleModulesDiagnostics(kind, declarations) {
    return declarations.map((declaration) => ({
        code: kind === 'CODEX' ? 'HOOK_MODULES_UNSUPPORTED_FORMAT' : 'MODS_NOT_SUPPORTED_YET',
        capability: 'EXTENSION',
        name: declaration.sourcePath,
        fix: kind === 'CODEX' ? HOOK_MODULES_UNSUPPORTED_FORMAT_FIX : MODS_NOT_SUPPORTED_YET_FIX,
    }));
}
function modulesInvalid(sourcePath) {
    return {
        code: 'HOOK_MODULES_INVALID',
        capability: 'EXTENSION',
        name: sourcePath,
        fix: HOOK_MODULES_INVALID_FIX,
    };
}
//# sourceMappingURL=extension.js.map