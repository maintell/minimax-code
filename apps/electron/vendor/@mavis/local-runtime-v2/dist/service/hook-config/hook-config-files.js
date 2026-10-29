import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { canonicalProjectWorkspaceDir } from '../session-system/index.js';
import { HookConfigError } from './errors.js';
import { MAX_HOOK_CONFIG_BYTES } from './hook-config-document.js';
const USER_HOOK_CONFIG_FILE = 'hooks.json';
const PROJECT_HOOK_CONFIG_DIR = '.minimax';
export function userHookLocation(dataDir) {
    const root = path.resolve(dataDir);
    return {
        scope: 'user',
        root,
        configDir: root,
        configPath: path.join(root, USER_HOOK_CONFIG_FILE),
        hookDataDir: path.join(root, 'v2', 'hook-data', 'user'),
    };
}
export async function projectHookLocation(dataDir, workspaceDir, parentRepoDir) {
    if (!workspaceDir || !path.isAbsolute(workspaceDir))
        invalidProjectDir();
    let root;
    try {
        root = await realpath(workspaceDir);
        if (!(await stat(root)).isDirectory())
            invalidProjectDir();
    }
    catch (error) {
        if (error instanceof HookConfigError)
            throw error;
        invalidProjectDir();
    }
    const parent = parentRepoDir ? await realpathOrResolved(parentRepoDir) : undefined;
    const projectKey = canonicalProjectWorkspaceDir(root, parent ? { parentRepoDir: parent } : undefined) ?? root;
    const projectHash = createHash('sha256').update(projectKey).digest('hex').slice(0, 12);
    const configDir = path.join(root, PROJECT_HOOK_CONFIG_DIR);
    return {
        scope: 'project',
        root,
        configDir,
        configPath: path.join(configDir, USER_HOOK_CONFIG_FILE),
        hookDataDir: path.join(path.resolve(dataDir), 'v2', 'hook-data', 'projects', projectHash),
        projectKey,
        projectHash,
    };
}
/** Read-only: a symlink that leaves the scope root is reported, never followed. */
export async function readHookConfigFile(location) {
    let target;
    try {
        target = await realpath(location.configPath);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return { kind: 'missing' };
        return { kind: 'unreadable', message: 'hooks.json cannot be read.' };
    }
    try {
        if (!isInside(await realpath(location.root), target)) {
            return { kind: 'unreadable', message: 'hooks.json must stay inside its directory.' };
        }
        const file = await open(target, constants.O_RDONLY | constants.O_NONBLOCK);
        try {
            const info = await file.stat();
            if (!info.isFile())
                return { kind: 'unreadable', message: 'hooks.json is not a file.' };
            if (info.size > MAX_HOOK_CONFIG_BYTES) {
                return { kind: 'unreadable', message: 'hooks.json exceeds the 256 KiB limit.' };
            }
            const buffer = Buffer.alloc(MAX_HOOK_CONFIG_BYTES + 1);
            const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
            if (bytesRead > MAX_HOOK_CONFIG_BYTES) {
                return { kind: 'unreadable', message: 'hooks.json exceeds the 256 KiB limit.' };
            }
            const bytes = buffer.subarray(0, bytesRead);
            return {
                kind: 'file',
                text: bytes.toString('utf8'),
                revision: hookConfigRevision(bytes),
                fingerprint: `${info.ino}:${info.size}:${info.mtimeMs}`,
            };
        }
        finally {
            await file.close();
        }
    }
    catch {
        return { kind: 'unreadable', message: 'hooks.json cannot be read.' };
    }
}
/** Cheap metadata probe used to skip re-reading an unchanged file. */
export async function probeHookConfigFile(location) {
    try {
        const info = await stat(location.configPath);
        return `${info.ino}:${info.size}:${info.mtimeMs}`;
    }
    catch {
        return undefined;
    }
}
function hookConfigRevision(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
export async function writeHookConfigFile(location, content) {
    const root = await realpath(location.root);
    await mkdir(location.configDir, {
        recursive: true,
        ...(location.scope === 'user' ? { mode: 0o700 } : {}),
    });
    const directory = await realpath(location.configDir);
    if (!isInside(root, directory))
        invalidProjectDir();
    try {
        if (!isInside(root, await realpath(location.configPath)))
            invalidProjectDir();
    }
    catch (error) {
        if (error instanceof HookConfigError)
            throw error;
        if (error.code !== 'ENOENT')
            throw error;
    }
    const destination = path.join(directory, path.basename(location.configPath));
    await replaceFileAtomically(destination, content, location.scope === 'user' ? 0o600 : 0o644);
}
export async function writeAtomicPrivateFile(filePath, content) {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await replaceFileAtomically(filePath, content, 0o600);
}
async function replaceFileAtomically(destination, content, mode) {
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
        const handle = await open(temporary, 'wx', mode);
        try {
            await handle.writeFile(content, 'utf8');
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await rename(temporary, destination);
    }
    catch (error) {
        try {
            await rm(temporary, { force: true });
        }
        catch {
            /* Report the write failure, not the cleanup failure. */
        }
        throw error;
    }
}
async function realpathOrResolved(target) {
    try {
        return await realpath(target);
    }
    catch {
        return path.resolve(target);
    }
}
export function hookSettingsDirectory(dataDir) {
    return path.join(path.resolve(dataDir), 'hook-settings');
}
/** Serializes config and enablement writes across runtimes sharing one dataDir. */
export async function withHookSettingsLock(dataDir, operation) {
    const directory = hookSettingsDirectory(dataDir);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let release;
    try {
        release = await lockfile.lock(directory, {
            stale: 10_000,
            retries: { retries: 100, factor: 1, minTimeout: 50, maxTimeout: 50 },
        });
        return await operation();
    }
    finally {
        try {
            await release?.();
        }
        catch {
            /* Preserve the operation outcome if lock cleanup fails. */
        }
    }
}
function isInside(root, target) {
    const child = path.relative(root, target);
    return (child === '' ||
        (!path.isAbsolute(child) && child !== '..' && !child.startsWith(`..${path.sep}`)));
}
function invalidProjectDir() {
    throw new HookConfigError('LOCAL_HOOK_PROJECT_DIR_INVALID', 'Project directory is invalid or its .minimax directory leaves the project.');
}
//# sourceMappingURL=hook-config-files.js.map