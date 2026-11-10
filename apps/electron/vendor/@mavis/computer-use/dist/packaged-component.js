import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { assertNoSymlink, componentInstallRoot, CUA_VERSION, discoverComponent, resolveProfileDataDir, } from './component.js';
import { ComputerUseError, record } from './contracts.js';
import { privateDirectory } from './desktop-lock.js';
const releasePrefix = 'minimax-cu-release-v1.';
function releaseDigest(token, target) {
    try {
        if (!token.startsWith(releasePrefix))
            throw new Error();
        const encoded = token.slice(releasePrefix.length);
        if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > 2048)
            throw new Error();
        const bytes = Buffer.from(encoded, 'base64url');
        if (bytes.toString('base64url') !== encoded)
            throw new Error();
        const digests = record(JSON.parse(bytes.toString('utf8')));
        if (!digests ||
            !Object.keys(digests).length ||
            Object.entries(digests).some(([key, value]) => !/^(darwin|win32)-(arm64|x64)$/.test(key) ||
                typeof value !== 'string' ||
                !/^[a-f0-9]{64}$/.test(value)) ||
            !Object.hasOwn(digests, target))
            throw new Error();
        const canonical = Object.fromEntries(Object.keys(digests)
            .sort()
            .map((key) => [key, digests[key]]));
        if (JSON.stringify(canonical) !== bytes.toString('utf8'))
            throw new Error();
        return digests[target];
    }
    catch {
        throw new ComputerUseError('computer_component_untrusted', 'The host has no trusted packaged Computer Use release for this platform/architecture. Install a matching signed product build.');
    }
}
/** Host-owned paths and a build-injected release token only; no runtime trust-file discovery. */
export async function prepareInstalledPackagedComponent(input) {
    const platform = input.platform ?? process.platform;
    const arch = input.arch ?? process.arch;
    const target = `${platform}-${arch}`;
    if (!/^(darwin|win32)-(arm64|x64)$/.test(target)) {
        throw new ComputerUseError('computer_platform_unsupported', 'Computer Use requires macOS or Windows on arm64/x64.');
    }
    const manifestSha256 = releaseDigest(input.releaseToken, target);
    if (!path.isAbsolute(input.dataDir) || !path.isAbsolute(input.packagedRoot)) {
        throw new ComputerUseError('computer_component_invalid', 'Component and profile roots must be absolute host-owned paths.');
    }
    const dataDir = await resolveProfileDataDir(input.dataDir);
    const source = path.join(input.packagedRoot, CUA_VERSION, target);
    const verify = async (root) => {
        await discoverComponent({
            dataDir,
            platform,
            arch,
            trustedInstalledComponent: { root, manifestSha256 },
        });
    };
    // Even a cached installation must correspond to the complete, verified product resources.
    try {
        await verify(source);
    }
    catch (error) {
        if (error.code === 'ENOENT' ||
            (error instanceof ComputerUseError && error.code === 'computer_component_missing')) {
            throw new ComputerUseError('computer_component_missing', 'Packaged Computer Use resources are missing. Install a complete signed product build; development builds must prepare reviewed component resources.');
        }
        throw error;
    }
    const parent = componentInstallRoot(dataDir, platform, arch);
    await privateDirectory(parent);
    const root = path.join(parent, manifestSha256);
    const trusted = { root, manifestSha256 };
    if (await exists(root)) {
        await privateDirectory(root);
        await verify(root);
        return trusted;
    }
    const staging = await mkdtemp(path.join(parent, '.install-'));
    try {
        await copyTree(source, staging);
        await verify(staging);
        // Renaming a complete nonempty directory is atomic. A concurrent winner's nonempty
        // directory cannot be replaced by rename on macOS or Windows; never remove it.
        try {
            if (await exists(root)) {
                await privateDirectory(root);
                await verify(root);
                return trusted;
            }
            await rename(staging, root);
        }
        catch (error) {
            if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code ?? ''))
                throw error;
            if (!(await exists(root)))
                throw error;
            await privateDirectory(root);
            await verify(root);
        }
        return trusted;
    }
    finally {
        // Only this invocation's staging directory is disposable; installed versions coexist.
        await rm(staging, { recursive: true, force: true });
    }
}
async function exists(file) {
    try {
        await lstat(file);
        return true;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
}
async function copyTree(source, destination) {
    for (const entry of await readdir(source)) {
        const from = path.join(source, entry);
        const to = path.join(destination, entry);
        await assertNoSymlink(from);
        const info = await lstat(from);
        if (info.isDirectory()) {
            await mkdir(to, { mode: 0o700 });
            await copyTree(from, to);
        }
        else if (info.isFile()) {
            await copyFile(from, to, constants.COPYFILE_EXCL);
            await chmod(to, (info.mode & 0o111) !== 0 ? 0o700 : 0o600);
        }
        else {
            throw new ComputerUseError('computer_component_invalid', 'Unexpected component file type during installation.');
        }
    }
}
//# sourceMappingURL=packaged-component.js.map