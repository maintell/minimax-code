import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { basename, join, dirname } from "node:path";
import { promisify } from "node:util";
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const MAX_SCREENSHOTS = 30;
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;
const MAX_SCREENSHOT_TOTAL_BYTES = 96 * 1024 * 1024;
const MAX_EXPORT_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_EXPORT_FOLDER_ATTEMPTS = 100;
const execFileAsync = promisify(execFile);
export class TrackingRecorderService {
    constructor(options) {
        this.screenshots = new Map();
        this.totalScreenshotBytes = 0;
        this.exportRoot = options.exportRoot;
        this.resolveGitMetadata = options.resolveGitMetadata ?? (async () => emptyGitMetadata());
    }
    registerScreenshot(dataUrl) {
        const buffer = decodePngDataUrl(dataUrl);
        if (buffer.byteLength > MAX_SCREENSHOT_BYTES) {
            throw new Error(`Tracking screenshot exceeds ${MAX_SCREENSHOT_BYTES} bytes`);
        }
        const screenshotId = randomUUID();
        this.screenshots.set(screenshotId, { buffer, bytes: buffer.byteLength });
        this.totalScreenshotBytes += buffer.byteLength;
        this.evictOldestScreenshots();
        return { screenshotId };
    }
    readScreenshot(screenshotId) {
        const entry = this.getScreenshot(screenshotId);
        return { dataUrl: `${PNG_DATA_URL_PREFIX}${entry.buffer.toString('base64')}` };
    }
    availableScreenshotIds(screenshotIds) {
        return [...new Set(screenshotIds)].filter((screenshotId) => this.screenshots.has(screenshotId));
    }
    releaseScreenshots(screenshotIds) {
        for (const screenshotId of new Set(screenshotIds)) {
            const entry = this.screenshots.get(screenshotId);
            if (!entry)
                continue;
            this.screenshots.delete(screenshotId);
            this.totalScreenshotBytes -= entry.bytes;
        }
    }
    async exportDirectory(request) {
        const normalized = this.normalizeExportRequest(request);
        const folderPath = await this.createUniqueExportFolder(normalized.folderName);
        try {
            const batchId = basename(folderPath);
            const gitMetadata = await this.resolveGitMetadata().catch(emptyGitMetadata);
            const screenshotsPath = join(folderPath, 'screenshots');
            await mkdir(screenshotsPath);
            await Promise.all([
                writeFile(join(folderPath, 'manifest.json'), `${JSON.stringify({ ...normalized.manifest, batchId, ...gitMetadata }, null, 2)}\n`, 'utf8'),
                writeFile(join(folderPath, 'points.json'), `${JSON.stringify({ ...normalized.points, batchId }, null, 2)}\n`, 'utf8'),
                writeFile(join(folderPath, 'review.md'), rewriteReviewBatchId(normalized.reviewMarkdown, normalized.manifest.batchId, batchId), 'utf8'),
                ...normalized.screenshots.map(({ buffer, fileName }) => writeFile(join(screenshotsPath, fileName), buffer)),
            ]);
            return { folderPath };
        }
        catch (error) {
            await rm(folderPath, { recursive: true, force: true }).catch(() => undefined);
            throw error;
        }
    }
    evictOldestScreenshots() {
        while (this.screenshots.size > MAX_SCREENSHOTS ||
            this.totalScreenshotBytes > MAX_SCREENSHOT_TOTAL_BYTES) {
            const oldestId = this.screenshots.keys().next().value;
            if (!oldestId)
                return;
            this.releaseScreenshots([oldestId]);
        }
    }
    getScreenshot(screenshotId) {
        if (typeof screenshotId !== 'string' || !screenshotId) {
            throw new Error('Invalid tracking screenshot id');
        }
        const entry = this.screenshots.get(screenshotId);
        if (!entry)
            throw new Error('Unknown or expired tracking screenshot id');
        return entry;
    }
    normalizeExportRequest(request) {
        if (!request || typeof request !== 'object') {
            throw new Error('Invalid tracking export request');
        }
        const folderName = safeExportFolderName(request.folderName);
        const manifest = validateExportManifest(request.manifest);
        validateExportText(request.pointsJson, 'pointsJson');
        validateExportText(request.reviewMarkdown, 'reviewMarkdown');
        const points = parsePointsDocument(request.pointsJson);
        if (!Array.isArray(request.screenshots) || request.screenshots.length > MAX_SCREENSHOTS) {
            throw new Error(`Too many tracking screenshots (max ${MAX_SCREENSHOTS})`);
        }
        const screenshots = request.screenshots.map((item) => {
            if (!item || typeof item !== 'object')
                throw new Error('Invalid tracking screenshot entry');
            if (typeof item.fileName !== 'string' ||
                !/^[\w.-]+\.png$/iu.test(item.fileName) ||
                basename(item.fileName) !== item.fileName) {
                throw new Error('Invalid tracking screenshot file name');
            }
            return {
                buffer: this.getScreenshot(item.screenshotId).buffer,
                fileName: item.fileName,
            };
        });
        return {
            folderName,
            manifest,
            points,
            reviewMarkdown: request.reviewMarkdown,
            screenshots,
        };
    }
    async createUniqueExportFolder(folderName) {
        await mkdir(this.exportRoot, { recursive: true });
        for (let attempt = 0; attempt < MAX_EXPORT_FOLDER_ATTEMPTS; attempt += 1) {
            const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
            const folderPath = join(this.exportRoot, `${folderName}${suffix}`);
            try {
                await mkdir(folderPath);
                return folderPath;
            }
            catch (error) {
                if (!isFileExistsError(error))
                    throw error;
            }
        }
        throw new Error(`Could not allocate a unique tracking export folder for ${folderName}`);
    }
}

