/**
 * PATH command inventory.
 *
 * Automatic collection lists PATH file names; it never executes anything it finds there. The
 * scan is non-recursive, bounded by a directory count and a raw entry budget, and only counts
 * what it actually looked at — it never walks further just to report a precise "real" total.
 *
 * Windows PATH directories are mostly libraries, documentation and data files: eligibility is
 * decided by the machine's real PATHEXT, and on POSIX by the executable bit. Filtering and
 * de-duplication happen before the count and byte budgets, so the budget is spent on commands
 * rather than on noise, and third-party tooling outranks the operating system's own directories
 * when the budget runs out.
 */
import { readdir, stat } from 'node:fs/promises';
import { platform as currentPlatform, homedir } from 'node:os';
import { delimiter, isAbsolute, resolve, sep } from 'node:path';
const MAX_PATH_DIRECTORIES = 128;
const MAX_PATH_ENTRIES = 20_000;
const MAX_EXECUTABLE_EXTENSIONS = 32;
const FILE_STAT_CONCURRENCY = 64;
const EXECUTABLE_MODE_MASK = 0o111;
/** Quotes plus separator, so `outputBytes` tracks the JSON array rather than raw names. */
const JSON_ENTRY_OVERHEAD_BYTES = 3;
const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9._+@-]{0,127}$/iu;
const EXECUTABLE_EXTENSION_PATTERN = /^\.[a-z0-9]{1,15}$/u;
const DEFAULT_WINDOWS_PATHEXT = ['.com', '.exe', '.bat', '.cmd'];
const POSIX_SYSTEM_ROOTS = [
    '/bin',
    '/sbin',
    '/usr/bin',
    '/usr/sbin',
    '/usr/libexec',
];
const SOURCE_PRIORITY = {
    third_party: 0,
    unknown: 1,
    system: 2,
};
export async function scanPathCommands(options) {
    const { matcher, maxCommands, maxBytes } = options;
    const platform = options.platform ?? currentPlatform();
    const env = options.env ?? process.env;
    if (maxCommands <= 0 || maxBytes <= 0)
        return emptyInventory('policy');
    if (matcher.excludesEnvironmentKey('PATH'))
        return emptyInventory('policy');
    const rawPath = env.PATH ?? env.Path ?? '';
    if (rawPath.length === 0)
        return emptyInventory('unavailable');
    const allDirectories = uniqueDirectories(rawPath, platform);
    const directories = allDirectories.slice(0, MAX_PATH_DIRECTORIES);
    const executableExtensions = readExecutableExtensions(matcher, platform, env);
    const classify = createDirectoryClassifier(platform, env);
    const candidates = new Map();
    let rawFileCount = 0;
    let filteredCount = 0;
    let entryBudgetExhausted = false;
    for (const directory of directories) {
        if (rawFileCount >= MAX_PATH_ENTRIES) {
            entryBudgetExhausted = true;
            break;
        }
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        }
        catch {
            continue;
        }
        const source = classify(directory);
        const eligible = [];
        for (const entry of entries) {
            if (rawFileCount >= MAX_PATH_ENTRIES) {
                entryBudgetExhausted = true;
                break;
            }
            rawFileCount += 1;
            if (!entry.isFile() && !entry.isSymbolicLink())
                continue;
            if (matcher.excludesPathCommand(entry.name)) {
                filteredCount += 1;
                continue;
            }
            const command = normalizeCommandName(entry.name, executableExtensions);
            if (command === undefined) {
                filteredCount += 1;
                continue;
            }
            eligible.push({
                key: platform === 'win32' ? command.toLowerCase() : command,
                name: command,
                path: `${directory}${sep}${entry.name}`,
            });
        }
        // POSIX has no PATHEXT: the executable bit is the eligibility test. Only names that already
        // survived filtering are stat'ed, and the file is never run.
        const executable = executableExtensions === undefined ? await filterExecutable(eligible) : eligible;
        filteredCount += eligible.length - executable.length;
        for (const candidate of executable) {
            const existing = candidates.get(candidate.key);
            if (existing && SOURCE_PRIORITY[existing.source] <= SOURCE_PRIORITY[source])
                continue;
            candidates.set(candidate.key, { name: candidate.name, source });
        }
    }
    return buildInventory({
        candidates: [...candidates.values()],
        maxCommands,
        maxBytes,
        rawFileCount,
        filteredCount,
        entryBudgetExhausted,
        directoriesTruncated: allDirectories.length > directories.length,
    });
}
function buildInventory(input) {
    const ranked = [...input.candidates].sort((left, right) => {
        const byPriority = SOURCE_PRIORITY[left.source] - SOURCE_PRIORITY[right.source];
        if (byPriority !== 0)
            return byPriority;
        if (left.name === right.name)
            return 0;
        return left.name < right.name ? -1 : 1;
    });
    const retained = [];
    const sources = { system: 0, third_party: 0, unknown: 0 };
    let outputBytes = 2; // enclosing brackets
    let limitReason;
    for (const candidate of ranked) {
        if (retained.length >= input.maxCommands) {
            limitReason = 'count_limit';
            break;
        }
        const entryBytes = Buffer.byteLength(candidate.name, 'utf8') + JSON_ENTRY_OVERHEAD_BYTES;
        if (outputBytes + entryBytes > input.maxBytes) {
            limitReason = 'byte_limit';
            break;
        }
        outputBytes += entryBytes;
        retained.push(candidate);
        sources[candidate.source] += 1;
    }
    const scanComplete = !input.entryBudgetExhausted && !input.directoriesTruncated;
    let reason = limitReason;
    if (input.entryBudgetExhausted)
        reason = 'scan_limit';
    else if (input.directoriesTruncated)
        reason = 'directory_limit';
    return {
        commands: retained.map((candidate) => candidate.name).sort(),
        truncated: !scanComplete || retained.length < ranked.length,
        scanComplete,
        rawFileCount: input.rawFileCount,
        filteredCount: input.filteredCount,
        retainedCount: retained.length,
        outputBytes,
        scanLimit: MAX_PATH_ENTRIES,
        ...(reason ? { reason } : {}),
        sources,
    };
}
function emptyInventory(reason) {
    return {
        commands: [],
        truncated: false,
        scanComplete: false,
        rawFileCount: 0,
        filteredCount: 0,
        retainedCount: 0,
        outputBytes: 2,
        scanLimit: MAX_PATH_ENTRIES,
        reason,
        sources: { system: 0, third_party: 0, unknown: 0 },
    };
}
async function filterExecutable(entries) {
    const executable = [];
    for (let offset = 0; offset < entries.length; offset += FILE_STAT_CONCURRENCY) {
        const batch = await Promise.all(entries.slice(offset, offset + FILE_STAT_CONCURRENCY).map(async (entry) => {
            try {
                const stats = await stat(entry.path);
                return stats.isFile() && (stats.mode & EXECUTABLE_MODE_MASK) !== 0 ? entry : undefined;
            }
            catch {
                return undefined;
            }
        }));
        for (const entry of batch) {
            if (entry)
                executable.push(entry);
        }
    }
    return executable;
}
function uniqueDirectories(rawPath, platform) {
    const seen = new Set();
    const directories = [];
    for (const entry of rawPath.split(delimiter)) {
        const directory = entry.trim();
        if (directory.length === 0 || !isAbsolute(directory))
            continue;
        const normalized = resolve(directory);
        const key = platform === 'win32' ? normalized.toLowerCase() : normalized;
        if (seen.has(key))
            continue;
        seen.add(key);
        directories.push(normalized);
    }
    return directories;
}
function normalizeCommandName(fileName, executableExtensions) {
    if (executableExtensions === undefined) {
        return COMMAND_NAME_PATTERN.test(fileName) ? fileName : undefined;
    }
    const dot = fileName.lastIndexOf('.');
    if (dot <= 0)
        return undefined;
    if (!Object.hasOwn(executableExtensions, fileName.slice(dot).toLowerCase()))
        return undefined;
    const stem = fileName.slice(0, dot);
    return COMMAND_NAME_PATTERN.test(stem) ? stem : undefined;
}
/** Returns the Windows executable extensions, or `undefined` on platforms without PATHEXT. */
function readExecutableExtensions(matcher, platform, env) {
    if (platform !== 'win32')
        return undefined;
    const rawPathExt = matcher.excludesEnvironmentKey('PATHEXT')
        ? ''
        : (env.PATHEXT ?? env.Pathext ?? '');
    const configured = rawPathExt
        .split(';')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => EXECUTABLE_EXTENSION_PATTERN.test(entry));
    const extensions = (configured.length > 0 ? configured : DEFAULT_WINDOWS_PATHEXT).slice(0, MAX_EXECUTABLE_EXTENSIONS);
    const lookup = Object.create(null);
    for (const extension of extensions)
        lookup[extension] = true;
    return lookup;
}
/**
 * Classifies a PATH directory without reporting it. Only the aggregate counts leave the process;
 * absolute PATH directories never do.
 */
