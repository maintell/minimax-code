import { closeSync, createReadStream, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync, } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { createInterface } from 'node:readline';
function modelAccessPrivatePath(file) {
    const normalized = file.replaceAll('\\', '/');
    return (/(?:^|\/)codex-auth(?:\.|$)/u.test(normalized) ||
        /(?:^|\/)model-access\/(?:auth(?:\.|\/)|data\/|\.[^/]*account-)/u.test(normalized));
}
const DEFAULT_ERROR_LEVEL_REGEX = /^(?:ERROR|WARN|FATAL)(?:\s|$)/;
/**
 * 截止时间按文件 mtime 判断时留的余量。日级文件（如 main-YYYY-MM-DD.log）的 mtime 是当天最后
 * 一次写入，截止时间落在当天中间时，这份文件仍有截止前的内容，所以多放宽一天。
 */
const UNTIL_MTIME_GRACE_MS = 24 * 60 * 60 * 1000;
/**
 * CSI escape sequences (SGR colors, cursor movement). Log files written
 * before the disk arm started stripping ANSI (see
 * `@mavis/shared/logging/structured-logger.ts`) carry colorized level
 * tokens like `\x1b[31mERROR\x1b[39m` that no plain-text `errorRegex` can
 * match; scanning the stripped line keeps those historical files eligible
 * for error-context extraction during their remaining retention window.
 */
