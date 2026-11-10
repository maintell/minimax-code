import { readFile } from "node:fs/promises";
import { join } from "node:path";
export function parseSshCliInstallTarget(value) {
    if (!record(value) ||
        value.schemaVersion !== 1 ||
        value.enabled !== true ||
        !record(value.target)) {
        throw new Error('SSH installer target is not configured.');
    }
    const target = value.target;
    const installer = target.installer;
    if (!record(installer) || !record(installer.environment))
        throw new Error('Invalid SSH installer contract.');
    const internal = target.packageName === '@minimax/code';
    if ((!internal && target.packageName !== '@minimax-ai/code') ||
        target.registry !==
            (internal ? 'https://npmmirror.xaminim.com/' : 'https://registry.npmjs.org/') ||
        typeof target.version !== 'string' ||
        !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(target.version) ||
        typeof target.integrity !== 'string' ||
        !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(target.integrity) ||
        typeof target.launcherRelativePath !== 'string' ||
        !/^[.A-Za-z0-9_-]+(?:\/[.A-Za-z0-9_-]+)+$/u.test(target.launcherRelativePath) ||
        target.launcherRelativePath.split('/').some((part) => part === '.' || part === '..')) {
        throw new Error('Invalid SSH MCode package identity.');
    }
    const url = new URL(String(installer.url));
    if (url.protocol !== 'https:' ||
        url.hostname !== 'filecdn.minimax.chat' ||
        url.username ||
        url.password ||
        url.port ||
        url.search ||
        url.hash ||
        typeof installer.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(installer.sha256) ||
        typeof installer.repairValue !== 'string' ||
        !/^[0-9A-Za-z_-]{1,32}$/u.test(installer.repairValue))
        throw new Error('Invalid SSH installer source.');
    const environment = installer.environment;
    const keys = ['packageName', 'version', 'registry', 'integrity', 'repair'];
    const names = keys.map((key) => environment[key]);
    if (names.some((name) => typeof name !== 'string' || !/^MCODE_[A-Z0-9_]{1,64}$/u.test(name)) ||
        new Set(names).size !== keys.length)
        throw new Error('Invalid SSH installer parameter mapping.');
    return {
        packageName: internal ? '@minimax/code' : '@minimax-ai/code',
        version: target.version,
        registry: target.registry,
        integrity: target.integrity,
        launcherRelativePath: target.launcherRelativePath,
        installer: {
            url: url.href,
            sha256: installer.sha256,
            repairValue: installer.repairValue,
            environment: Object.fromEntries(keys.map((key) => [key, environment[key]])),
        },
    };
}
/** An exact release can override the existing official installer; it is not a prerequisite. */
export async function resolveSshCliInstallTarget() {
    const { app } = await import('electron');
    const file = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'resources', 'ssh-mcode-release.json');
    let configuration;
    try {
        configuration = JSON.parse(await readFile(file, 'utf8'));
    }
    catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
            return null;
        throw error;
    }
    return resolveSshCliInstallConfiguration(configuration);
}
export function resolveSshCliInstallConfiguration(configuration) {
    if (record(configuration) &&
        configuration.schemaVersion === 1 &&
        configuration.enabled !== true &&
        (configuration.mode === 'official' || configuration.enabled === false))
        return null;
    // A malformed explicitly configured release must not silently select a different package.
    return parseSshCliInstallTarget(configuration);
}
function record(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
