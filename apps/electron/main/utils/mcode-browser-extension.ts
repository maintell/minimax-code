import { promises } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareVersions } from "./version";
/**
 * Desktop side of the mcode-browser Plugin (设置 → 浏览器 → 浏览器扩展): tells whether its Chrome
 * extension is enabled, and prepares the folder a manual install loads the extension from.
 * Paths and rules mirror packages/mavis-browser/bridge (install.js, shared.js).
 */
export let MCODE_BROWSER_EXTENSION_ID = 'dikdibhbmegbieeigjacifcjdockofko';
const PLUGIN_NAME = 'mcode-browser';
// Protocol names of MiniMax Code builds (bridge/shared.js APP_SCHEME_RE).
const APP_SCHEME_RE = /^minimax(-[a-z0-9]+){0,3}$/u;
function defaultDeps() {
    return { platform: process.platform, env: process.env, homedir: os.homedir() };
}
function pathApi(platform) {
    return platform === 'win32' ? path.win32 : path.posix;
}
function localAppData(deps) {
    return deps.env.LOCALAPPDATA || path.win32.join(deps.homedir, 'AppData', 'Local');
}
/** The Plugin's state folder (bridge/shared.js BASE_DIR). */
export function mcodeBrowserHome(deps = defaultDeps()) {
    const override = deps.env.MCODE_BROWSER_HOME?.trim();
    if (override)
        return override;
    const p = pathApi(deps.platform);
    return deps.platform === 'win32'
        ? p.join(localAppData(deps), 'mcode-browser')
        : p.join(deps.homedir, '.local', 'share', 'mcode-browser');
}
/** True for the extension's Chrome Web Store page. */
export function isMcodeBrowserStoreUrl(url) {
    if (typeof url !== 'string')
        return false;
    try {
        const { hostname, pathname } = new URL(url);
        return (hostname === 'chromewebstore.google.com' &&
            pathname.split('/').includes(MCODE_BROWSER_EXTENSION_ID));
    }
    catch {
        return false;
    }
}
/**
 * Records that this build sent the user to install the extension. The relay that the new extension
 * starts reads it (bridge/shared.js readInstallSource), so the extension's "Back to MiniMax Code"
 * button wakes this build even when other builds are installed. scheme is this build's protocol
 * name, set at startup by modules/deeplink.
 */
export async function recordMcodeBrowserInstallSource(scheme = process.env.MCODE_APP_SCHEME, now = Date.now(), deps = defaultDeps()) {
    if (!scheme || !APP_SCHEME_RE.test(scheme))
        return;
    const p = pathApi(deps.platform);
    const runDir = p.join(mcodeBrowserHome(deps), 'run');
    // Same private mode as bridge/shared.js ensureDirs: the folder also holds the relay socket.
    await promises.mkdir(runDir, { recursive: true, mode: 0o700 });
    await promises.writeFile(p.join(runDir, 'install-source.json'), JSON.stringify({ scheme, at: now }));
}
/** The folder a manual install loads the unpacked extension from. */
export function manualExtensionDir(deps = defaultDeps()) {
    return pathApi(deps.platform).join(mcodeBrowserHome(deps), 'extension');
}
/** Google Chrome user data roots (stable, Beta, Canary) for this platform. */
export function chromeUserDataRoots(deps = defaultDeps()) {
    const p = pathApi(deps.platform);
    if (deps.platform === 'win32') {
        return ['Chrome', 'Chrome Beta', 'Chrome SxS'].map((name) => p.join(localAppData(deps), 'Google', name, 'User Data'));
    }
    if (deps.platform === 'darwin') {
        return ['Chrome', 'Chrome Beta', 'Chrome Canary'].map((name) => p.join(deps.homedir, 'Library', 'Application Support', 'Google', name));
    }
    return [];
}
/**
 * Chrome keeps every installed extension under extensions.settings in (Secure) Preferences; a
 * disabled one carries a non-empty disable_reasons (or state 0 on older builds). An uninstalled
 * extension can leave an empty entry behind: only entries with an install location count.
 * Same rule as installedIn / enabledIn in packages/mavis-browser/bridge/install.js, so the settings
 * page and the agent agree on the extension state.
 */
export function extensionStateIn(prefs, id) {
    const settings = prefs
        ?.extensions?.settings;
    const entry = settings?.[id];
    if (!entry || typeof entry !== 'object' || (entry.location == null && !entry.path))
        return 'missing';
    const reasons = entry.disable_reasons;
    if (Array.isArray(reasons) ? reasons.length > 0 : Boolean(reasons))
        return 'disabled';
    return entry.state === 0 ? 'disabled' : 'enabled';
}
async function readJson(file) {
    try {
        return JSON.parse(await promises.readFile(file, 'utf8'));
    }
    catch {
        return undefined;
    }
}
async function isDirectory(dir) {
    try {
        return (await promises.stat(dir)).isDirectory();
    }
    catch {
        return false;
    }
}
async function profileDirs(root, p) {
    try {
        return (await promises.readdir(root))
            .filter((name) => name === 'Default' || /^Profile \d+$/u.test(name))
            .map((name) => p.join(root, name));
    }
    catch {
        return [];
    }
}
/** The extension over every profile of every Chrome channel: enabled anywhere wins. */
async function stateInAnyProfile(roots, deps) {
    const p = pathApi(deps.platform);
    let installed = false;
    for (const root of roots) {
        for (const profile of await profileDirs(root, p)) {
            for (const file of ['Secure Preferences', 'Preferences']) {
                const state = extensionStateIn(await readJson(p.join(profile, file)), MCODE_BROWSER_EXTENSION_ID);
                if (state === 'enabled')
                    return 'enabled';
                if (state === 'disabled')
                    installed = true;
            }
        }
    }
    return installed ? 'disabled' : 'missing';
}
/**
 * installed: enabled in at least one Chrome profile. disabled: installed but switched off in every
 * profile. no_chrome: neither the Chrome app nor any Chrome profile exists. isChromeInstalled comes
 * from the named-browser lookup.
 */
