import { mkdir, lstat, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ComputerUseError } from './contracts.js';
/** One lock per OS account, deliberately independent of product/profile/owner. */
export function desktopLockRoot() {
    return path.join(homedir(), '.minimax-computer-use', 'locks');
}
export async function privateDirectory(directory) {
    await assertSafeAncestors(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertSafeAncestors(directory);
    const info = await lstat(directory);
    if (!info.isDirectory() ||
        info.isSymbolicLink() ||
        (process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))) {
        throw new ComputerUseError('computer_runtime_directory_unsafe', 'Runtime directory must be owned by the current user with mode 0700.');
    }
}
// Shared permission-evidence ancestors may be 0755, but may not be replaceable by another user.
// Never chmod an existing directory to make an unsafe installation appear safe.
async function assertSafeAncestors(directory) {
    const resolved = path.resolve(directory);
    const parent = path.dirname(resolved);
    if (parent !== resolved)
        await assertSafeAncestors(parent);
    try {
        const info = await lstat(resolved);
        if (!info.isDirectory() ||
            info.isSymbolicLink() ||
            (process.platform !== 'win32' &&
                ((info.uid !== process.getuid?.() && info.uid !== 0) || (info.mode & 0o022) !== 0))) {
            throw new ComputerUseError('computer_runtime_directory_unsafe', 'Runtime ancestors must be real directories owned by the current user or root and not group/world writable.');
        }
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
}
export async function acquireDesktopLock(root, ownerId) {
    await privateDirectory(root);
    const directory = path.join(root, 'control.lock');
    const token = randomUUID();
    try {
        await mkdir(directory, { mode: 0o700 });
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
        throw new ComputerUseError('computer_busy', 'Another control session owns the desktop, or prior cleanup is unconfirmed. Stop the prior owner and verify its daemon has exited before manually clearing its lock.');
    }
    // Even a crash before this write leaves a fail-closed lock. Never steal on age/PID alone.
    const ownerFile = path.join(directory, 'owner.json');
    const content = JSON.stringify({ token, pid: process.pid, ownerId, createdAt: Date.now() });
    await writeFile(ownerFile, content, { flag: 'wx', mode: 0o600 });
    let released = false;
    return {
        async release() {
            if (released)
                return;
            if ((await readFile(ownerFile, 'utf8')) !== content) {
                throw new ComputerUseError('computer_lock_ownership_lost', 'Desktop lock ownership changed; cleanup was refused.');
            }
            await unlink(ownerFile);
            await rmdir(directory);
            released = true;
        },
    };
}
//# sourceMappingURL=desktop-lock.js.map