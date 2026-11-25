import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { createExtensionDiagnostic } from '../sdk/diagnostics.js';
import { EXTENSION_JSX_IMPORT_SOURCE, EXTENSION_SDK_SPECIFIERS, EXTENSION_TESTING_SPECIFIER, } from '../contracts.js';
import { isDigestExcludedPath } from './candidate.js';
import { loadEsbuild } from './esbuild-binary.js';
const SDK_SPECIFIERS = new Set(EXTENSION_SDK_SPECIFIERS);
const NESTED_RESOLVE = Symbol('extension-nested-resolve');
const OUTPUT_FILE = 'extension.cjs';
const COMPILE_BACKEND = 'esbuild-native';
/**
 * Host-owned build options (one.md §5). The plugin's own tsconfig is never read: `tsconfigRaw`
 * replaces it and every bare specifier is rejected before esbuild's resolver could apply `paths`.
 */
const EXTENSION_BUILD_OPTIONS = Object.freeze({
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'neutral',
    target: 'es2022',
    charset: 'utf8',
    jsx: 'automatic',
    jsxDev: false,
    jsxImportSource: EXTENSION_JSX_IMPORT_SOURCE,
    tsconfigRaw: {
        compilerOptions: { jsx: 'react-jsx', jsxImportSource: EXTENSION_JSX_IMPORT_SOURCE },
    },
    // vm.Script runs without importModuleDynamically; external dynamic imports become require().
    supported: { 'dynamic-import': false },
    sourcemap: 'external',
    legalComments: 'none',
    logLevel: 'silent',
    metafile: true,
});
export async function compileExtensionModule(input) {
    return compile(input.root, input.entry, {});
}
/** Specifier the test realm serves for the package entry module (the module under test). */
export const MODULE_UNDER_TEST_SPECIFIER = 'mcode-test:module-under-test';
/**
 * Bundles one `*.test.tsx` with the same guard as the module, plus `/testing`. Imports of the
 * package entry become {@link MODULE_UNDER_TEST_SPECIFIER}: tests drive the validated artifact,
 * not a second copy of it.
 */