export async function readChromeExtensionStatus(isChromeInstalled, deps = defaultDeps()) {
    const roots = [];
    for (const root of chromeUserDataRoots(deps))
        if (await isDirectory(root))
            roots.push(root);
    const state = await stateInAnyProfile(roots, deps);
    if (state === 'enabled')
        return 'installed';
    if (state === 'disabled')
        return 'disabled';
    if (roots.length === 0 && !(await isChromeInstalled()))
        return 'no_chrome';
    return 'missing';
}
async function manifestVersion(dir) {
    const version = (await readJson(path.join(dir, 'manifest.json')))
        ?.version;
    return typeof version === 'string' ? version : undefined;
}
/**
 * The extension/ folder of the newest installed mcode-browser package. Marketplace packages live
 * in the Runtime's content-addressed cache (<dataDir>/v2/plugin-cache/official/<digest>), so each
 * entry's manifest is read to find the Plugin. Dot entries are the Runtime's in-progress downloads.
 */
export async function findPluginExtensionSource(dataDir) {
    const cache = path.join(dataDir, 'v2', 'plugin-cache', 'official');
    let entries = [];
    try {
        entries = await promises.readdir(cache);
    }
    catch {
        return undefined;
    }
    let best;
    for (const entry of entries) {
        if (entry.startsWith('.'))
            continue;
        const root = path.join(cache, entry);
        const manifest = (await readJson(path.join(root, '.minimax-plugin', 'plugin.json')));
        if (manifest?.name !== PLUGIN_NAME)
            continue;
        const dir = path.join(root, 'extension');
        if (!(await readJson(path.join(dir, 'manifest.json'))))
            continue;
        const version = typeof manifest.version === 'string' ? manifest.version : '0';
        if (!best || compareVersions(version, best.version) > 0)
            best = { dir, version };
    }
    return best?.dir;
}
async function listFiles(dir, rel = '') {
    let entries = [];
    try {
        entries = await promises.readdir(path.join(dir, rel), { withFileTypes: true });
    }
    catch {
        return [];
    }
    const out = [];
    for (const entry of entries) {
        const child = path.join(rel, entry.name);
        if (entry.isDirectory())
            out.push(...(await listFiles(dir, child)));
        else if (entry.isFile() && entry.name !== '.DS_Store')
            out.push(child);
    }
    return out;
}
/**
 * Mirrors source into target, copying only changed files and removing stale ones. manifest.json
 * is written last, so a running extension that reloads on a manifest change never sees a
 * half-copied folder (extension/self-update.js).
 */
export async function syncExtensionFolder(source, target) {
    const files = (await listFiles(source)).sort((a, b) => Number(a === 'manifest.json') - Number(b === 'manifest.json'));
    for (const file of files) {
        const from = path.join(source, file);
        const to = path.join(target, file);
        const buf = await promises.readFile(from);
        const old = await promises.readFile(to).catch(() => undefined);
        if (old?.equals(buf))
            continue;
        await promises.mkdir(path.dirname(to), { recursive: true });
        await promises.writeFile(to, buf);
    }
    const keep = new Set(files);
    for (const file of await listFiles(target)) {
        if (!keep.has(file))
            await promises.rm(path.join(target, file), { force: true });
    }
}
/**
 * Copies the installed Plugin's extension into the manual install folder and returns that folder.
 * Without an installed package an existing copy is still returned. Several MiniMax Code builds share
 * the folder (and bridge/install.js syncManualExtension writes it too), so a newer copy is kept:
 * the folder only ever moves to a newer version.
 */
export async function prepareManualExtensionFolder(dataDir, deps = defaultDeps()) {
    const target = manualExtensionDir(deps);
    const source = await findPluginExtensionSource(dataDir);
    if (source) {
        const current = await manifestVersion(target);
        const ours = await manifestVersion(source);
        if (current && ours && compareVersions(current, ours) > 0)
            return { success: true, path: target };
        try {
            await syncExtensionFolder(source, target);
            return { success: true, path: target };
        }
        catch {
            return { success: false, errorCode: 'copy_failed' };
        }
    }
    return (await readJson(path.join(target, 'manifest.json')))
        ? { success: true, path: target }
        : { success: false, errorCode: 'source_missing' };
}
