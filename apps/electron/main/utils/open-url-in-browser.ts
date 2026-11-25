import { execFile, spawn } from "node:child_process";
import { existsSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const MAC_APPS = {
    chrome: 'Google Chrome.app',
    edge: 'Microsoft Edge.app',
};
const WINDOWS_EXES = {
    chrome: { exe: 'chrome.exe', dir: ['Google', 'Chrome', 'Application'] },
    edge: { exe: 'msedge.exe', dir: ['Microsoft', 'Edge', 'Application'] },
};
const PROCESS_TIMEOUT_MS = 5000;
export function isNamedBrowser(value) {
    return value === 'chrome' || value === 'edge';
}
/**
 * Opens an https URL in one named browser. A missing browser is reported, never replaced by
 * another browser, so the caller can ask the user to install it.
 */
export async function openUrlInBrowser(rawUrl, browser, deps = defaultDeps()) {
    const url = httpsUrl(rawUrl);
    if (!url || !isNamedBrowser(browser))
        return { success: false, errorCode: 'invalid_request' };
    try {
        if (deps.platform === 'darwin') {
            const app = macApp(browser, deps);
            if (!app)
                return { success: false, errorCode: 'browser_not_installed' };
            await deps.run('open', ['-a', app, url]);
            return { success: true };
        }
        if (deps.platform === 'win32') {
            const exe = await windowsExe(browser, deps);
            if (!exe)
                return { success: false, errorCode: 'browser_not_installed' };
            await deps.launch(exe, [url]);
            return { success: true };
        }
    }
    catch {
        return { success: false, errorCode: 'open_failed' };
    }
    // Other platforms are outside the supported Desktop browser targets.
    return { success: false, errorCode: 'browser_not_installed' };
}
/** Where the named browser is installed (macOS app bundle, Windows exe), or undefined. */
export async function locateNamedBrowser(browser, deps = defaultDeps()) {
    if (deps.platform === 'darwin')
        return macApp(browser, deps);
    if (deps.platform === 'win32')
        return windowsExe(browser, deps);
    return undefined;
}
/** Starts (or raises) the named browser without opening a page. */
export async function launchNamedBrowser(browser, deps = defaultDeps()) {
    try {
        const target = await locateNamedBrowser(browser, deps);
        if (!target)
            return { success: false, errorCode: 'browser_not_installed' };
        if (deps.platform === 'darwin')
            await deps.run('open', ['-a', target]);
        else
            await deps.launch(target, []);
        return { success: true };
    }
    catch {
        return { success: false, errorCode: 'open_failed' };
    }
}
function httpsUrl(value) {
    if (typeof value !== 'string' || value.length > 2048)
        return undefined;
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password)
            return undefined;
        return url.href;
    }
    catch {
        return undefined;
    }
}
function macApp(browser, deps) {
    const name = MAC_APPS[browser];
    return [
        path.posix.join('/Applications', name),
        path.posix.join(deps.homedir, 'Applications', name),
    ].find((candidate) => deps.exists(candidate));
}
/** App Paths registration first, then the default per-machine and per-user install folders. */
async function windowsExe(browser, deps) {
    const { exe, dir } = WINDOWS_EXES[browser];
    for (const root of ['HKCU', 'HKLM']) {
        const value = await deps.readRegistryDefault(`${root}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`);
        const candidate = value
            ? expandEnvVars(value.trim().replace(/^"|"$/gu, ''), deps.env)
            : undefined;
        if (candidate && deps.exists(candidate))
            return candidate;
    }
    const bases = [
        deps.env.ProgramFiles,
        deps.env['ProgramFiles(x86)'],
        deps.env.LOCALAPPDATA ?? path.win32.join(deps.homedir, 'AppData', 'Local'),
    ].filter((base) => Boolean(base));
    return bases
        .map((base) => path.win32.join(base, ...dir, exe))
        .find((candidate) => deps.exists(candidate));
}
/**
 * `reg export` writes UTF-16LE, while `reg query` prints in the console code
 * page and garbles a non-ASCII path. Read the export file instead.
 */
export function parseRegExportDefault(text) {
    const clean = text.replace(/^\uFEFF/u, '');
    const quoted = /^@="((?:[^"\\]|\\.)*)"\s*$/mu.exec(clean);
    if (quoted)
        return quoted[1].replace(/\\(.)/gu, '$1');
    return parseRegExportHex(clean);
}
/**
 * A REG_EXPAND_SZ default is exported as `hex(2)`: UTF-16LE bytes that reg.exe wraps over
 * several lines, every continuation ending with a backslash. Decode them back to the value.
 */
function parseRegExportHex(text) {
    const joined = text.replace(/\\\r?\n[ \t]*/gu, '');
    const match = /^@=hex\(2\):([0-9a-f,]*)$/imu.exec(joined);
    if (!match)
        return undefined;
    const bytes = [];
    for (const part of match[1].split(',')) {
        const byte = Number.parseInt(part.trim(), 16);
        if (!Number.isInteger(byte) || byte < 0 || byte > 0xff)
            return undefined;
        bytes.push(byte);
    }
    const even = bytes.length - (bytes.length % 2);
    return Buffer.from(bytes.slice(0, even))
        .toString('utf16le')
        .replace(/\u0000+$/u, '');
}
/** `REG_EXPAND_SZ` values keep `%ProgramFiles%`; expand them before probing. */
function expandEnvVars(value, env) {
    return value.replace(/%([^%]+)%/gu, (whole, name) => env[name] ?? whole);
}
function defaultDeps() {
    return {
        platform: process.platform,
        env: process.env,
        homedir: os.homedir(),
        exists: (filePath) => existsSync(filePath),
        readRegistryDefault: (key) => new Promise((resolve) => {
            const file = path.join(os.tmpdir(), `mavis-reg-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.reg`);
            execFile('reg', ['export', key, file, '/y'], { windowsHide: true, timeout: PROCESS_TIMEOUT_MS }, (error) => {
                if (error) {
                    rmSync(file, { force: true });
                    resolve(undefined);
                    return;
                }
                let value;
                try {
                    value = parseRegExportDefault(readFileSync(file, 'utf16le'));
                }
                catch {
                    value = undefined;
                }
                rmSync(file, { force: true });
                resolve(value);
            });
        }),
        run: (command, args) => new Promise((resolve, reject) => {
            execFile(command, [...args], { windowsHide: true, timeout: PROCESS_TIMEOUT_MS }, (error) => error ? reject(error) : resolve());
        }),
        launch: (command, args) => new Promise((resolve, reject) => {
            // No `windowsHide` here: it makes the browser's first window hidden
            // when the browser was not running yet, and the page never shows.
            const child = spawn(command, [...args], {
                detached: true,
                stdio: 'ignore',
            });
            child.once('error', reject);
            child.once('spawn', () => {
                child.unref();
                resolve();
            });
        }),
    };
}