export async function compileExtensionTest(input) {
    const root = await realpath(input.root);
    return compile(input.root, input.file, {
        external: new Set([EXTENSION_TESTING_SPECIFIER]),
        redirect: {
            from: await realpath(path.join(root, ...input.moduleEntry.split('/'))),
            to: MODULE_UNDER_TEST_SPECIFIER,
        },
    });
}
async function compile(sourceRoot, entry, guard) {
    const loaded = loadEsbuild();
    if (!loaded.ok) {
        return failure([
            createExtensionDiagnostic('EXTENSION_COMPILE_FAILED', { detail: loaded.detail }),
        ]);
    }
    const { esbuild, binaryPath } = loaded;
    const root = await realpath(sourceRoot);
    try {
        const result = await esbuild.build({
            ...EXTENSION_BUILD_OPTIONS,
            absWorkingDir: root,
            entryPoints: [path.join(root, ...entry.split('/'))],
            outfile: path.join(root, OUTPUT_FILE),
            plugins: [importGuard(root, guard)],
        });
        const code = result.outputFiles.find((file) => file.path.endsWith(OUTPUT_FILE))?.text;
        const map = result.outputFiles.find((file) => file.path.endsWith(`${OUTPUT_FILE}.map`))?.text;
        if (code === undefined) {
            return failure([
                createExtensionDiagnostic('EXTENSION_COMPILE_FAILED', { detail: 'no output produced' }),
            ]);
        }
        return {
            ok: true,
            compiled: map === undefined ? { code } : { code, map },
            inputs: Object.keys(result.metafile.inputs).sort(),
        };
    }
    catch (error) {
        if (isBuildFailure(error))
            return failure(error.errors.map(toDiagnostic));
        // Anything else means the esbuild service itself could not run (missing or blocked binary).
        const reason = error instanceof Error ? error.message : String(error);
        return failure([
            createExtensionDiagnostic('EXTENSION_COMPILE_FAILED', {
                detail: `esbuild failed to run (binary: ${binaryPath ?? 'default'}): ${reason}`,
            }),
        ]);
    }
}
/** Identifies the compiler and its fixed options; a mismatch means cached output is stale. */
export async function extensionCompilerFingerprint(sdkVersion) {
    const loaded = loadEsbuild();
    const version = loaded.ok ? loaded.esbuild.version : 'unavailable';
    const hash = createHash('sha256')
        .update(JSON.stringify({
        backend: COMPILE_BACKEND,
        esbuild: version,
        options: EXTENSION_BUILD_OPTIONS,
        sdkVersion,
    }))
        .digest('hex');
    return `esbuild-${version}:${hash.slice(0, 16)}`;
}
function importGuard(root, guard) {
    return {
        name: 'extension-import-guard',
        setup(build) {
            build.onResolve({ filter: /.*/ }, async (args) => {
                if (args.pluginData === NESTED_RESOLVE || args.kind === 'entry-point')
                    return undefined;
                if (SDK_SPECIFIERS.has(args.path) || guard.external?.has(args.path)) {
                    return { path: args.path, external: true };
                }
                const rejected = rejectSpecifier(root, args.path, args.resolveDir);
                if (rejected)
                    return forbidden(rejected);
                const resolved = await build.resolve(args.path, {
                    kind: args.kind,
                    importer: args.importer,
                    resolveDir: args.resolveDir,
                    pluginData: NESTED_RESOLVE,
                });
                if (resolved.errors.length > 0)
                    return { errors: resolved.errors };
                const checked = await checkResolved(root, args.path, resolved);
                if (guard.redirect && 'path' in checked && checked.path === guard.redirect.from) {
                    return { path: guard.redirect.to, external: true };
                }
                return checked;
            });
        },
    };
}
/** Re-checks esbuild's answer against the package root realpath (directory index, `.js` → `.ts`). */
async function checkResolved(root, specifier, resolved) {
    const real = resolved.external ? undefined : await realpathOrUndefined(resolved.path);
    if (real === undefined)
        return forbidden(`${specifier} is not a package file`);
    const rejected = rejectPath(root, specifier, real);
    return rejected ? forbidden(rejected) : { path: real };
}
/** Only package-relative specifiers may reach esbuild's resolver; returns why one is refused. */
function rejectSpecifier(root, specifier, resolveDir) {
    if (!isRelativeSpecifier(specifier)) {
        return `${specifier} is not an SDK specifier or a package-relative path`;
    }
    return rejectPath(root, specifier, path.resolve(resolveDir, specifier));
}
function rejectPath(root, specifier, target) {
    const relative = relativeInside(root, target);
    if (relative === undefined)
        return `${specifier} resolves outside the package`;
    if (isDigestExcludedPath(relative)) {
        return `${specifier} is a digest-excluded path; use \`import type\``;
    }
    return undefined;
}
async function realpathOrUndefined(target) {
    try {
        return await realpath(target);
    }
    catch {
        return undefined;
    }
}
function isRelativeSpecifier(specifier) {
    return (specifier === '.' ||
        specifier === '..' ||
        specifier.startsWith('./') ||
        specifier.startsWith('../'));
}
function relativeInside(root, target) {
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
        return undefined;
    return relative.split(path.sep).join('/');
}
function forbidden(text) {
    return { errors: [{ text, detail: { code: 'EXTENSION_IMPORT_FORBIDDEN' } }] };
}
function toDiagnostic(message) {
    const detail = message.detail;
    const tagged = detail && typeof detail === 'object' && 'code' in detail ? detail.code : undefined;
    const code = tagged === 'EXTENSION_IMPORT_FORBIDDEN'
        ? 'EXTENSION_IMPORT_FORBIDDEN'
        : 'EXTENSION_COMPILE_FAILED';
    const location = message.location;
    return createExtensionDiagnostic(code, {
        ...(location ? { file: location.file, line: location.line, column: location.column + 1 } : {}),
        detail: message.text,
    });
}
function failure(diagnostics) {
    return { ok: false, diagnostics };
}
function isBuildFailure(error) {
    return (error instanceof Error &&
        'errors' in error &&
        Array.isArray(error.errors));
}
//# sourceMappingURL=compile.js.map