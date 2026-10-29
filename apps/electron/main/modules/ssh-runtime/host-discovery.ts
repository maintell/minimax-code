import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { glob } from "glob";
import { isSafeSshHost } from "./config";
const defaultDependencies = {
    readTextFile: (filePath) => readFile(filePath, 'utf8'),
    globFiles: (pattern) => glob(pattern, {
        absolute: true,
        dot: true,
        nodir: true,
        windowsPathsNoEscape: true,
    }),
    runCommand: runCommand,
    homeDirectory: homedir,
};
export async function discoverSshHosts(dependencies = defaultDependencies) {
    const sshDirectory = path.join(dependencies.homeDirectory(), '.ssh');
    const configPath = path.join(sshDirectory, 'config');
    const aliases = [];
    const seenAliases = new Set();
    const visitedFiles = new Set();
    let configFound = true;
    try {
        await collectAliases(configPath, sshDirectory, dependencies, aliases, seenAliases, visitedFiles);
    }
    catch (error) {
        if (isFileNotFound(error))
            configFound = false;
        else
            return { configFound: false, hosts: [], error: 'config_unreadable' };
    }
    const hosts = await Promise.all(aliases.map(async (alias) => {
        try {
            const resolved = await dependencies.runCommand('ssh', ['-G', '-o', 'BatchMode=yes', alias]);
            return parseResolvedHost(alias, resolved.stdout);
        }
        catch {
            // Keep the alias visible even when OpenSSH is unavailable or one
            // stanza cannot be resolved. The explicit probe reports the reason.
            return { alias };
        }
    }));
    return { configFound, hosts };
}
async function collectAliases(configPath, includeBaseDirectory, dependencies, aliases, seenAliases, visitedFiles) {
    const normalizedPath = path.resolve(configPath);
    if (visitedFiles.has(normalizedPath))
        return;
    visitedFiles.add(normalizedPath);
    const source = await dependencies.readTextFile(normalizedPath);
    for (const rawLine of source.split(/\r?\n/u)) {
        const line = stripComment(rawLine).trim();
        if (!line)
            continue;
        const directive = /^(\S+)\s+(.+)$/u.exec(line);
        if (!directive)
            continue;
        const key = directive[1].toLowerCase();
        const values = splitWords(directive[2]);
        if (key === 'host') {
            for (const value of values) {
                if (!isConcreteAlias(value) || seenAliases.has(value))
                    continue;
                seenAliases.add(value);
                aliases.push(value);
            }
            continue;
        }
        if (key !== 'include')
            continue;
        for (const value of values) {
            const pattern = resolveIncludePattern(value, includeBaseDirectory, dependencies.homeDirectory());
            const includedFiles = (await dependencies.globFiles(pattern)).sort();
            for (const includedFile of includedFiles) {
                try {
                    await collectAliases(includedFile, includeBaseDirectory, dependencies, aliases, seenAliases, visitedFiles);
                }
                catch (error) {
                    if (!isFileNotFound(error))
                        throw error;
                }
            }
        }
    }
}
function isConcreteAlias(value) {
    const containsPattern = ['*', '?', '[', ']'].some((token) => value.includes(token));
    return !value.startsWith('!') && !containsPattern && isSafeSshHost(value);
}
function resolveIncludePattern(value, includeBaseDirectory, homeDirectory) {
    if (value === '~')
        return homeDirectory;
    if (value.startsWith('~/') || value.startsWith('~\\')) {
        return path.join(homeDirectory, value.slice(2));
    }
    return path.isAbsolute(value) ? value : path.join(includeBaseDirectory, value);
}
function parseResolvedHost(alias, output) {
    const values = new Map();
    for (const line of output.split(/\r?\n/u)) {
        const match = /^(\S+)\s+(.+)$/u.exec(line.trim());
        if (match && !values.has(match[1].toLowerCase())) {
            values.set(match[1].toLowerCase(), match[2].trim());
        }
    }
    const portText = values.get('port');
    const port = portText ? Number.parseInt(portText, 10) : undefined;
    return {
        alias,
        ...(values.get('hostname') ? { hostname: values.get('hostname') } : {}),
        ...(values.get('user') ? { user: values.get('user') } : {}),
        ...(port !== undefined && Number.isInteger(port) && port > 0 && port <= 65535 ? { port } : {}),
        ...(values.get('identityfile') ? { identityFile: values.get('identityfile') } : {}),
    };
}
function stripComment(line) {
    let quote = null;
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (character === '\\') {
            escaped = true;
            continue;
        }
        if (quote) {
            if (character === quote)
                quote = null;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            continue;
        }
        if (character === '#')
            return line.slice(0, index);
    }
    return line;
}
function splitWords(value) {
    const words = [];
    let current = '';
    let quote = null;
    let escaped = false;
    for (const character of value) {
        if (escaped) {
            current += character;
            escaped = false;
            continue;
        }
        if (character === '\\') {
            escaped = true;
            continue;
        }
        if (quote) {
            if (character === quote)
                quote = null;
            else
                current += character;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            continue;
        }
        if (/\s/u.test(character)) {
            if (current)
                words.push(current);
            current = '';
            continue;
        }
        current += character;
    }
    if (escaped)
        current += '\\';
    if (current)
        words.push(current);
    return words;
}
function isFileNotFound(error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
function runCommand(command, args) {
    return new Promise((resolve, reject) => {
        execFile(command, [...args], { encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                Object.assign(error, { stdout, stderr });
                reject(error);
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}
