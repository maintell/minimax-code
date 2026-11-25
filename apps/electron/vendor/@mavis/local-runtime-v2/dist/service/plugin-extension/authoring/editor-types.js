import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { getBuiltinSkillsDirCandidates } from '../../skill/index.js';
import { EXTENSION_JSX_IMPORT_SOURCE } from '../contracts.js';
import { editorTypesPathStat, writeEditorTypeFiles } from './editor-types-files.js';
const SDK = EXTENSION_JSX_IMPORT_SOURCE;
/** `<package>/.minimax-plugin/types/`: host-managed, excluded from digest, snapshot and install. */
const EDITOR_TYPES_DIR = '.minimax-plugin/types';
/** Type package name under the generated `typeRoots`; holds the ambient SDK modules. */
const TYPE_PACKAGE = 'mcode-plugin-extension';
const API_ASSET = ['extension-creator', 'references', 'api'];
const API_FILE = 'mcode-plugin-extension.ts';
/** The leading `//` comment block of the skill asset; the declarations follow it. */
const ASSET_HEADER = /^(?:\/\/[^\n]*\n)+\n*/u;
/** The generated compiler options; the author's root `tsconfig.json` only extends them. */
const GENERATED_TSCONFIG = {
    compilerOptions: {
        target: 'es2022',
        module: 'esnext',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        jsx: 'react-jsx',
        jsxImportSource: SDK,
        typeRoots: ['.'],
        types: [TYPE_PACKAGE],
    },
    include: ['../../hooks/**/*'],
};
const ROOT_TSCONFIG = { extends: `./${EDITOR_TYPES_DIR}/tsconfig.json` };
/** Exact bytes emitted by the retired type-stub.ts, not a general config migration. */
const LEGACY_ROOT_TSCONFIG = `${JSON.stringify({
    compilerOptions: {
        target: 'es2022',
        module: 'esnext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        jsxImportSource: SDK,
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: [],
    },
    include: ['hooks/**/*'],
}, null, 2)}\n`;
let loaded;
let seededSkillsDir;
/**
 * The directory the runtime seeds built-in skills into (`<dataDir>/.builtin-skills`): plain files
 * on disk, the same copy the agent reads. Set once at service start; clears the cached types.
 */
export function setSeededBuiltinSkillsDir(directory) {
    if (directory === seededSkillsDir)
        return;
    seededSkillsDir = directory;
    loaded = undefined;
}
/**
 * Writes `.minimax-plugin/types/` (ignore-all `.gitignore`, the generated `tsconfig.json` and the
 * SDK declarations) where its content differs, and a root `tsconfig.json` that extends it when the
 * package has none (or still has the exact historical host template). Rejects unsafe generated
 * paths before writing. Returns the package-relative files it wrote.
 */
export async function writeEditorTypes(packageDir) {
    const types = await sdkEditorTypes();
    const files = {
        [`${EDITOR_TYPES_DIR}/.gitignore`]: '*\n',
        [`${EDITOR_TYPES_DIR}/tsconfig.json`]: `${JSON.stringify(GENERATED_TSCONFIG, null, 2)}\n`,
        [`${EDITOR_TYPES_DIR}/${TYPE_PACKAGE}/index.d.ts`]: [
            `// Editor types of ${SDK} ${types.version}, written by the host on \`init\` and`,
            '// `preview`. Regenerated; do not edit.',
            types.declarations,
        ].join('\n'),
    };
    return writeEditorTypeFiles(packageDir, files, {
        current: `${JSON.stringify(ROOT_TSCONFIG, null, 2)}\n`,
        legacy: LEGACY_ROOT_TSCONFIG,
    });
}
/**
 * After a preview went live: refreshes the editor types of its source directory, never of a
 * package under `installedRoot` (`<dataDir>/plugins/`), which keeps the bytes the user installed.
 */
export async function refreshPreviewEditorTypes(sourceDir, installedRoot) {
    const source = await realpath(sourceDir);
    const installed = await installedRootPath(path.resolve(installedRoot));
    if (inside(installed, source) || inside(path.resolve(installedRoot), path.resolve(sourceDir)))
        return;
    await writeEditorTypes(source);
}
function inside(root, directory) {
    const relative = path.relative(root, directory);
    return !path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..';
}
/** Resolve existing ancestors too; only genuinely absent installed directories are legitimate. */
async function installedRootPath(directory) {
    try {
        const resolved = await realpath(directory);
        if (!(await editorTypesPathStat(resolved))?.isDirectory()) {
            throw new Error('Installed plugins root must be a directory');
        }
        return resolved;
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        if (await editorTypesPathStat(directory))
            throw error; // e.g. a dangling installed-root link
        const parent = path.dirname(directory);
        if (parent === directory)
            throw error;
        return path.join(await installedRootPath(parent), path.basename(directory));
    }
}
/** The SDK declarations the editor types carry, read once per process. */
async function sdkEditorTypes() {
    loaded ??= readSdkEditorTypes();
    try {
        return await loaded;
    }
    catch (error) {
        loaded = undefined;
        throw error;
    }
}
/** SDK version of the declaration asset; `unknown` when it cannot be found. */
export async function readSdkPackageVersion() {
    const assets = declarationAssetDir();
    if (assets === undefined)
        return 'unknown';
    try {
        return (await readFile(path.join(assets, 'VERSION'), 'utf8')).trim();
    }
    catch {
        return 'unknown';
    }
}
/**
 * The runtime build bundles its author surfaces into the skill's plain `.ts` declaration asset.
 * Electron packaging drops `.d.ts`; nothing is compiled at runtime.
 */
async function readSdkEditorTypes() {
    const assets = declarationAssetDir();
    if (assets === undefined) {
        throw new Error(`SDK declarations unavailable: no ${API_ASSET.join('/')}/VERSION under ${assetRoots().join(', ')}`);
    }
    const [version, text] = await Promise.all([
        readFile(path.join(assets, 'VERSION'), 'utf8'),
        readFile(path.join(assets, API_FILE), 'utf8'),
    ]);
    const declarations = text.replace(ASSET_HEADER, '');
    if (!declarations.includes(`declare module '${SDK}' {`)) {
        throw new Error(`The SDK declarations at ${path.join(assets, API_FILE)} are not a bundle`);
    }
    return { version: version.trim(), declarations };
}
function assetRoots() {
    return [seededSkillsDir, ...getBuiltinSkillsDirCandidates()].filter((root) => root !== undefined);
}
/**
 * First declaration asset directory that exists: the seeded copy, then the bundled asset
 * candidates. Checked with `existsSync` on `VERSION` — a packaged app may still bundle the assets
 * inside the asar, where directory checks through `access()` misreport.
 */
function declarationAssetDir() {
    for (const root of assetRoots()) {
        const assets = path.join(root, ...API_ASSET);
        if (existsSync(path.join(assets, 'VERSION')))
            return assets;
    }
    return undefined;
}
//# sourceMappingURL=editor-types.js.map