function createDirectoryClassifier(platform, env) {
    const caseInsensitive = platform === 'win32';
    const normalize = (value) => (caseInsensitive ? value.toLowerCase() : value);
    const systemPrefixes = (platform === 'win32'
        ? [env.SystemRoot ?? env.windir ?? env.WINDIR ?? 'C:\\Windows']
        : POSIX_SYSTEM_ROOTS).map(normalize);
    const thirdPartyPrefixes = (platform === 'win32' ? windowsThirdPartyRoots(env) : posixThirdPartyRoots(env)).map(normalize);
    return (directory) => {
        const candidate = normalize(directory);
        // Third-party locations win: a tool installed under Program Files or /opt is the signal,
        // and some of them live below a system-owned prefix.
        if (thirdPartyPrefixes.some((prefix) => isWithin(candidate, prefix)))
            return 'third_party';
        if (systemPrefixes.some((prefix) => isWithin(candidate, prefix)))
            return 'system';
        return 'unknown';
    };
}
function isWithin(candidate, prefix) {
    if (prefix.length === 0)
        return false;
    if (candidate === prefix)
        return true;
    const boundary = prefix.endsWith(sep) ? prefix : `${prefix}${sep}`;
    return candidate.startsWith(boundary);
}
function windowsThirdPartyRoots(env) {
    return [
        env.ProgramFiles,
        env['ProgramFiles(x86)'],
        env.ProgramW6432,
        env.LOCALAPPDATA,
        env.APPDATA,
        env.USERPROFILE,
    ].filter((value) => typeof value === 'string' && value.length > 0);
}
function posixThirdPartyRoots(env) {
    const home = env.HOME ?? safeHomedir();
    return ['/opt', '/usr/local', '/nix', '/snap', ...(home ? [home] : [])];
}
function safeHomedir() {
    try {
        return homedir();
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=eval-meta-info-path-scan.js.map