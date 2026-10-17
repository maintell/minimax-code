import JSZip from 'jszip';
import yaml from 'js-yaml';
import { LocalSkillHubInstallError } from '../hub-errors.js';
import { resolveRemoteArchiveCandidates, withResolvedGithubSha, } from './github.js';
import { scanGithubSkillRepository } from './git.js';
const REMOTE_SKILL_ARCHIVE_TIMEOUT_MS = 30_000;
const REMOTE_SKILL_ARCHIVE_MAX_BYTES = 10 * 1024 * 1024;
const REMOTE_SKILL_MARKDOWN_MAX_BYTES = 1024 * 1024;
const RETRYABLE_REMOTE_CODES = new Set([
    'LOCAL_SKILL_HUB_REMOTE_DOWNLOAD_FAILED',
    'LOCAL_SKILL_HUB_REMOTE_ARCHIVE_MISSING_SKILL',
    'LOCAL_SKILL_HUB_REMOTE_SHA_UNAVAILABLE',
]);
export async function scanRemoteSkillArchiveSource(sourceUrl, options) {
    return scanFirstRemoteSkillArchive(sourceUrl, options);
}
export function toLocalSkillPreviewResp(result) {
    return {
        candidates: result.candidates.map((candidate) => ({
            sub_path: candidate.sub_path,
            name: candidate.name,
            description: candidate.description,
            files: candidate.files,
            size_bytes: candidate.size_bytes,
        })),
        repo_info: result.repoInfo,
    };
}
export function selectRemoteSkillInstall(result, hintSubPath) {
    const hint = normalizeRepoPath(hintSubPath);
    const candidates = hint === undefined
        ? result.candidates
        : result.candidates.filter((candidate) => normalizeRepoPath(candidate.sub_path) === hint);
    if (candidates.length > 1) {
        throw new LocalSkillHubInstallError('Remote skill archive contains multiple SKILL.md files.', 'LOCAL_SKILL_HUB_REMOTE_ARCHIVE_AMBIGUOUS', 422);
    }
    const candidate = candidates[0];
    if (!candidate) {
        throw new LocalSkillHubInstallError('Remote skill archive does not contain SKILL.md.', 'LOCAL_SKILL_HUB_REMOTE_ARCHIVE_MISSING_SKILL', 422);
    }
    return { content: candidate.content, files: candidate.installFiles };
}
async function scanFirstRemoteSkillArchive(sourceUrl, options) {
    if (!isHttpUrl(sourceUrl)) {
        throw new LocalSkillHubInstallError('Remote skill preview requires an http(s) URL.', 'LOCAL_SKILL_HUB_REMOTE_INVALID_URL', 400);
    }
    const archives = resolveRemoteArchiveCandidates(sourceUrl, options.ref);
    let lastError;
    for (const archive of archives) {
        try {
            return await scanArchiveWithGitFallback(archive, options.fetch);
        }
        catch (err) {
            if (!shouldTryNextArchive(archive, err))
                throw err;
            lastError = err;
        }
    }
    throw (lastError ??
        new LocalSkillHubInstallError('Failed to download remote skill archive.', 'LOCAL_SKILL_HUB_REMOTE_DOWNLOAD_FAILED', 502));
}
async function scanRemoteSkillArchive(archive, fetchImpl) {
    return scanSkillFiles(await loadZipSkillFiles(await downloadRemoteSkillArchive(archive.archiveUrl, fetchImpl)), archive.scanHintSubPath ?? archive.repoInfo.hint_sub_path, archive.exactHintSubPath);
}
async function downloadRemoteSkillArchive(archiveUrl, fetchImpl) {
    let response;
    try {
        response = await fetchImpl(archiveUrl, {
            method: 'GET',
            headers: { 'User-Agent': 'MiniMaxAgent' },
            signal: AbortSignal.timeout(REMOTE_SKILL_ARCHIVE_TIMEOUT_MS),
        });
    }
    catch (err) {
        throw new LocalSkillHubInstallError(`Failed to download remote skill archive: ${formatError(err)}`, 'LOCAL_SKILL_HUB_REMOTE_DOWNLOAD_FAILED', 502);
    }
    if (!response.ok) {
        throw new LocalSkillHubInstallError(`Failed to download remote skill archive: ${response.status}`, 'LOCAL_SKILL_HUB_REMOTE_DOWNLOAD_FAILED', 502);
    }
    const lengthHeader = response.headers.get('content-length');
    const declaredLength = lengthHeader ? Number.parseInt(lengthHeader, 10) : undefined;
    if (declaredLength !== undefined && declaredLength > REMOTE_SKILL_ARCHIVE_MAX_BYTES) {
        throw new LocalSkillHubInstallError('Remote skill archive is too large.', 'LOCAL_SKILL_HUB_REMOTE_ARCHIVE_TOO_LARGE', 413);
    }
    let body;
    try {
        body = await response.arrayBuffer();
    }
    catch (err) {
        throw new LocalSkillHubInstallError(`Failed to download remote skill archive: ${formatError(err)}`, 'LOCAL_SKILL_HUB_REMOTE_DOWNLOAD_FAILED', 502);
    }
    const buffer = Buffer.from(body);
    if (buffer.byteLength > REMOTE_SKILL_ARCHIVE_MAX_BYTES) {
        throw new LocalSkillHubInstallError('Remote skill archive is too large.', 'LOCAL_SKILL_HUB_REMOTE_ARCHIVE_TOO_LARGE', 413);
    }
    return buffer;
}
function shouldFallbackToGitClone(archive, err) {
    return (Boolean(archive.github) &&
        err instanceof LocalSkillHubInstallError &&
        (err.code === 'LOCAL_SKILL_HUB_REMOTE_ARCHIVE_TOO_LARGE' ||
            err.code === 'LOCAL_SKILL_HUB_REMOTE_DOWNLOAD_FAILED' ||
            err.code === 'LOCAL_SKILL_HUB_REMOTE_SHA_UNAVAILABLE'));
}
function shouldTryNextArchive(candidate, err) {
    return (candidate.retryable &&
        err instanceof LocalSkillHubInstallError &&
        RETRYABLE_REMOTE_CODES.has(err.code));
}
async function loadZipSkillFiles(buffer) {
    let zip;
    try {
        zip = await JSZip.loadAsync(buffer);
    }
    catch (err) {
        throw new LocalSkillHubInstallError(`Remote skill archive is not a valid zip file: ${formatError(err)}`, 'LOCAL_SKILL_HUB_REMOTE_ARCHIVE_INVALID', 422);
    }
    return normalizeZipFiles(zip);
}
async function scanSkillFiles(files, hintSubPath, exactHintSubPath = false) {
    const hint = normalizeRepoPath(hintSubPath);
    const skillFiles = files.filter((file) => file.path.split('/').pop() === 'SKILL.md' && isWithinHint(file.path, hint, exactHintSubPath));
    if (skillFiles.length === 0) {
        throw new LocalSkillHubInstallError('Remote skill archive does not contain SKILL.md.', 'LOCAL_SKILL_HUB_REMOTE_ARCHIVE_MISSING_SKILL', 422);
    }
    return Promise.all(skillFiles.map(async (skillFile) => {
        assertSkillMarkdownSize(skillFile.sizeBytes);
        const content = (await skillFile.readString()).trim();
        assertSkillMarkdownSize(content);
        if (!content) {
            throw new LocalSkillHubInstallError('Remote skill archive SKILL.md is empty.', 'LOCAL_SKILL_HUB_REMOTE_ARCHIVE_EMPTY_SKILL', 422);
        }
        const subPath = parentRepoPath(skillFile.path);
        const metadata = readSkillMetadata(content);
        const candidateFiles = candidateFileEntries(files, subPath, {
            excludeNestedSkillDirs: exactHintSubPath && subPath === '',
        });
        return {
            sub_path: subPath,
            name: normalizeSkillName(metadata.name ?? subPath.split('/').pop() ?? 'skill'),
            description: metadata.description ?? '',
            files: candidateFiles.map((file) => file.path).sort(),
            size_bytes: sumCandidateSize(candidateFiles),
            content: content.endsWith('\n') ? content : `${content}\n`,
            installFiles: await readCandidateInstallFiles(candidateFiles),
        };
    }));
}
function normalizeZipFiles(zip) {
    const entries = Object.values(zip.files).filter((entry) => !entry.dir);
    const stripRoot = shouldStripArchiveRoot(entries);
    return entries.flatMap((entry) => {
        const parts = entry.name.split('/').filter(Boolean);
        const path = (stripRoot ? parts.slice(1) : parts).join('/');
        return path
            ? [
                {
                    path,
                    sizeBytes: readZipEntryUncompressedSize(entry),
                    readBuffer: () => entry.async('nodebuffer'),
                    readString: () => entry.async('string'),
                },
            ]
            : [];
    });
}
function shouldStripArchiveRoot(entries) {
    const parts = entries.map((entry) => entry.name.split('/').filter(Boolean));
    const first = parts[0]?.[0];
    return Boolean(first &&
        parts.every((entryParts) => entryParts.length > 1) &&
        parts.every((entryParts) => entryParts[0] === first));
}
function isWithinHint(path, hint, exactHint) {
    if (exactHint)
        return parentRepoPath(path) === (hint ?? '');
    if (!hint)
        return true;
    return path === hint || path.startsWith(`${hint}/`);
}
function parentRepoPath(path) {
    const index = path.lastIndexOf('/');
    return index === -1 ? '' : path.slice(0, index);
}
function candidateFileEntries(files, subPath, options = {}) {
    const prefix = subPath ? `${subPath}/` : '';
    const excludedSkillDirs = options.excludeNestedSkillDirs ? nestedSkillDirectories(files) : [];
    return files.flatMap((file) => {
        if (subPath && !file.path.startsWith(prefix))
            return [];
        if (excludedSkillDirs.some((dir) => isWithinRepoPath(file.path, dir)))
            return [];
        const relativePath = subPath ? file.path.slice(prefix.length) : file.path;
        const safePath = normalizeInstallFilePath(relativePath);
        return safePath ? [{ ...file, path: safePath }] : [];
    });
}
function nestedSkillDirectories(files) {
    return files.flatMap((file) => {
        if (file.path.split('/').pop() !== 'SKILL.md')
            return [];
        const dir = parentRepoPath(file.path);
        return dir ? [dir] : [];
    });
}
function isWithinRepoPath(path, repoPath) {
    return path === repoPath || path.startsWith(`${repoPath}/`);
}
function sumCandidateSize(files) {
    return files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0);
}
function readCandidateInstallFiles(files) {
    return Promise.all(files.map(async (file) => ({
        path: file.path,
        content: await file.readBuffer(),
    })));
}
function readSkillMetadata(content) {
    const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
    if (!match)
        return {};
    try {
        const parsed = yaml.load(match[1] ?? '');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return {};
        const record = parsed;
        return {
            ...(readString(record['name']) ? { name: readString(record['name']) } : {}),
            ...(readString(record['description'])
                ? { description: readString(record['description']) }
                : {}),
        };
    }
    catch {
        return {};
    }
}
function normalizeRepoPath(value) {
    const normalized = value
        ?.split(/[\\/]+/u)
        .filter((part) => part.length > 0 && part !== '.')
        .join('/');
    return normalized || undefined;
}
function normalizeInstallFilePath(value) {
    const parts = value.split(/[\\/]+/u).filter(Boolean);
    if (parts.length === 0 || parts.some((part) => part === '.' || part === '..'))
        return undefined;
    return parts.join('/');
}
function assertSkillMarkdownSize(value) {
    const byteLength = typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : value;
    if (byteLength === undefined || byteLength <= REMOTE_SKILL_MARKDOWN_MAX_BYTES)
        return;
    throw new LocalSkillHubInstallError('Remote skill archive SKILL.md is too large.', 'LOCAL_SKILL_HUB_REMOTE_MARKDOWN_TOO_LARGE', 413);
}
function readZipEntryUncompressedSize(entry) {
    const data = entry._data;
    return typeof data?.uncompressedSize === 'number' ? data.uncompressedSize : undefined;
}
function normalizeSkillName(value) {
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 64);
    return normalized || 'local-skill';
}
function readString(value) {
    return typeof value === 'string' && value.trim() ? value : undefined;
}
function isHttpUrl(value) {
    return /^https?:\/\//iu.test(value);
}
function formatError(err) {
    return err instanceof Error ? err.message : String(err);
}
async function scanArchiveWithGitFallback(archive, fetchImpl) {
    try {
        const resolvedArchive = await withResolvedGithubSha(archive, fetchImpl);
        const candidates = await scanRemoteSkillArchive(resolvedArchive, fetchImpl);
        return { candidates, repoInfo: resolvedArchive.repoInfo };
    }
    catch (error) {
        if (!shouldFallbackToGitClone(archive, error))
            throw error;
        return scanGithubSkillRepository(archive, scanSkillFiles);
    }
}
//# sourceMappingURL=archive.js.map