const ANSI_CSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
function stripAnsi(line) {
    return line.includes('\u001b') ? line.replace(ANSI_CSI_PATTERN, '') : line;
}
export class FileDiagnosticArtifactSource {
    id;
    label;
    dir;
    match;
    prefix;
    recursive;
    privacy;
    uploadDefault;
    maxBytesPerFile;
    errorContext;
    sinceMs;
    untilMs;
    constructor(options) {
        this.id = options.id;
        this.label = options.label;
        this.dir = options.dir;
        this.match = options.match;
        this.prefix = options.prefix;
        this.recursive = options.recursive ?? false;
        this.privacy = options.privacy ?? 'sensitive';
        this.uploadDefault = options.uploadDefault ?? 'consent-required';
        this.maxBytesPerFile = options.maxBytesPerFile;
        this.errorContext = options.errorContext;
        this.sinceMs = options.sinceMs;
        this.untilMs = options.untilMs;
    }
    describe() {
        return {
            label: this.label,
            privacy: this.privacy,
            uploadDefault: this.uploadDefault,
        };
    }
    async collect(input) {
        let entries;
        let dirRealPath;
        try {
            dirRealPath = realpathSync(this.dir);
            entries = this.recursive
                ? listRecursiveFiles(this.dir, this.match)
                : readdirSync(this.dir)
                    .filter((name) => this.match(name, name))
                    .sort()
                    .map((name) => ({ relativeName: name, absolutePath: join(this.dir, name) }));
        }
        catch {
            return [];
        }
        const artifacts = [];
        for (const { entry, stat } of this.newestFirst(entries, input)) {
            if (modelAccessPrivatePath(entry.absolutePath))
                continue;
            try {
                const artifact = await this.collectFile(entry, stat, dirRealPath, input);
                if (artifact)
                    artifacts.push(artifact);
            }
            catch {
                // Files can disappear or become unreadable while collection is running.
                continue;
            }
        }
        return artifacts;
    }
    /**
     * 只留时间窗口内的普通文件，按 mtime 从新到旧排：总量装不下时，被丢掉的是最旧的文件。
     * 截止时间多放宽 UNTIL_MTIME_GRACE_MS。
     */
    newestFirst(entries, input) {
        const sinceMs = this.sinceMs ?? input.sinceMs;
        const latestMtimeMs = (this.untilMs ?? input.untilMs ?? Number.POSITIVE_INFINITY) + UNTIL_MTIME_GRACE_MS;
        const candidates = [];
        for (const entry of entries) {
            try {
                const stat = lstatSync(entry.absolutePath);
                if (stat.isSymbolicLink() || !stat.isFile())
                    continue;
                if (stat.mtimeMs < sinceMs || stat.mtimeMs > latestMtimeMs)
                    continue;
                candidates.push({ entry, stat });
            }
            catch {
                // Files can disappear or become unreadable while collection is running.
                continue;
            }
        }
        return candidates.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs ||
            left.entry.relativeName.localeCompare(right.entry.relativeName));
    }
    async collectFile(entry, stat, dirRealPath, input) {
        const path = entry.absolutePath;
        if (!isPathInside(dirRealPath, realpathSync(path)))
            return undefined;
        if (this.errorContext) {
            const content = await extractErrorContext(path, stat.mtimeMs, input.nowMs, this.errorContext);
            return content ? this.artifact(entry.relativeName, Buffer.from(content, 'utf-8')) : undefined;
        }
        if (this.maxBytesPerFile && stat.size > this.maxBytesPerFile) {
            return this.artifact(entry.relativeName, tailFile(path, this.maxBytesPerFile));
        }
        return {
            name: `${this.prefix}${entry.relativeName.replaceAll('\\', '/')}`,
            path,
            bytes: stat.size,
            source: this.id,
            privacy: this.privacy,
            uploadDefault: this.uploadDefault,
        };
    }
    artifact(fileName, content) {
        return {
            name: `${this.prefix}${fileName.replaceAll('\\', '/')}`,
            content,
            bytes: content.byteLength,
            source: this.id,
            privacy: this.privacy,
            uploadDefault: this.uploadDefault,
        };
    }
}
function listRecursiveFiles(root, match) {
    const results = [];
    const visit = (dir, relativeDir) => {
        for (const name of readdirSync(dir).sort()) {
            const absolutePath = join(dir, name);
            const relativeName = relativeDir ? `${relativeDir}/${name}` : name;
            let info;
            try {
                info = lstatSync(absolutePath);
            }
            catch {
                continue;
            }
            if (info.isSymbolicLink())
                continue;
            if (info.isDirectory()) {
                visit(absolutePath, relativeName);
                continue;
            }
            if (!info.isFile() || !match(name, relativeName))
                continue;
            results.push({ relativeName, absolutePath });
        }
    };
    const rootStat = statSync(root);
    if (!rootStat.isDirectory())
        return [];
    visit(root, '');
    return results;
}
export class StaticDiagnosticArtifactSource {
    id;
    label;
    artifacts;
    constructor(id, label, artifacts) {
        this.id = id;
        this.label = label;
        this.artifacts = artifacts;
    }
    describe() {
        let privacy = 'safe';
        if (this.artifacts.some((artifact) => artifact.privacy === 'sensitive')) {
            privacy = 'sensitive';
        }
        else if (this.artifacts.some((artifact) => artifact.privacy === 'masked')) {
            privacy = 'masked';
        }
        let uploadDefault = 'include';
        if (this.artifacts.some((artifact) => artifact.uploadDefault === 'consent-required')) {
            uploadDefault = 'consent-required';
        }
        else if (this.artifacts.some((artifact) => artifact.uploadDefault === 'exclude')) {
            uploadDefault = 'exclude';
        }
        return { label: this.label, privacy, uploadDefault };
    }
    async collect() {
        return this.artifacts;
    }
}
function resolveBundleLimits(limits) {
    return {
        maxFiles: limits?.maxFiles ?? 256,
        maxBytes: limits?.maxBytes ?? 512 * 1024 * 1024,
    };
}
/** 截止时间只在传了的时候出现在采集参数和清单里。 */
function untilWindow(untilMs) {
    return untilMs === undefined ? {} : { untilMs };
}
/** A source's artifacts, or none and the reason it failed. */
async function collectSource(source, input) {
    try {
        return { collected: await source.collect(input) };
    }
    catch (err) {
        return { collected: [], failure: err instanceof Error ? err.message : String(err) };
    }
}
export async function collectDiagnosticBundle(input) {
    const limits = resolveBundleLimits(input.limits);
    const nowMs = input.nowMs ?? Date.now();
    const window = untilWindow(input.untilMs);
    const collectInput = {
        sinceMs: input.sinceMs,
        ...window,
        nowMs,
        limits,
    };
    const artifacts = [];
    const manifestSources = [];
    let totalBytes = 0;
    const skippedArtifacts = [];
    for (const source of input.sources) {
        const description = source.describe();
        const { collected, failure } = await collectSource(source, collectInput);
        let skipped = failure;
        const accepted = [];
        for (const artifact of collected) {
            if (modelAccessPrivatePath(artifact.path ?? artifact.name)) {
                skippedArtifacts.push({ name: artifact.name, reason: 'private_model_access_credential' });
                continue;
            }
            if (artifacts.length + accepted.length + 1 > limits.maxFiles) {
                skipped = 'diagnostic_bundle_too_many_files';
                break;
            }
            if (totalBytes + artifact.bytes > limits.maxBytes) {
                skipped = 'diagnostic_bundle_too_large';
                skippedArtifacts.push({ name: artifact.name, reason: skipped });
                continue;
            }
            accepted.push(artifact);
            totalBytes += artifact.bytes;
        }
        artifacts.push(...accepted);
        manifestSources.push({
            id: source.id,
            label: description.label,
            privacy: description.privacy,
            uploadDefault: description.uploadDefault,
            fileCount: accepted.length,
            bytes: accepted.reduce((sum, artifact) => sum + artifact.bytes, 0),
            ...(skipped ? { skipped } : {}),
        });
    }
    return {
        artifacts,
        manifest: {
            schemaVersion: 1,
            generatedAtMs: nowMs,
            sinceMs: input.sinceMs,
            ...window,
            sources: manifestSources,
            artifacts: artifacts.map((artifact) => ({
                name: artifact.name,
                source: artifact.source,
                bytes: artifact.bytes,
                privacy: artifact.privacy,
                uploadDefault: artifact.uploadDefault,
            })),
            limits,
            totalFiles: artifacts.length,
            totalBytes,
            ...(skippedArtifacts.length > 0 ? { skippedArtifacts } : {}),
        },
    };
}
function isPathInside(root, child) {
    const rel = relative(root, child);
    return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}
