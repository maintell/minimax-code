import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveAuthLeaseEndpoint } from '@mavis/oauth-lease-protocol';
// Leave room for the terminating NUL in sockaddr_un.sun_path.
function unixSocketByteLimit(platform) {
    return platform === 'linux' ? 107 : 103;
}
export async function allocateBrokerEndpoint(dataDir, platform = process.platform) {
    const original = resolveAuthLeaseEndpoint(dataDir, platform);
    const limit = unixSocketByteLimit(platform);
    if (original.transport === 'pipe' || Buffer.byteLength(original.endpoint, 'utf8') <= limit) {
        return { ...original, cleanup: async () => undefined };
    }
    // POSIX paths are case-sensitive. The hash namespaces profiles; the random
    // capability (not this hash) remains the authentication secret.
    const digest = createHash('sha256')
        .update(`${process.getuid?.() ?? 'user'}\0${path.dirname(path.dirname(original.endpoint))}`)
        .digest('hex')
        .slice(0, 16);
    const prefix = `mcl-${digest}-`;
    const socketName = path.basename(original.endpoint);
    const capabilityName = path.basename(original.capabilityFile);
    let lastError;
    for (const root of new Set([tmpdir(), '/tmp'])) {
        const candidate = path.join(root, `${prefix}XXXXXX`, socketName);
        if (!path.isAbsolute(root) || Buffer.byteLength(candidate, 'utf8') > limit)
            continue;
        let directory;
        try {
            // mkdtemp exclusively creates a private instance directory. Never chmod
            // or unlink a shared temp root or another broker's files.
            directory = await mkdtemp(path.join(root, prefix));
            await chmod(directory, 0o700);
        }
        catch (error) {
            if (directory)
                await rm(directory, { recursive: true, force: true });
            lastError = error;
            continue;
        }
        const ownedDirectory = directory;
        return {
            transport: 'unix',
            endpoint: path.join(ownedDirectory, socketName),
            capabilityFile: path.join(ownedDirectory, capabilityName),
            cleanup: () => rm(ownedDirectory, { recursive: true, force: true }),
        };
    }
    throw new Error('Unable to allocate a private directory for the OAuth lease socket.', {
        cause: lastError,
    });
}
//# sourceMappingURL=broker-endpoint.js.map