import { win32 } from 'node:path';
import { parseAgentShellPreference } from './contracts.js';
export function parseResolvedAgentShell(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid Agent shell snapshot');
    const shell = value;
    const requestedPreference = parseAgentShellPreference(shell.requestedPreference);
    const executablePath = readExecutablePath(shell.executablePath);
    const version = readVersion(shell.version);
    if (shell.schemaVersion !== 1 ||
        !['pwsh', 'windows-powershell', 'git-bash'].includes(String(shell.family)) ||
        typeof shell.resolvedAt !== 'number' ||
        !Number.isSafeInteger(shell.resolvedAt)) {
        throw new Error('Invalid Agent shell snapshot');
    }
    return {
        schemaVersion: 1,
        requestedPreference,
        family: shell.family,
        executablePath,
        version,
        resolvedAt: shell.resolvedAt,
    };
}
function readExecutablePath(value) {
    if (typeof value !== 'string' || !win32.isAbsolute(value))
        throw new Error('Invalid Agent shell executable path');
    return value;
}
function readVersion(value) {
    if (typeof value !== 'string' || !/^\d+\.\d+/u.test(value))
        throw new Error('Invalid Agent shell version');
    return value;
}
//# sourceMappingURL=shell-snapshot.js.map