function tailFile(path, maxBytes) {
    const fd = openSync(path, 'r');
    try {
        const { size } = fstatSync(fd);
        const readBytes = Math.min(size, maxBytes);
        const buffer = Buffer.alloc(readBytes);
        readSync(fd, buffer, 0, readBytes, Math.max(0, size - readBytes));
        if (size <= maxBytes)
            return buffer;
        const marker = Buffer.from('\n... [truncated to tail] ...\n', 'utf-8');
        return Buffer.concat([marker, buffer]);
    }
    finally {
        closeSync(fd);
    }
}
async function extractErrorContext(path, mtimeMs, nowMs, config) {
    const errorRegex = config.errorRegex ?? DEFAULT_ERROR_LEVEL_REGEX;
    const stream = createReadStream(path, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
    const before = [];
    const output = [];
    let bytes = 0;
    let lineIndex = 0;
    let lastEmittedIndex = -1;
    let afterUntil = -1;
    let hitCount = 0;
    let truncated = false;
    const emitLine = (index, line) => {
        if (index <= lastEmittedIndex)
            return true;
        if (lastEmittedIndex >= 0 && index > lastEmittedIndex + 1) {
            output.push('... [context skipped] ...');
        }
        bytes += Buffer.byteLength(line, 'utf-8') + 1;
        if (bytes > config.maxOutputBytes) {
            output.push('... [truncated] ...');
            truncated = true;
            return false;
        }
        output.push(line);
        lastEmittedIndex = index;
        return true;
    };
    const consumeLine = (line) => {
        if (errorRegex.test(line)) {
            hitCount += 1;
            before.every((entry) => emitLine(entry.index, entry.line));
            if (!truncated)
                emitLine(lineIndex, line);
            afterUntil = Math.max(afterUntil, lineIndex + config.contextLines);
        }
        else if (lineIndex <= afterUntil) {
            emitLine(lineIndex, line);
        }
        if (truncated)
            return;
        before.push({ index: lineIndex, line });
        while (before.length > config.contextLines)
            before.shift();
        lineIndex += 1;
    };
    try {
        for await (const rawLine of rl) {
            // Match and emit the ANSI-stripped line: historical colorized files
            // stay scannable and the extracted context reads as plain text.
            consumeLine(stripAnsi(rawLine));
            if (truncated)
                break;
        }
    }
    finally {
        rl.close();
        stream.destroy();
    }
    if (hitCount === 0) {
        if (nowMs - mtimeMs > config.fallbackRecentMs)
            return null;
        return tailFile(path, config.fallbackTailBytes).toString('utf-8');
    }
    return output.join('\n');
}
//# sourceMappingURL=diagnostic-bundle.js.map