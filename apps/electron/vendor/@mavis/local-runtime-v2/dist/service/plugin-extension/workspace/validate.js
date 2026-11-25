import { createSiteTable } from '@mavis/shared/plugin-extension';
import { isExtensionErrorCode, createExtensionDiagnostic, } from '../sdk/diagnostics.js';
import { readExtensionCandidatePackage } from '../../plugin-system/index.js';
import { readSdkPackageVersion } from '../authoring/editor-types.js';
import { createExtensionCandidate } from './candidate.js';
import { compileExtensionModule, extensionCompilerFingerprint } from './compile.js';
import { scanExtensionSources, scanJsxPragmas, sortDiagnostics } from './scan.js';
import { isExtensionSourceFile } from './syntax.js';
const MANIFEST = '.minimax-plugin/plugin.json';
/**
 * preview ①②: candidate snapshot + digest → the plugin system reads the package once (manifest,
 * declared MCP servers, `hooks.json#modules`) → JSX pragma check → esbuild → syntax scan of the
 * bundled modules. A `ValidatedArtifact` exists only when no error-level diagnostic was raised.
 * Type checking is not part of this step (one.md §6: it runs after activation).
 */
export async function validateExtensionSource(input) {
    const candidateResult = await createExtensionCandidate(input);
    if (!candidateResult.ok)
        return split(candidateResult.diagnostics);
    const candidate = candidateResult.candidate;
    const read = await readPackage(input.pluginId, candidate.root);
    if (!read.ok)
        return split(read.diagnostics);
    const { entry } = read;
    const sourceFiles = candidate.files.filter(isExtensionSourceFile);
    const pragmaDiagnostics = await scanJsxPragmas(candidate.root, sourceFiles);
    const compiled = pragmaDiagnostics.length > 0
        ? { ok: false, diagnostics: [] }
        : await compileExtensionModule({ root: candidate.root, entry });
    const scanFiles = compiled.ok
        ? [...new Set([entry, ...compiled.inputs.filter(isExtensionSourceFile)])]
        : [entry];
    const scan = await scanExtensionSources({
        root: candidate.root,
        entry,
        files: scanFiles,
        stateFiles: sourceFiles,
        siteTable: input.siteTable ?? createSiteTable(),
    });
    const result = split([
        ...read.diagnostics,
        ...pragmaDiagnostics,
        ...(compiled.ok ? [] : compiled.diagnostics),
        ...scan.diagnostics,
    ]);
    if (!compiled.ok || result.errors.length > 0)
        return result;
    const sdkVersion = await readSdkVersion();
    return {
        ...result,
        artifact: {
            pluginId: input.pluginId,
            digest: candidate.digest,
            candidateRoot: candidate.root,
            entry,
            files: candidate.files,
            package: read.package,
            scan: {
                entries: scan.entries,
                bindings: scan.bindings,
                hooks: scan.hooks,
                calls: scan.calls,
                state: scan.state,
            },
            compiled: compiled.compiled,
            compilerFingerprint: await extensionCompilerFingerprint(sdkVersion),
            sdkVersion,
            diagnostics: result.warnings,
        },
    };
}
/**
 * The package as install and the session overlay will see it: the manifest must name this
 * plugin, and the entry is the module the declared `hooks.json#modules` points at.
 */
async function readPackage(pluginId, root) {
    const read = await readExtensionCandidatePackage(root);
    if (!read.ok) {
        return {
            ok: false,
            diagnostics: [
                createExtensionDiagnostic('EXTENSION_PACKAGE_INVALID', {
                    detail: `${read.code}: ${read.detail}`,
                }),
            ],
        };
    }
    const { package: candidate } = read;
    const diagnostics = candidate.diagnostics.map(readerDiagnostic);
    if (candidate.name !== pluginId) {
        diagnostics.push(createExtensionDiagnostic('EXTENSION_NAME_MISMATCH', {
            file: MANIFEST,
            detail: `the manifest names ${candidate.name}, the preview is for ${pluginId}`,
        }));
    }
    if (!candidate.extension && !diagnostics.some(isModulesInvalid)) {
        diagnostics.push(createExtensionDiagnostic('HOOK_MODULES_INVALID', {
            file: MANIFEST,
            detail: 'no declared hooks document has `modules`',
        }));
    }
    if (!candidate.extension || diagnostics.some((diagnostic) => diagnostic.level === 'error')) {
        return { ok: false, diagnostics };
    }
    return { ok: true, package: candidate, entry: candidate.extension.modulePath, diagnostics };
}
/**
 * Extension findings keep their code; anything else the reader skipped (a classic hook, an
 * ignored manifest field) is a warning, since the rest of the package still loads.
 */
function readerDiagnostic(diagnostic) {
    if (diagnostic.capability === 'EXTENSION' && isExtensionErrorCode(diagnostic.code)) {
        return createExtensionDiagnostic(diagnostic.code, diagnostic.name ? { file: diagnostic.name } : {});
    }
    return createExtensionDiagnostic('EXTENSION_PACKAGE_SKIPPED', {
        detail: diagnostic.name ? `${diagnostic.code} (${diagnostic.name})` : diagnostic.code,
    });
}
function isModulesInvalid(diagnostic) {
    return diagnostic.code === 'HOOK_MODULES_INVALID';
}
function split(diagnostics) {
    const sorted = sortDiagnostics(diagnostics);
    return {
        errors: sorted.filter((diagnostic) => diagnostic.level === 'error'),
        warnings: sorted.filter((diagnostic) => diagnostic.level === 'warning'),
    };
}
/** The fingerprint `validate` stamps on an artifact built now. */
export async function currentCompilerFingerprint() {
    return extensionCompilerFingerprint(await readSdkVersion());
}
let sdkVersion;
function readSdkVersion() {
    sdkVersion ??= readSdkPackageVersion();
    return sdkVersion;
}
//# sourceMappingURL=validate.js.map