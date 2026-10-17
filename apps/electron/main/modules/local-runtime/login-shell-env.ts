import { spawnSync } from "node:child_process";
import { delimiter } from "node:path";
const ENV_MARKER = '__MAVIS_LOGIN_SHELL_ENV_START__';
const LOGIN_SHELL_ENV_TIMEOUT_MS = 3000;
export function bootstrapLoginShellEnv(env = process.env) {
    if (!isLoginShellEnvBootstrapSupported(process.platform))
        return {};
    const shell = resolveLoginShell(env);
    if (!shell)
        return { error: 'No login shell configured.' };
    const probed = probeLoginShellEnv(shell, env);
    if (!probed.env)
        return probed;
    mergeLoginShellEnv(env, probed.env);
    return probed;
}
export function mergeLoginShellEnv(currentEnv, loginShellEnv) {
    for (const [key, value] of Object.entries(loginShellEnv)) {
        if (key === 'PATH' || key === 'Path')
            continue;
        if (currentEnv[key] !== undefined)
            continue;
        currentEnv[key] = value;
    }
    const pathKey = findPathKey(currentEnv);
    const loginPath = loginShellEnv.PATH || loginShellEnv.Path;
    if (loginPath) {
        currentEnv[pathKey] = mergePathEntries(currentEnv[pathKey], loginPath);
    }
}
export function mergePathEntries(currentPath, loginShellPath) {
    const currentEntries = splitPath(currentPath);
    const managedEntries = currentEntries.filter(isManagedMavisPathEntry);
    const unmanagedEntries = currentEntries.filter((entry) => !isManagedMavisPathEntry(entry));
    return uniquePathEntries([
        ...managedEntries,
        ...splitPath(loginShellPath),
        ...unmanagedEntries,
    ]).join(delimiter);
}
export function isLoginShellEnvBootstrapSupported(platform) {
    return platform !== 'win32';
}
export function loginShellProbeArgs(command) {
    return ['-ilc', command];
}
export function parseLoginShellEnvOutput(output) {
    const markerIndex = output.lastIndexOf(`${ENV_MARKER}\0`);
    if (markerIndex === -1)
        return {};
    const envPayload = output.slice(markerIndex + ENV_MARKER.length + 1);
    const parsed = {};
    for (const entry of envPayload.split('\0')) {
        if (!entry)
            continue;
        const equalsIndex = entry.indexOf('=');
        if (equalsIndex <= 0)
            continue;
        parsed[entry.slice(0, equalsIndex)] = entry.slice(equalsIndex + 1);
    }
    return parsed;
}
function probeLoginShellEnv(shell, env) {
    const command = `printf '${ENV_MARKER}\\0'; /usr/bin/env -0`;
    const result = spawnSync(shell, loginShellProbeArgs(command), {
        encoding: 'utf8',
        env: buildProbeEnv(env, shell),
        timeout: LOGIN_SHELL_ENV_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
    });
    if (result.error)
        return { error: result.error.message };
    if (result.status !== 0) {
        const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
        return { error: stderr || `Login shell exited with status ${result.status ?? 'unknown'}.` };
    }
    const parsed = parseLoginShellEnvOutput(result.stdout ?? '');
    return Object.keys(parsed).length > 0
        ? { env: parsed }
        : { error: 'Login shell did not report environment.' };
}
function buildProbeEnv(env, shell) {
    return {
        HOME: env.HOME,
        USER: env.USER,
        LOGNAME: env.LOGNAME ?? env.USER,
        SHELL: shell,
        PATH: env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
        TERM: env.TERM ?? 'xterm-256color',
    };
}
function resolveLoginShell(env) {
    const shell = env.SHELL?.trim();
    if (shell)
        return shell;
    return process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh';
}
function findPathKey(env) {
    return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
}
function splitPath(value) {
    return (value ?? '')
        .split(delimiter)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}
function uniquePathEntries(entries) {
    const seen = new Set();
    const unique = [];
    for (const entry of entries) {
        if (seen.has(entry))
            continue;
        seen.add(entry);
        unique.push(entry);
    }
    return unique;
}
function isManagedMavisPathEntry(entry) {
    return (entry.endsWith('/.pi/agent/bin') ||
        entry.endsWith('/.minimax/bin') ||
        entry.endsWith('/.mavis/bin'));
}