export async function resolveTrackingRecorderGitMetadata(repositoryPath) {
    try {
        const repositoryRoot = await runGit(repositoryPath, ['rev-parse', '--show-toplevel']);
        const [branch, commit, status, remoteUrl, commonDirectory] = await Promise.all([
            runGit(repositoryRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
            runGit(repositoryRoot, ['rev-parse', 'HEAD']),
            runGit(repositoryRoot, ['status', '--porcelain', '--untracked-files=normal']),
            runGit(repositoryRoot, ['remote', 'get-url', 'origin']).catch(() => ''),
            runGit(repositoryRoot, ['rev-parse', '--git-common-dir']).catch(() => ''),
        ]);
        return {
            repository: resolveRepositoryName(repositoryRoot, remoteUrl, commonDirectory),
            branch: branch === 'HEAD' ? null : branch,
            commit: commit || null,
            workingTreeDirty: status.length > 0,
        };
    }
    catch {
        return emptyGitMetadata();
    }
}
function resolveRepositoryName(repositoryRoot, remoteUrl, commonDirectory) {
    const remoteName = basename(remoteUrl.replace(/\/+$/u, '')).replace(/\.git$/u, '');
    if (remoteName)
        return remoteName;
    if (commonDirectory && commonDirectory !== '.git') {
        return basename(dirname(commonDirectory));
    }
    return basename(repositoryRoot);
}
async function runGit(cwd, args) {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
        timeout: 3000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
    });
    return stdout.trim();
}
function emptyGitMetadata() {
    return {
        repository: null,
        branch: null,
        commit: null,
        workingTreeDirty: null,
    };
}
function validateExportManifest(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Invalid tracking export manifest');
    }
    const manifest = value;
    if (manifest.schemaVersion !== 2 ||
        typeof manifest.batchId !== 'string' ||
        typeof manifest.batchName !== 'string' ||
        !(typeof manifest.requirementId === 'string' || manifest.requirementId === null) ||
        !Number.isFinite(manifest.recordedAtMs) ||
        !Number.isFinite(manifest.exportedAtMs)) {
        throw new Error('Invalid tracking export manifest');
    }
    return manifest;
}
function rewriteReviewBatchId(markdown, requestedBatchId, batchId) {
    if (requestedBatchId === batchId)
        return markdown;
    return markdown.replace(`- 批次 ID：${requestedBatchId}`, `- 批次 ID：${batchId}`);
}
function parsePointsDocument(value) {
    try {
        const parsed = JSON.parse(value);
        if (!parsed ||
            Array.isArray(parsed) ||
            parsed.schemaVersion !== 2 ||
            typeof parsed.batchId !== 'string' ||
            !Array.isArray(parsed.points)) {
            throw new Error('Invalid tracking export pointsJson');
        }
        return parsed;
    }
    catch (error) {
        if (error instanceof Error && error.message === 'Invalid tracking export pointsJson') {
            throw error;
        }
        throw new Error('Invalid tracking export pointsJson');
    }
}
function decodePngDataUrl(dataUrl) {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
        throw new Error('Invalid PNG screenshot payload');
    }
    const buffer = Buffer.from(dataUrl.slice(PNG_DATA_URL_PREFIX.length), 'base64');
    if (buffer.byteLength < PNG_SIGNATURE.byteLength ||
        !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error('Invalid PNG screenshot payload');
    }
    return buffer;
}
function safeExportFolderName(value) {
    if (typeof value !== 'string')
        throw new Error('Invalid tracking export folder name');
    const safe = value
        .replace(/[\\/:*?"<>|]/gu, '-')
        .trim()
        .slice(0, 100);
    if (!safe || safe === '.' || safe === '..') {
        throw new Error('Invalid tracking export folder name');
    }
    return safe;
}
function validateExportText(value, fieldName) {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_EXPORT_TEXT_BYTES) {
        throw new Error(`Invalid tracking export ${fieldName}`);
    }
}
function isFileExistsError(error) {
    return (error instanceof Error && 'code' in error && error.code === 'EEXIST');
}
