import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { ComputerUseError, record } from './contracts.js';
export const CUA_VERSION = '0.34.1';
export const CUA_BUNDLE_ID = 'com.minimax.computer-use';
// Populated only by a reviewed release change after signed platform acceptance.
// An on-disk manifest cannot declare its own provenance.
const releasedManifestDigests = {};
export function componentInstallRoot(dataDir, platform = process.platform, arch = process.arch) {
    return path.join(dataDir, 'computer-use', 'components', CUA_VERSION, `${platform}-${arch}`);
}
export async function discoverComponent(input) {
    const platform = input.platform ?? process.platform;
    const arch = input.arch ?? process.arch;
    if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
        throw new ComputerUseError('computer_platform_unsupported', 'Computer Use requires macOS or Windows on arm64/x64.');
    }
    const root = input.trustedInstalledComponent?.root ?? componentInstallRoot(input.dataDir, platform, arch);
    if (!path.isAbsolute(root))
        throw invalid('Component root must be absolute.');
    await assertNoSymlink(root);
    let bytes;
    try {
        await assertNoSymlink(path.join(root, 'component.json'));
        bytes = await readFile(path.join(root, 'component.json'));
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        throw new ComputerUseError('computer_component_missing', 'Prepare the matching MiniMax Computer Use 0.34.1 component through the trusted installer.');
    }
    const expected = input.trustedInstalledComponent?.manifestSha256 ??
        releasedManifestDigests[`${platform}-${arch}`];
    if (!expected || digest(bytes) !== expected) {
        throw new ComputerUseError('computer_component_untrusted', 'No trusted matching release manifest. Use a reviewed signed release or explicit trustedInstalledComponent for local preparation.');
    }
    if (bytes.length > 1_048_576)
        throw invalid('Component manifest is too large.');
    const value = JSON.parse(bytes.toString('utf8'));
    const manifest = validateManifest(value, platform, arch);
    const listed = new Set(Object.keys(manifest.files));
    const actual = await inventory(root);
    if (actual.filter((entry) => entry !== 'component.json').some((entry) => !listed.has(entry))) {
        throw invalid('Component contains unlisted files.');
    }
    for (const [relative, expectedHash] of Object.entries(manifest.files)) {
        const file = componentPath(root, relative);
        await assertNoSymlink(file);
        const stat = await lstat(file);
        if (!stat.isFile() || (platform !== 'win32' && (stat.mode & 0o022) !== 0)) {
            throw invalid('Component files must be regular and not group/world writable.');
        }
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(file))
            hash.update(chunk);
        if (hash.digest('hex') !== expectedHash)
            throw invalid('Component file hash mismatch.');
    }
    return {
        root: await realpath(root),
        manifest,
        executable: componentPath(root, manifest.executablePath),
        appBundle: manifest.appBundlePath ? componentPath(root, manifest.appBundlePath) : undefined,
    };
}
export function validateManifest(value, platform, arch) {
    const m = record(value);
    const executable = platform === 'darwin'
        ? 'MiniMax Computer Use.app/Contents/MacOS/minimax-computer-use'
        : 'minimax-computer-use.exe';
    const files = record(m?.files);
    if (!m ||
        m.schemaVersion !== 1 ||
        m.version !== CUA_VERSION ||
        m.brandRevision !== 1 ||
        m.platform !== platform ||
        m.arch !== arch ||
        m.bundleId !== CUA_BUNDLE_ID ||
        m.updateSource !== 'minimax-managed' ||
        m.executablePath !== executable ||
        (platform === 'darwin' && m.appBundlePath !== 'MiniMax Computer Use.app') ||
        !files ||
        !Object.keys(files).length ||
        typeof m.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(m.sha256) ||
        files[executable] !== m.sha256 ||
        Object.entries(files).some(([file, hash]) => !safeRelative(file) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) {
        throw invalid('Expected the exact MiniMax Computer Use 0.34.1 platform/architecture/brand manifest.');
    }
    return m;
}
function safeRelative(value) {
    return (!!value &&
        !value.includes('\\') &&
        !value.includes(':') &&
        !path.isAbsolute(value) &&
        value.split('/').every((part) => part !== '.' && part !== '..' && !!part));
}
function componentPath(root, relative) {
    if (!safeRelative(relative))
        throw invalid('Component path escapes its root.');
    return path.join(root, ...relative.split('/'));
}
export async function assertNoSymlink(file) {
    const resolved = path.resolve(file);
    const parent = path.dirname(resolved);
    if (parent !== resolved)
        await assertNoSymlink(parent);
    try {
        const info = await lstat(resolved);
        if (info.isSymbolicLink())
            throw invalid('Symbolic links are not allowed in component/runtime paths.');
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
}
async function inventory(root, prefix = '') {
    const result = [];
    for (const item of await readdir(path.join(root, prefix), { withFileTypes: true })) {
        if (item.isSymbolicLink())
            throw invalid('Symbolic links are not allowed in components.');
        const relative = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.isDirectory())
            result.push(...(await inventory(root, relative)));
        else if (item.isFile())
            result.push(relative);
        else
            throw invalid('Unexpected component file type.');
    }
    return result;
}
export function digest(value) {
    return createHash('sha256').update(value).digest('hex');
}
function invalid(message) {
    return new ComputerUseError('computer_component_invalid', message);
}
//# sourceMappingURL=component.js.map