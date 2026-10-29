import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { assertNoSymlink, CUA_VERSION, digest } from './component.js';
import { ComputerUseError } from './contracts.js';
/** Includes the signature, provisioning profile, helpers and internal symlink targets. */
export async function fingerprintDevelopmentApp(appBundle) {
    if (!path.isAbsolute(appBundle) || path.basename(appBundle) !== 'CuaDriver.app') {
        throw invalid('Expected an absolute upstream CuaDriver.app path.');
    }
    await assertNoSymlink(appBundle);
    const root = await realpath(appBundle);
    const entries = [];
    async function visit(relative) {
        const file = path.join(root, relative);
        const stat = await lstat(file);
        if (stat.uid !== process.getuid?.() && stat.uid !== 0) {
            throw invalid('Development App must be owned by the current user or root.');
        }
        if (!stat.isSymbolicLink() && (stat.mode & 0o022) !== 0) {
            throw invalid('Development App must not be group/world writable.');
        }
        if (stat.isDirectory()) {
            entries.push([relative, 'directory', String(stat.mode & 0o777)]);
            for (const name of (await readdir(file)).sort()) {
                await visit(relative ? `${relative}/${name}` : name);
            }
        }
        else if (stat.isFile()) {
            const hash = createHash('sha256');
            for await (const chunk of createReadStream(file))
                hash.update(chunk);
            entries.push([relative, `file:${stat.mode & 0o777}`, hash.digest('hex')]);
        }
        else if (stat.isSymbolicLink()) {
            const target = await readlink(file);
            const resolved = path.relative(root, await realpath(file));
            if (path.isAbsolute(target) ||
                path.isAbsolute(resolved) ||
                resolved === '..' ||
                resolved.startsWith(`..${path.sep}`)) {
                throw invalid('Development App link escapes its bundle.');
            }
            entries.push([relative, 'symlink', target]);
        }
        else {
            throw invalid('Unsupported development App resource.');
        }
    }
    await visit('');
    return digest(JSON.stringify(entries));
}
/** No native load or OS authorization; checks the exact App selected at build time. */
export async function resolveDevelopmentComponent(input) {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
        throw invalid('The upstream development component is currently macOS arm64 only.');
    }
    if (!input || typeof input.appBundle !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256)) {
        throw invalid('Missing build-embedded development App identity.');
    }
    if ((await fingerprintDevelopmentApp(input.appBundle)) !== input.sha256) {
        throw invalid('Development App changed since preparation. Prepare it again from the pinned archive.');
    }
    return {
        root: path.dirname(input.appBundle),
        appBundle: input.appBundle,
        executable: path.join(input.appBundle, 'Contents', 'MacOS', 'cua-driver'),
        manifest: { version: CUA_VERSION, bundleId: 'com.trycua.driver' },
    };
}
function invalid(message) {
    return new ComputerUseError('computer_development_component_invalid', message);
}
//# sourceMappingURL=development-component.js.map