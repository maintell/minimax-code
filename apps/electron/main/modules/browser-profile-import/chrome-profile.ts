import { createHash, randomUUID } from "node:crypto";
import { stat, lstat, readFile, realpath, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserProfileImportFailure } from "./errors";
const MAX_PROFILE_METADATA_BYTES = 16 * 1024 * 1024;
const PROFILE_DIRECTORY_PATTERN = /^(Default|Profile \d+)$/;
/** Installation-only probe: never touches Chrome's user data or credentials. */
export async function isChromeInstalled(platform = process.platform, homeDirectory = os.homedir(), environment = process.env) {
    const candidates = platform === 'darwin'
        ? ['/Applications', path.join(homeDirectory, 'Applications')].map((directory) => path.join(directory, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'))
        : platform === 'win32'
            ? [environment.PROGRAMFILES, environment['PROGRAMFILES(X86)'], environment.LOCALAPPDATA]
                .filter((directory) => Boolean(directory))
                .map((directory) => path.join(directory, 'Google', 'Chrome', 'Application', 'chrome.exe'))
            : [];
    for (const candidate of candidates) {
        try {
            if ((await stat(candidate)).isFile())
                return true;
        }
        catch {
            // A missing or inaccessible installation must not trigger a data-directory probe.
        }
    }
    return false;
}
export function defaultChromeUserDataDirectory(platform = process.platform, homeDirectory = os.homedir(), environment = process.env) {
    if (platform === 'darwin') {
        return path.join(homeDirectory, 'Library', 'Application Support', 'Google', 'Chrome');
    }
    if (platform === 'win32') {
        const localAppData = environment.LOCALAPPDATA;
        return localAppData ? path.join(localAppData, 'Google', 'Chrome', 'User Data') : null;
    }
    return null;
}
async function readLocalState(localStatePath) {
    try {
        const stats = await lstat(localStatePath);
        if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_PROFILE_METADATA_BYTES) {
            return {};
        }
        return JSON.parse(await readFile(localStatePath, 'utf8')) ?? {};
    }
    catch {
        return {};
    }
}
function trimmedString(value, maxLength) {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : undefined;
}
async function readProfileAccountIdentity(profileDirectory) {
    const preferencesPath = path.join(profileDirectory, 'Preferences');
    try {
        const stats = await lstat(preferencesPath);
        if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_PROFILE_METADATA_BYTES) {
            return {};
        }
        const resolved = await realpath(preferencesPath);
        const relative = path.relative(profileDirectory, resolved);
        if (resolved !== preferencesPath || relative.startsWith('..') || path.isAbsolute(relative)) {
            return {};
        }
        const preferences = JSON.parse(await readFile(resolved, 'utf8'));
        const account = preferences.account_info?.find(({ email }) => typeof email === 'string' && email.trim());
        const accountName = trimmedString(account?.email, 256);
        const displayName = trimmedString(account?.full_name, 128) ?? trimmedString(account?.given_name, 128);
        return {
            ...(accountName ? { accountName } : {}),
            ...(displayName ? { displayName } : {}),
        };
    }
    catch {
        return {};
    }
}
function resolveProfileDisplayName(cached, accountIdentity, directoryName) {
    const cachedName = trimmedString(cached?.name, 128);
    if (cachedName && cached?.is_using_default_name !== true) {
        return cachedName;
    }
    return (accountIdentity.displayName ??
        trimmedString(cached?.gaia_name, 128) ??
        trimmedString(cached?.gaia_given_name, 128) ??
        cachedName ??
        directoryName);
}
async function regularCookieDatabase(profileDirectory) {
    let unsafeCandidateFound = false;
    let errorCode;
    for (const candidate of [
        path.join(profileDirectory, 'Network', 'Cookies'),
        path.join(profileDirectory, 'Cookies'),
    ]) {
        try {
            const stats = await lstat(candidate);
            if (!stats.isFile() || stats.isSymbolicLink()) {
                unsafeCandidateFound = true;
                continue;
            }
            const resolved = await realpath(candidate);
            const relative = path.relative(profileDirectory, resolved);
            if (resolved !== candidate || relative.startsWith('..') || path.isAbsolute(relative)) {
                unsafeCandidateFound = true;
                continue;
            }
            return { path: resolved };
        }
        catch (error) {
            const code = fileSystemErrorCode(error);
            if (!['ENOENT', 'ENOTDIR'].includes(code) && !isAccessDenied(errorCode))
                errorCode = code;
            // Try the legacy location next.
        }
    }
    return { failureReason: unsafeCandidateFound ? 'unsafe' : 'unavailable', errorCode };
}
function opaqueProfileId(profileDirectory) {
    return `chrome_${createHash('sha256').update(profileDirectory).digest('hex').slice(0, 24)}`;
}
function profileOrder(left, right) {
    if (left === 'Default')
        return -1;
    if (right === 'Default')
        return 1;
    return left.localeCompare(right, undefined, { numeric: true });
}
function fileSystemErrorCode(error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    return typeof code === 'string' &&
        ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EIO', 'EMFILE', 'ENFILE', 'ELOOP'].includes(code)
        ? code
        : 'UNKNOWN';
}
function isAccessDenied(code) {
    return code === 'EACCES' || code === 'EPERM';
}
export async function discoverChromeProfiles(options = {}) {
    const platform = options.platform ?? process.platform;
    const attemptId = randomUUID();
    const startedAt = performance.now();
    const counts = {
        candidateProfileCount: 0,
        discoveredProfileCount: 0,
        profileAccessFailureCount: 0,
        unsafeProfileCount: 0,
        cookieDatabaseUnavailableCount: 0,
        unsafeCookieDatabaseCount: 0,
    };
    const report = (outcome, failure) => {
        try {
            options.onDiagnostic?.({
                event: 'profile_discovery_completed',
                platform,
                attemptId,
                processId: process.pid,
                source: options.source ?? 'unknown',
                ...(options.requestId ? { requestId: options.requestId } : {}),
                durationMs: Math.round(performance.now() - startedAt),
                outcome,
                ...failure,
                ...counts,
            });
        }
        catch {
            // Diagnostics must not change discovery results.
        }
    };
    const userDataDirectory = options.userDataDirectory ??
        defaultChromeUserDataDirectory(platform, options.homeDirectory, options.environment);
    if (!userDataDirectory) {
        report(platform === 'darwin' || platform === 'win32'
            ? 'user_data_directory_unavailable'
            : 'unsupported_platform');
        return [];
    }
    const failRoot = (failureStage, error) => {
        const errorCode = fileSystemErrorCode(error);
        const missing = errorCode === 'ENOENT' || errorCode === 'ENOTDIR';
        report(missing
            ? 'user_data_directory_not_found'
            : isAccessDenied(errorCode)
                ? 'user_data_directory_unreadable'
                : 'user_data_directory_unavailable', { failureStage, errorCode });
        if (missing)
            return [];
        throw new BrowserProfileImportFailure(isAccessDenied(errorCode) ? 'chrome_access_denied' : 'chrome_profile_unavailable');
    };
    try {
        if (!(await stat(userDataDirectory)).isDirectory()) {
            return failRoot('root_stat', { code: 'ENOTDIR' });
        }
    }
    catch (error) {
        return failRoot('root_stat', error);
    }
    // User-initiated discovery reads metadata before canonicalization, like Chrome importers.
    // Canonicalization and containment checks still gate every returned profile/database.
    const localState = await readLocalState(path.join(userDataDirectory, 'Local State'));
    let directoryNames;
    try {
        directoryNames = (await readdir(userDataDirectory)).filter((entry) => PROFILE_DIRECTORY_PATTERN.test(entry));
    }
    catch (error) {
        return failRoot('root_readdir', error);
    }
    let root;
    try {
        root = await realpath(userDataDirectory);
    }
    catch (error) {
        return failRoot('root_realpath', error);
    }
    counts.candidateProfileCount = directoryNames.length;
    if (directoryNames.length === 0) {
        report('no_supported_profile_directories');
        return [];
    }
    const localStatePath = path.join(root, 'Local State');
    const infoCache = localState.profile?.info_cache ?? {};
    const profiles = [];
    let profileAccessDenied = false;
    let databaseReadFailed = false;
    for (const directoryName of directoryNames.sort(profileOrder)) {
        const candidateDirectory = path.join(root, directoryName);
        let profileDirectory;
        try {
            profileDirectory = await realpath(candidateDirectory);
        }
        catch (error) {
            counts.profileAccessFailureCount += 1;
            profileAccessDenied || (profileAccessDenied = isAccessDenied(fileSystemErrorCode(error)));
            continue;
        }
        const relative = path.relative(root, profileDirectory);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            counts.unsafeProfileCount += 1;
            continue;
        }
        const cookieDatabase = await regularCookieDatabase(profileDirectory);
        if (cookieDatabase.path === undefined) {
            profileAccessDenied || (profileAccessDenied = isAccessDenied(cookieDatabase.errorCode));
            databaseReadFailed || (databaseReadFailed = Boolean(cookieDatabase.errorCode));
            if (cookieDatabase.failureReason === 'unsafe') {
                counts.unsafeCookieDatabaseCount += 1;
            }
            else {
                counts.cookieDatabaseUnavailableCount += 1;
            }
            continue;
        }
        const cached = infoCache[directoryName];
        const accountIdentity = await readProfileAccountIdentity(profileDirectory);
        const displayName = resolveProfileDisplayName(cached, accountIdentity, directoryName);
        const cachedAccountName = trimmedString(cached?.user_name, 256);
        const accountName = accountIdentity.accountName ?? cachedAccountName;
        const id = opaqueProfileId(profileDirectory);
        const publicMetadata = {
            id,
            browser: 'chrome',
            displayName,
            ...(accountName ? { accountName } : {}),
            isDefault: directoryName === 'Default',
            ...(directoryName === localState.profile?.last_used ? { isLastUsed: true } : {}),
        };
        profiles.push({
            id,
            browser: 'chrome',
            displayName,
            ...(accountName ? { accountName } : {}),
            directoryName,
            profileDirectory,
            cookieDatabasePath: cookieDatabase.path,
            localStatePath,
            publicMetadata,
        });
    }
    counts.discoveredProfileCount = profiles.length;
    report(profiles.length > 0 ? 'profiles_available' : 'no_importable_profiles');
    if (profiles.length === 0) {
        if (profileAccessDenied)
            throw new BrowserProfileImportFailure('chrome_access_denied');
        if (databaseReadFailed)
            throw new BrowserProfileImportFailure('cookie_database_unavailable');
        if (counts.profileAccessFailureCount > 0) {
            throw new BrowserProfileImportFailure('chrome_profile_unavailable');
        }
    }
    return profiles;
}
