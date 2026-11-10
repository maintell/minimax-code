var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
import { attachProgrammaticErrorData, bindTool, withProgrammaticResult, } from '@mavis/agent-core/tools';
import { sanitizeBashSubprocessEnv } from '@mavis/agent-core/bash-subprocess-env';
import { logger } from '@mavis/shared/local-runtime-logging/logger';
import { createBashTool, createEditTool, createReadTool, createWriteTool, DEFAULT_MAX_LINES, } from '@earendil-works/pi-coding-agent/tools';
import { getShellConfig } from '@earendil-works/pi-coding-agent/shell';
import { IMAGE_DIMENSION_HEADER_BYTES, parseImageDimensionsFromBytes, } from '@mavis/shared/image-dimensions';
import { access, readFile, stat } from '../shared/physical-fs.js';
import { basename, extname, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';
import { homedir, release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { resolveBashDescription } from './local-bash-input.js';
import { DEFAULT_FOREGROUND_BASH_SOFT_YIELD_MS, resolveLocalBashTiming, validateBashCommand, withLocalBashTiming, } from './local-bash-timing.js';
import { localBashResultFromError, localBashResultFromPi, readBashExecutionOutcome, } from './local-bash-result.js';
import { LocalBashToolDef, LocalEditToolDef, LocalReadToolDef, LocalWriteToolDef, } from './builtin-defs.js';
import { executeLocalHostTrashIfRequested, } from './host-trash-executor.js';
import { copyWithPermissionExecutionPlan, readPermissionExecutionPlan, resolvePermissionBashEnvPolicy, } from './permission-execution.js';
import { inferReadVideoMimeType, readVideoAsToolResult } from '../shared/read-video.js';
import { readNativeMediaAsToolResult } from '../shared/read-native-media.js';
import { nativeAudioMimeForExtension } from '../shared/multimodal-attachments.js';
import { buildReplaceAllEdit, ReplaceAllError, withReplaceAllCount, } from '../shared/replace-all-edit.js';
import { checkBlockedDeviceRead, checkNonRegularFileRead, detectBinaryRead, detectPiSupportedImageMimeTypeFromFile, } from '../shared/read-guards.js';
import { isPdfReadPath, readPdfAsToolResult } from '../shared/read-pdf.js';
import { isNotebookReadPath, readNotebookAsToolResult } from '../shared/read-notebook.js';
import { piReadResultToToolResult, readErrorResult } from '../shared/read-result.js';
import { READ_MAX_LINE_CHARS } from '../shared/read-contract.js';
import { withDesktopCompletenessReport } from './ptc-result-projection.js';
import { executeEditWithLineNumberRetry, normalizeEditsForLineNumberRetry, } from '../shared/edit-line-number-retry.js';
import { createCapturingEditOperations } from '../shared/edit-capture.js';
import { withCompatibleBashToolResponseFromPiDetails, withCompatibleEditToolResponse, } from '../plugin-hooks/vendor-tool-response.js';
import { buildWriteToolResult, createCapturingWriteOperations } from '../shared/write-capture.js';
import { assertOverwriteAllowed, isRememberedVersionCurrent, observeFileVersion, rememberCurrentFileVersion, rememberFileVersion, WriteGuardRejectedError, writeGuardRejectedResult, } from '../shared/file-read-ledger.js';
import { applyDesktopTextLimit, DESKTOP_BASH_MAX_BYTES, DESKTOP_BASH_PREVIEW_BYTES, DESKTOP_BASH_MAX_OUTPUT_BYTES, DESKTOP_BASH_MAX_PENDING_OUTPUT_BYTES, DESKTOP_READ_TEXT_MAX_BYTES, isPtcChildCall, limitDesktopHeadTailLines, limitDesktopPrefixLines, PTC_CHILD_FULL_OUTPUT_MAX_BYTES, withDesktopOutputContinuation, } from './output-limit.js';
export function getLocalBashEnvironment() {
    let shell = 'unavailable';
    try {
        // Windows prompt preparation uses the Session binding (or pending), never
        // Pi's synchronous auto-discovery. Unix keeps the existing executor choice.
        if (process.platform !== 'win32') {
            const selected = getShellConfig();
            shell = `${selected.type} (${selected.shell})`;
        }
    }
    catch {
        // Missing shell support must not prevent turns using other tools.
    }
    return {
        platform: process.platform,
        osVersion: `${process.platform} ${release()} ${process.arch}`,
        shell,
    };
}
/**
 * Pi's read tool for one call, recording in `piRead` the file it opens.
 * `uncapped` is the run_code child variant: no line limit, and Pi's byte limit
 * raised to PTC_CHILD_FULL_OUTPUT_MAX_BYTES, so an over-budget window is cut
 * by Pi before it becomes one huge numbered string (the read then falls back).
 */
function createObservedReadTool(workspaceRoot, piRead, uncapped) {
    // The host's request media extension encodes every tool result image to
    // `requestMedia.image`; a second resize here would cap it and add a note.
    return createReadTool(workspaceRoot, {
        autoResizeImages: false,
        operations: {
            access,
            detectImageMimeType: detectPiSupportedImageMimeTypeFromFile,
            async readFile(path) {
                piRead.reached = true;
                piRead.observed = await observeFileVersion(path);
                return readFile(path);
            },
        },
        ...(uncapped
            ? {
                truncation: {
                    maxLines: Number.POSITIVE_INFINITY,
                    maxBytes: PTC_CHILD_FULL_OUTPUT_MAX_BYTES,
                },
            }
            : {}),
    });
}
let LocalReadTool = (() => {
    let _classDecorators = [bindTool(LocalReadToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var LocalReadTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            LocalReadTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        workspaceRoot;
        constructor(workspaceRoot) {
            this.workspaceRoot = workspaceRoot;
        }
        async execute(ctx, input, signal) {
            try {
                return await this.read(ctx, input, signal);
            }
            catch (error) {
                // Pi keeps only the message; PTC data still says what kind of read failed.
                attachProgrammaticErrorData(error, { kind: readKind(input.path) });
                throw error;
            }
        }
        async read(ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            const readAbs = await resolveLocalReadPath(input.path, this.workspaceRoot);
            // Guard order (design doc §3): the device check comes first because
            // every later step that opens the file (binary sampling, PDF/notebook
            // parsing, pi itself) would hang forever on /dev/zero-style paths.
            const deviceError = checkBlockedDeviceRead(readAbs);
            if (deviceError)
                return withReadKind(readErrorResult(LocalReadToolDef.name, deviceError), 'text');
            // Closes the FIFO/socket/block-device blind spot the path-only device
            // guard misses (one stat, follows symlinks) — a named pipe would block
            // the whole turn just like /dev/zero.
            const irregularError = await checkNonRegularFileRead(readAbs);
            if (irregularError) {
                return withReadKind(readErrorResult(LocalReadToolDef.name, irregularError), 'text');
            }
            // Stat before reading: if the file changes during the read, the recorded
            // version is already stale and a later overwrite asks for a fresh read.
            // An existing regular file is recorded even when read refuses or fails
            // (binary content, blocked extension, no read permission): read cannot
            // show those by design, and write must still be able to overwrite them.
            // Missing and non-regular files record nothing.
            const observed = await observeFileVersion(readAbs);
            const piRead = { reached: false };
            try {
                return await this.readRegularFile(ctx, input, readAbs, piRead, signal);
            }
            finally {
                const seen = piRead.reached ? piRead.observed : observed;
                if (seen && !signal?.aborted)
                    rememberFileVersion(ctx.sessionId, seen);
            }
        }
        async readRegularFile(ctx, input, readAbs, piRead, signal) {
            // pi natively inlines images (jpg/png/gif/webp). Video is not part of
            // pi's built-in mime detection, so we mirror cloud-runtime here: when
            // the path looks like an inline-capable video, run the shared helper
            // first and fall through to pi only when (a) the extension is not a
            // recognised video, or (b) the candidate path does not exist (let pi's
            // NFD / curly-quote / AM-PM fallbacks have a chance to find the file).
            const videoMime = inferReadVideoMimeType(readAbs);
            if (videoMime) {
                try {
                    return withReadKind(await readVideoAsToolResult({
                        toolName: LocalReadToolDef.name,
                        absolutePath: readAbs,
                        mimeType: videoMime,
                        capabilities: ctx.parentAgentConfig?.model?.capabilities,
                        signal,
                    }), 'video');
                }
                catch (err) {
                    if (!isFsNotFoundError(err))
                        throw err;
                    // ENOENT — let pi retry with its macOS-aware path variants.
                }
            }
            // Audio and PDF go inline only for a model that reads them natively
            // (Gemini); otherwise audio hits the binary guard and PDF is extracted.
            const audioMime = nativeAudioMimeForExtension(extname(readAbs));
            if (audioMime) {
                const audio = await this.readNativeMedia(ctx, readAbs, 'audio', audioMime, signal);
                if (audio)
                    return withReadKind(audio, 'audio');
            }
            // PDF / notebook dispatch: these never reach pi (which would read them
            // as UTF-8 garbage / raw JSON). A page range always uses text extraction.
            if (isPdfReadPath(readAbs)) {
                const native = input.pages === undefined
                    ? await this.readNativeMedia(ctx, readAbs, 'pdf', 'application/pdf', signal)
                    : undefined;
                return withReadKind(native ??
                    (await readPdfAsToolResult({
                        toolName: LocalReadToolDef.name,
                        absolutePath: readAbs,
                        pages: input.pages,
                        signal,
                    })), 'pdf');
            }
            if (isNotebookReadPath(readAbs)) {
                return withReadKind(await readNotebookAsToolResult({
                    toolName: LocalReadToolDef.name,
                    absolutePath: readAbs,
                    signal,
                }), 'notebook');
            }
            // Binary guard: pi would decode anything else as UTF-8 — turn silent
            // garbage into an explicit, recoverable tool error.
            const binary = await detectBinaryRead(readAbs);
            if (binary.binary) {
                return withReadKind(readErrorResult(LocalReadToolDef.name, binary.message), 'text');
            }
            // Strip `pages` before delegating: pi's read schema does not know the
            // parameter, and models occasionally send it for non-PDF files.
            const { pages: _pages, ...piInput } = input;
            // Pi resolves the path itself (strips `@`, normalizes whitespace), so it
            // may read another file than readAbs. Both reads below record the file pi
            // actually reads, as seen just before reading, so the key matches the file
            // write targets; when the child read falls back, the second read wins.
            // A run_code child reads the whole file, or exactly offset/limit: Pi's
            // 2000-line / 50 KB head limit, the 2000-character line cap and the
            // Desktop 24 KiB cap are for the model (see isPtcChildCall). Over
            // PTC_CHILD_FULL_OUTPUT_MAX_BYTES it gets the direct-call page and the
            // offset to continue instead, like a Bash child's preview.
            if (isPtcChildCall(ctx) && !(await fileOverPtcReadBudget(readAbs, input.limit))) {
                const res = await createObservedReadTool(this.workspaceRoot, piRead, true).execute('', piInput, signal);
                const result = piReadResultToToolResult(LocalReadToolDef.name, res, {
                    offset: input.offset,
                    maxLineChars: Number.POSITIVE_INFINITY,
                });
                if (!textOverPtcReadBudget(result)) {
                    return withReadProgrammaticResult(result, input.limit, readCapSkipped(result));
                }
            }
            const res = await createObservedReadTool(this.workspaceRoot, piRead, false).execute('', piInput, signal);
            const result = piReadResultToToolResult(LocalReadToolDef.name, res, {
                offset: input.offset,
            });
            return withReadProgrammaticResult(limitDesktopReadTextResult(result, input.offset), input.limit);
        }
        async readNativeMedia(ctx, absolutePath, kind, mimeType, signal) {
            try {
                return await readNativeMediaAsToolResult({
                    toolName: LocalReadToolDef.name,
                    absolutePath,
                    kind,
                    mimeType,
                    capabilities: ctx.parentAgentConfig?.model?.capabilities,
                    signal,
                });
            }
            catch (err) {
                // ENOENT: let the later readers and pi's path variants report it.
                if (isFsNotFoundError(err))
                    return undefined;
                throw err;
            }
        }
    };
    return LocalReadTool = _classThis;
})();
export { LocalReadTool };
/**
 * A child read without `limit` would return the whole file: over the budget
 * it takes the direct-call path without loading the file twice. With a
 * `limit` the window may be small even in a large file, so only its text is
 * checked (textOverPtcReadBudget). An unreadable size is left to Pi.
 */
async function fileOverPtcReadBudget(path, limit) {
    if (limit !== undefined)
        return false;
    try {
        return (await stat(path)).size > PTC_CHILD_FULL_OUTPUT_MAX_BYTES;
    }
    catch {
        return false;
    }
}
/** Pi cut the window at the raised byte limit, or the numbered text is still over it. */
function textOverPtcReadBudget(result) {
    const truncation = result.details?.truncation;
    return (truncation?.truncated === true ||
        Buffer.byteLength(result.text, 'utf8') > PTC_CHILD_FULL_OUTPUT_MAX_BYTES);
}
/**
 * Whether a direct read would have cut this uncapped child read. The Desktop
 * 24 KiB check also covers Pi's 50 KB limit, since the numbered text is never
 * shorter than the file text it shows.
 */
function readCapSkipped(result) {
    const textFile = result.details?.textFile;
    if (!textFile || typeof textFile.content !== 'string')
        return false;
    if (Buffer.byteLength(result.text, 'utf8') > DESKTOP_READ_TEXT_MAX_BYTES)
        return true;
    if (typeof textFile.numLines === 'number' && textFile.numLines > DEFAULT_MAX_LINES)
        return true;
    return textFile.content
        .split('\n')
        .some((line) => line.length > READ_MAX_LINE_CHARS && Array.from(line).length > READ_MAX_LINE_CHARS);
}
/**
 * PTC payload of a text read: the window's original text without line
 * numbers, cut exactly where the output was cut (Desktop 24 KiB prefix,
 * 2000-character lines) so data never shows more than the model text, plus
 * the completeness statement. A read that stopped at the caller's `limit`
 * with lines left is complete but reports hasMore and the next line offset.
 */
function withReadProgrammaticResult(result, limit, uncappedOutput = false) {
    const data = readTextData(result);
    if (!data) {
        const image = readImageData(result);
        return withDesktopCompletenessReport(LocalReadToolDef.name, result, image ? { data: image } : {});
    }
    // Only a caller's `limit` stops a complete read early; without one Pi reads
    // to the end or marks a cut. Same condition and offset as Pi's own
    // "[N more lines in file. Use offset=X to continue.]" (Pi core/tools/read.ts),
    // whose line count includes the empty piece after a trailing newline, so
    // data and model text never disagree.
    const more = limit !== undefined && Number.isSafeInteger(limit) && limit > 0
        ? data.startLine - 1 + limit < data.totalLines
        : false;
    return withDesktopCompletenessReport(LocalReadToolDef.name, result, {
        data,
        ...(more && limit !== undefined
            ? { more: { nextOffset: data.startLine + limit, offsetUnit: 'line' } }
            : {}),
        ...(uncappedOutput ? { uncappedOutput } : {}),
    });
}
/**
 * Metadata of an image read. autoResizeImages is off, so Pi returns the file
 * itself (the request media step sizes it later, reported as media delivery)
 * and its size is also the original size. Only the header is decoded.
 */
function readImageData(result) {
    const images = result.content.filter((block) => block.type === 'image');
    const image = images.length === 1 ? images[0] : undefined;
    if (!image || image.type !== 'image' || !image.mimeType.startsWith('image/'))
        return undefined;
    const headerChars = Math.ceil(IMAGE_DIMENSION_HEADER_BYTES / 3) * 4;
    const size = parseImageDimensionsFromBytes(Buffer.from(image.data.slice(0, headerChars), 'base64'));
    return {
        kind: 'image',
        mimeType: image.mimeType,
        ...(size
            ? {
                width: size.width,
                height: size.height,
                originalWidth: size.width,
                originalHeight: size.height,
            }
            : {}),
    };
}
function withReadKind(result, kind) {
    return withProgrammaticResult(result, { data: { kind } });
}
/** What a failed read was trying to read, from the path alone (the file may not exist). */
function readKind(path) {
    if (inferReadVideoMimeType(path))
        return 'video';
    if (isPdfReadPath(path))
        return 'pdf';
    if (isNotebookReadPath(path))
        return 'notebook';
    return /\.(png|jpe?g|gif|webp)$/iu.test(path) ? 'image' : 'text';
}
function readTextData(result) {
    const textFile = result.details?.textFile;
    if (!textFile || typeof textFile !== 'object' || Array.isArray(textFile))
        return undefined;
    if (result.content.some((block) => block.type !== 'text'))
        return undefined;
    const { content, startLine, numLines, totalLines } = textFile;
    if (typeof content !== 'string' ||
        !isPositiveInteger(startLine) ||
        !isNonNegativeInteger(numLines) ||
        !isNonNegativeInteger(totalLines)) {
        return undefined;
    }
    let lines = content.split('\n');
    let lineCount = numLines;
    if (result.details?.desktop_output_truncation !== undefined) {
        // The Desktop cap kept a prefix of numbered lines; the last one it kept ends the data.
        const lastShown = lastNumberedLine(result.text);
        lines = lines.slice(0, lastShown === undefined ? 0 : Math.max(0, lastShown - startLine + 1));
        lineCount = lines.length;
    }
    const cutLines = new Set(Array.isArray(result.details?.line_truncations) ? result.details.line_truncations : []);
    const shown = lines.map((line, index) => cutLines.has(startLine + index)
        ? Array.from(line).slice(0, READ_MAX_LINE_CHARS).join('')
        : line);
    return { kind: 'text', content: shown.join('\n'), startLine, lineCount, totalLines };
}
function lastNumberedLine(text) {
    const lines = text.split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const match = lines[index]?.match(/^\s*(\d+)→/);
        if (match?.[1])
            return Number(match[1]);
    }
    return undefined;
}
function isPositiveInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function isNonNegativeInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function limitDesktopReadTextResult(result, requestedOffset) {
    if (result.content.some((block) => block.type !== 'text'))
        return result;
    const truncation = result.details?.truncation;
    if (result.details?.media !== undefined || truncation?.firstLineExceedsLimit === true) {
        return result;
    }
    const fallbackOffset = requestedOffset !== undefined && requestedOffset > 0 ? requestedOffset : 1;
    const nextOffsetFor = (lines) => {
        for (let index = lines.length - 1; index >= 0; index -= 1) {
            const match = lines[index]?.match(/^\s*(\d+)→/);
            if (match?.[1])
                return Number(match[1]) + 1;
        }
        return fallbackOffset;
    };
    let limited = limitDesktopPrefixLines(result.text, {
        maxBytes: DESKTOP_READ_TEXT_MAX_BYTES,
        notice: ({ originalBytes, retainedLines }) => {
            const nextOffset = nextOffsetFor(retainedLines);
            return (`[desktop read output truncated: original_bytes=${originalBytes}; ` +
                `if the omitted remainder is needed, continue with read using offset=${nextOffset} and the same path.]`);
        },
    });
    if (limited.truncation) {
        const noticeIndex = limited.text.lastIndexOf('\n\n[');
        const retainedLines = (noticeIndex >= 0 ? limited.text.slice(0, noticeIndex) : limited.text).split('\n');
        const nextOffset = nextOffsetFor(retainedLines);
        limited = withDesktopOutputContinuation(limited, {
            next_offset: nextOffset,
            offset_unit: 'line',
            continuation_hint: {
                tool: 'read',
                preserve_args: ['path'],
                instruction: `If the omitted remainder is needed, call read again with offset=${nextOffset}; ` +
                    'preserve the same path.',
            },
        });
    }
    return applyDesktopTextLimit(result, limited);
}
let LocalWriteTool = (() => {
    let _classDecorators = [bindTool(LocalWriteToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var LocalWriteTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            LocalWriteTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        workspaceRoot;
        observeGuardCheck;
        constructor(workspaceRoot, observeGuardCheck) {
            this.workspaceRoot = workspaceRoot;
            this.observeGuardCheck = observeGuardCheck;
        }
        /** Diagnostics only: a throwing observer must not change what the write does. */
        reportGuardCheck(result) {
            try {
                this.observeGuardCheck?.(result);
            }
            catch {
                // The write already has its own outcome; observation never overrides it.
            }
        }
        async execute(ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            // Per-execute capture context. This tool instance is a process-level
            // singleton (buildLocalToolRegistry), so an instance-level pending map
            // would be shared across concurrent writes; binding capture to a single
            // execute keeps each write's byte count / diff its own. The injected
            // writeFile still runs inside pi's withFileMutationQueue slot: it captures
            // the old file (BOM/encoding/content) and writes with the preserved
            // encoding — see write-capture.ts / design doc. In the same slot the guard
            // refuses to overwrite a file this session has not read, or that changed
            // after its last read (file-read-ledger.ts).
            const { operations, takeCapture } = createCapturingWriteOperations({
                guard: {
                    beforeWrite: async (path, current) => {
                        // No regular file to overwrite: the guard has nothing to compare.
                        if (!current) {
                            this.reportGuardCheck('new_file');
                            return;
                        }
                        try {
                            await assertOverwriteAllowed(ctx.sessionId, path, current);
                        }
                        catch (err) {
                            if (err instanceof WriteGuardRejectedError) {
                                this.reportGuardCheck(err.code === 'WRITE_NOT_READ' ? 'not_read' : 'stale_read');
                            }
                            throw err;
                        }
                        this.reportGuardCheck('allowed');
                    },
                    afterWrite: (path) => rememberCurrentFileVersion(ctx.sessionId, path),
                },
            });
            const tool = createWriteTool(this.workspaceRoot, { operations });
            let res;
            try {
                res = await executeWithFailurePath(input.path, () => tool.execute('', input, signal));
            }
            catch (err) {
                if (!(err instanceof WriteGuardRejectedError))
                    throw err;
                logger.warn({
                    sessionId: ctx.sessionId,
                    path: writeGuardLogPath(input.path, this.workspaceRoot),
                    reason: err.code,
                    recordedVersion: err.recorded ?? null,
                    currentVersion: err.current,
                }, 'write guard refused to overwrite file');
                return writeGuardRejectedResult(LocalWriteToolDef.name, input.path, err.code);
            }
            const capture = takeCapture(resolveLocalCandidatePath(input.path, this.workspaceRoot));
            const result = buildWriteToolResult(LocalWriteToolDef.name, input.path, input.content, capture, toToolResult(LocalWriteToolDef.name, res).text);
            const created = result.details?.created;
            const bytesWritten = result.details?.bytes_written;
            return withDesktopCompletenessReport(LocalWriteToolDef.name, result, {
                data: {
                    path: input.path,
                    ...(typeof created === 'boolean' ? { created } : {}),
                    ...(typeof bytesWritten === 'number' ? { bytesWritten } : {}),
                },
            });
        }
    };
    return LocalWriteTool = _classThis;
})();
export { LocalWriteTool };
let LocalEditTool = (() => {
    let _classDecorators = [bindTool(LocalEditToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var LocalEditTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            LocalEditTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        workspaceRoot;
        constructor(workspaceRoot) {
            this.workspaceRoot = workspaceRoot;
        }
        async execute(ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            // Translate the compatible style public schema (file_path + old_string +
            // new_string + optional replace_all) into pi's internal
            // { path, edits: [{ oldText, newText }] } shape so we still get
            // pi's BOM strip / line-ending restore / unified-diff /
            // withFileMutationQueue locking for free. The execution is then routed
            // through the line-number-retry wrapper so a model that pasted read's
            // `N→` prefixes into old_string still recovers (CR !4027 P1).
            // Edit does not require a read. It only refreshes a read record that
            // still matches the file, so the session can overwrite its own edit
            // without reading again.
            const capture = createCapturingEditOperations({
                isRecordCurrent: (path) => isRememberedVersionCurrent(ctx.sessionId, path),
                refresh: (path) => rememberCurrentFileVersion(ctx.sessionId, path),
            });
            const { piInput, piResult } = await executeWithFailurePath(input.file_path, async () => {
                const prepared = await buildPiEditInput(input, this.workspaceRoot);
                const tool = createEditTool(this.workspaceRoot, { operations: capture.operations });
                return {
                    piInput: prepared,
                    piResult: await executeEditWithLineNumberRetry(tool, prepared, signal),
                };
            });
            const res = piInput.replacedCount === undefined
                ? piResult
                : withReplaceAllCount(piResult, piInput.path, piInput.replacedCount);
            const result = toToolResult(LocalEditToolDef.name, res);
            const editCapture = capture.takeCapture(resolveLocalCandidatePath(input.file_path, this.workspaceRoot));
            // replace_all counts every occurrence it replaced; a single edit replaces one.
            const data = {
                path: input.file_path,
                replacements: piInput.replacedCount ?? 1,
                replaceAll: input.replace_all === true,
            };
            if (!editCapture)
                return withDesktopCompletenessReport(LocalEditToolDef.name, result, { data });
            const normalized = result.details?.line_number_prefixes_stripped === true
                ? normalizeEditsForLineNumberRetry([
                    { oldText: input.old_string, newText: input.new_string },
                ])?.[0]
                : undefined;
            return withDesktopCompletenessReport(LocalEditToolDef.name, withCompatibleEditToolResponse(result, {
                filePath: editCapture.path,
                oldString: normalized?.oldText ?? input.old_string,
                newString: normalized?.newText ?? input.new_string,
                originalFile: editCapture.originalFile,
                replaceAll: input.replace_all === true,
                userModified: false,
            }), { data });
        }
    };
    return LocalEditTool = _classThis;
})();
export { LocalEditTool };
/** Runs a write or edit and, when it throws, leaves the path in PTC data. */
async function executeWithFailurePath(path, run) {
    try {
        return await run();
    }
    catch (error) {
        attachProgrammaticErrorData(error, { path });
        throw error;
    }
}
/**
 * Translate LocalEditTool's compatible style input into the `{ path, edits }`
 * shape pi's `createEditTool` expects. `replace_all: true` collapses
 * every occurrence of `old_string` into a single full-file replacement
 * driven through pi's own edit pipeline (see `replace-all-edit.ts` for
 * why we don't model each occurrence as its own edit).
 */
async function buildPiEditInput(input, workspaceRoot) {
    if (input.replace_all === true) {
        // replace_all reads the file itself (outside pi), so it MUST resolve the
        // path exactly like pi's createEditTool does: workspace-relative paths
        // resolve against workspaceRoot, never the runtime process cwd (which is
        // wherever Electron/CLI launched, not the session workspace). Without this,
        // a relative file_path that single-edit handles fine ENOENTs here. Mirrors
        // cloud-edit's resolveWithinWorkspace-before-buildReplaceAllEdit order.
        const absolutePath = resolveLocalCandidatePath(input.file_path, workspaceRoot);
        try {
            const replacement = await buildReplaceAllEdit(absolutePath, input.old_string, input.new_string);
            return {
                path: replacement.path,
                edits: replacement.edits,
                replacedCount: replacement.replacedCount,
            };
        }
        catch (err) {
            if (err instanceof ReplaceAllError) {
                throw new Error(err.message);
            }
            throw err;
        }
    }
    return {
        path: input.file_path,
        edits: [{ oldText: input.old_string, newText: input.new_string }],
    };
}
let LocalBashTool = (() => {
    let _classDecorators = [bindTool(LocalBashToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var LocalBashTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            LocalBashTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        workspaceRoot;
        backgroundAdapter;
        hostTrashRuntime;
        sandboxOperationsFactory;
        envPolicy;
        /** Names stripped by the sanitizer at the most recent spawn (never values). */
        lastEnvRemoved = [];
        /** One-shot hint gate: report stripped names once per tool instance. */
        envHintShown = false;
        constructor(workspaceRoot, backgroundAdapter, envPolicy, hostTrashRuntime, sandboxOperationsFactory) {
            this.workspaceRoot = workspaceRoot;
            this.backgroundAdapter = backgroundAdapter;
            this.hostTrashRuntime = hostTrashRuntime;
            this.sandboxOperationsFactory = sandboxOperationsFactory;
            this.envPolicy = envPolicy;
        }
        async execute(ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            let timing;
            let description;
            try {
                description = resolveBashDescription(input.description, input.command);
                validateBashCommand(input.command);
                timing = resolveLocalBashTiming(input.timeout, input.run_in_background
                    ? 'explicit_background'
                    : ctx.canConsumeBackgroundBashOutput === true &&
                        ctx.allowBashAutoPromotion !== false &&
                        this.backgroundAdapter?.runManagedForeground
                        ? 'managed_foreground'
                        : 'direct_foreground');
            }
            catch (error) {
                const text = error instanceof Error ? error.message : String(error);
                // Every Bash return path states its completeness for PTC.
                return withDesktopCompletenessReport(LocalBashToolDef.name, {
                    tool_name: LocalBashToolDef.name,
                    text,
                    content: [{ type: 'text', text }],
                    isError: true,
                    details: { status: 'invalid_input', error_code: 'BASH_INVALID_INPUT' },
                });
            }
            try {
                const result = await this.executeValidated(ctx, readPermissionExecutionPlan(input)
                    ? copyWithPermissionExecutionPlan({ ...input, description }, readPermissionExecutionPlan(input))
                    : { ...input, description }, timing, signal);
                return withDesktopCompletenessReport(LocalBashToolDef.name, {
                    ...result,
                    details: { ...result.details, description },
                });
            }
            catch (error) {
                if (error instanceof Error) {
                    const details = error.details;
                    Object.assign(error, { details: { ...details, description } });
                }
                throw error;
            }
        }
        async executeValidated(ctx, input, timing, signal) {
            if (input.run_in_background === true && ctx.canConsumeBackgroundBashOutput !== true) {
                return unavailableBackgroundBashOutputResult();
            }
            const permissionExecutionPlan = readPermissionExecutionPlan(input);
            const envPolicy = () => resolvePermissionBashEnvPolicy(this.envPolicy, permissionExecutionPlan);
            // Only a PTC child carries ptcDeadline; every other call keeps the
            // ordinary foreground timing. Computed after approval; the program clock
            // stood still while the card was open, so the wait is not taken from the
            // time left. A longer foreground timeout first extends the program
            // (ptcBashDeadline).
            const ptcTimeout = ctx.ptcDeadline
                ? resolvePtcForegroundTimeout(input, ptcBashDeadline(input, ctx.ptcDeadline), Date.now())
                : undefined;
            const hostTrashResult = await executeLocalHostTrashIfRequested({
                toolInput: input,
                workspaceRoot: this.workspaceRoot,
                runtime: this.hostTrashRuntime,
                envPolicy,
                timeoutSeconds: ptcTimeout?.timeoutSeconds ??
                    resolveForegroundTimeout({ timeout: timing.commandTimeoutSeconds }),
                ...(signal ? { signal } : {}),
            });
            if (hostTrashResult) {
                if (ptcTimeout)
                    ctx.ptcDeadline?.reportTimeout?.(ptcTimeout);
                const childOutput = isPtcChildCall(ctx)
                    ? await fullPtcBashOutput(hostTrashResult)
                    : undefined;
                return (childOutput ??
                    applyDesktopTextLimit(hostTrashResult, limitDesktopBashOutput(hostTrashResult.text)));
            }
            if (input.run_in_background === true) {
                if (!this.backgroundAdapter) {
                    const text = '<bash_error>Background bash execution is not enabled</bash_error>';
                    return {
                        tool_name: LocalBashToolDef.name,
                        text,
                        content: [{ type: 'text', text }],
                        details: { status: 'background_not_enabled' },
                        isError: true,
                    };
                }
                const started = await this.backgroundAdapter.startBackground(ctx, input, signal);
                if (started.status !== 'started' || !started.taskId) {
                    const errorMessage = started.errorMessage ?? 'Local background bash failed to start';
                    const text = `<bash_error>${errorMessage}</bash_error>`;
                    return {
                        tool_name: LocalBashToolDef.name,
                        text,
                        content: [{ type: 'text', text }],
                        details: { status: started.status },
                        isError: true,
                    };
                }
                return backgroundBashToolResult(started.taskId, 'started', this.consumeEnvSanitizationHint({
                    ...started.details,
                    description: input.description,
                    timing: { ...timing, ...started.details?.timing },
                }));
            }
            const { run_in_background: _runInBackground, ...rest } = input;
            // A PTC child runs against its program's deadline instead of the ordinary
            // foreground limit; the program reports that decision itself.
            const foregroundTiming = ptcTimeout
                ? { commandTimeoutSeconds: ptcTimeout.timeoutSeconds }
                : timing;
            const foregroundInput = permissionExecutionPlan
                ? copyWithPermissionExecutionPlan({ ...rest, timeout: foregroundTiming.commandTimeoutSeconds }, permissionExecutionPlan)
                : { ...rest, timeout: foregroundTiming.commandTimeoutSeconds };
            if (ptcTimeout)
                ctx.ptcDeadline?.reportTimeout?.(ptcTimeout);
            if (ctx.canConsumeBackgroundBashOutput === true &&
                ctx.allowBashAutoPromotion !== false &&
                this.backgroundAdapter?.runManagedForeground) {
                const managed = await this.backgroundAdapter.runManagedForeground(ctx, foregroundInput, DEFAULT_FOREGROUND_BASH_SOFT_YIELD_MS, signal);
                if (managed.status !== 'completed') {
                    if (managed.status === 'auto_promoted' && managed.taskId) {
                        return backgroundBashToolResult(managed.taskId, 'auto_promoted', this.consumeEnvSanitizationHint({
                            ...managed.details,
                            description: input.description,
                            timing: { ...foregroundTiming, ...managed.details?.timing },
                        }));
                    }
                    const text = `<bash_error>${managed.errorMessage ?? 'Local managed bash failed to start'}</bash_error>`;
                    return {
                        tool_name: LocalBashToolDef.name,
                        text,
                        content: [{ type: 'text', text }],
                        details: { status: managed.status },
                        isError: true,
                    };
                }
                const managedFullOutputPath = typeof managed.details?.fullOutputPath === 'string'
                    ? managed.details.fullOutputPath
                    : undefined;
                const managedDetails = this.consumeEnvSanitizationHint(managed.details);
                const result = withLocalBashTiming(withCompatibleBashToolResponseFromPiDetails({
                    tool_name: LocalBashToolDef.name,
                    text: managed.text,
                    content: [{ type: 'text', text: managed.text }],
                    details: {
                        ...managedDetails,
                        status: readBashExecutionOutcome(managedDetails)?.status ?? 'completed',
                        task_id: managed.taskId,
                    },
                    ...(managed.isError ? { isError: true } : {}),
                }), foregroundTiming);
                return applyDesktopTextLimit(result, limitDesktopBashOutput(result.text, managedFullOutputPath, result.details, managed.taskId));
            }
            let result;
            try {
                const tool = createBashTool(this.workspaceRoot, {
                    output: {
                        strategy: 'head_tail',
                        maxBytes: DESKTOP_BASH_PREVIEW_BYTES,
                        maxTotalBytes: DESKTOP_BASH_MAX_OUTPUT_BYTES,
                        maxPendingBytes: DESKTOP_BASH_MAX_PENDING_OUTPUT_BYTES,
                        maxLines: Number.MAX_SAFE_INTEGER,
                    },
                    ...(this.sandboxOperationsFactory
                        ? {
                            operations: this.sandboxOperationsFactory.create({
                                identity: directForegroundIdentity(ctx),
                                workspaceRoot: this.workspaceRoot,
                                ...(ctx.workspaceRoots ? { workspaceRoots: ctx.workspaceRoots } : {}),
                                ...(permissionExecutionPlan ? { permissionExecutionPlan } : {}),
                            }),
                        }
                        : {}),
                    // Bind the approved policy to this invocation, including its spawn hook.
                    spawnHook: (spawnContext) => {
                        const { env, removed } = sanitizeBashSubprocessEnv(spawnContext.env, envPolicy);
                        this.lastEnvRemoved = removed;
                        return { ...spawnContext, env };
                    },
                });
                const res = await tool.execute('', foregroundInput, signal);
                const completed = localBashResultFromPi(res);
                result = withCompatibleBashToolResponseFromPiDetails({
                    tool_name: LocalBashToolDef.name,
                    ...completed,
                    content: [{ type: 'text', text: completed.text }],
                });
            }
            catch (error) {
                if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
                    throw error;
                }
                const failed = localBashResultFromError(error, signal);
                result = withCompatibleBashToolResponseFromPiDetails({
                    tool_name: LocalBashToolDef.name,
                    ...failed,
                    content: [{ type: 'text', text: failed.text }],
                });
            }
            result = withLocalBashTiming(result, foregroundTiming);
            // A PTC child never reaches the managed path above: Agent Core gives it
            // allowBashAutoPromotion: false, so only this path and host trash read
            // the whole output back for it.
            const childOutput = isPtcChildCall(ctx) ? await fullPtcBashOutput(result) : undefined;
            if (childOutput) {
                result = childOutput;
            }
            else {
                const fullOutputPath = typeof result.details?.fullOutputPath === 'string'
                    ? result.details.fullOutputPath
                    : undefined;
                const limited = limitDesktopBashOutput(result.text, fullOutputPath, result.details);
                result = applyDesktopTextLimit(result, limited);
            }
            result.details = this.consumeEnvSanitizationHint({
                ...(result.details ?? {}),
                ...(this.lastEnvRemoved.length > 0 ? { envSanitized: this.lastEnvRemoved } : {}),
            });
            return result;
        }
        consumeEnvSanitizationHint(details) {
            const { envSanitized, ...rest } = details ?? {};
            const removed = Array.isArray(envSanitized)
                ? envSanitized.filter((name) => typeof name === 'string')
                : [];
            if (this.envHintShown || removed.length === 0)
                return rest;
            // Report names only (never values) so a user whose command suddenly
            // misses a credential can find the sanitizer instead of debugging blind.
            this.envHintShown = true;
            return { ...rest, envSanitized: removed };
        }
    };
    return LocalBashTool = _classThis;
})();
export { LocalBashTool };
function directForegroundIdentity(ctx) {
    const invocationId = ctx.toolCallId ?? `runtime_${randomUUID()}`;
    return {
        operationClass: 'direct_foreground',
        invocationId,
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
        ...(ctx.forceReadOnlyFilesystem ? { forceReadOnlyFilesystem: true } : {}),
    };
}
/**
 * The whole output of a PTC child Bash call, or undefined to keep the
 * Desktop preview. Pi keeps only a head+tail preview in memory and writes the
 * complete output to `fullOutputPath` (Pi core/tools/output-accumulator.ts);
 * a cut output is read back from that file, and the status lines appended
 * after the preview (exit code, timeout receipt) are kept. An incomplete or
 * failed save, or a file over PTC_CHILD_FULL_OUTPUT_MAX_BYTES, falls back to
 * the preview.
 */
async function fullPtcBashOutput(result) {
    const details = result.details ?? {};
    const cut = details.truncation;
    if (cut?.truncated !== true) {
        // Pi did not cut it: the text is already the whole output.
        const bytes = Buffer.byteLength(result.text, 'utf8');
        if (bytes > PTC_CHILD_FULL_OUTPUT_MAX_BYTES)
            return undefined;
        return bytes > DESKTOP_BASH_MAX_BYTES
            ? withProgrammaticResult(result, { uncappedOutput: true })
            : result;
    }
    const path = details.fullOutputPath;
    const persistence = details.output?.persistence;
    const preview = cut.content;
    if (typeof path !== 'string' ||
        persistence !== 'complete' ||
        typeof preview !== 'string' ||
        !result.text.startsWith(preview)) {
        return undefined;
    }
    let full;
    try {
        if ((await stat(path)).size > PTC_CHILD_FULL_OUTPUT_MAX_BYTES)
            return undefined;
        full = await readFile(path, 'utf8');
    }
    catch {
        return undefined;
    }
    const text = `${full}${result.text.slice(preview.length)}`;
    const rest = Object.fromEntries(Object.entries(details).filter(([key]) => key !== 'truncation'));
    return withProgrammaticResult({ ...result, text, content: [{ type: 'text', text }], details: rest }, { uncappedOutput: true });
}
function limitDesktopBashOutput(text, fullOutputPath, details, taskId) {
    const output = details?.output;
    const readableOutputPath = fullOutputPath ?? output?.partialOutputPath;
    const outputLabel = fullOutputPath ? 'Full output' : 'Saved partial output';
    let previewText = text;
    if (!taskId) {
        if (details?.truncation?.truncated) {
            previewText += `\n\n[desktop bash output truncated: original_bytes=${output?.rawBytes}; ${output?.partialOutputPath ? 'saved output' : 'original'} head+tail shown.${readableOutputPath ? ` ${outputLabel}: ${readableOutputPath}` : ''}]`;
        }
        if (output?.persistenceError) {
            previewText += `\n\n[Output persistence failed; complete output is unavailable: ${output.persistenceError}]`;
        }
    }
    const limited = limitDesktopHeadTailLines(previewText, {
        maxBytes: DESKTOP_BASH_MAX_BYTES,
        notice: ({ originalBytes }) => readableOutputPath
            ? `[desktop bash output truncated: original_bytes=${originalBytes}; head+tail shown; boundary lines may be UTF-8 byte-truncated; ${outputLabel}: ${readableOutputPath}]`
            : `[desktop bash output truncated: original_bytes=${originalBytes}; head+tail shown; boundary lines may be UTF-8 byte-truncated.]`,
    });
    if (limited.truncation ||
        details?.truncation?.truncated) {
        limited.truncation = {
            truncated: true,
            has_more: true,
            strategy: 'head_tail_lines',
            original_bytes: output?.rawBytes ?? limited.truncation?.original_bytes ?? Buffer.byteLength(text, 'utf8'),
            returned_bytes: Buffer.byteLength(limited.text, 'utf8'),
            max_bytes: DESKTOP_BASH_MAX_BYTES,
        };
    }
    return withDesktopOutputContinuation(limited, {
        continuation_hint: taskId
            ? {
                tool: 'task_output',
                preserve_args: ['task_id'],
                instruction: `Read task ${taskId} with task_output; continue with its next_offset (UTF-8 log file bytes). Check output persistence status before treating the log as complete.`,
            }
            : readableOutputPath
                ? {
                    tool: 'read',
                    preserve_args: ['path'],
                    instruction: `Read the ${fullOutputPath ? 'full' : 'saved partial'} output at ${readableOutputPath}; continue long reads with the returned next_offset.`,
                }
                : {
                    tool: 'bash',
                    preserve_args: [],
                    instruction: 'Do not blindly rerun a potentially side-effecting command; narrow it or redirect output to a file, then use read.',
                },
    });
}
export function resolveForegroundTimeout(input) {
    return resolveLocalBashTiming(input.timeout, 'direct_foreground').commandTimeoutSeconds;
}
/**
 * Program deadline a PTC Bash child runs against. A foreground call whose own
 * `timeout` (seconds) is longer than the program has left asks Agent Core to
 * extend the program, which owns that rule, its margin and the one-hour cap:
 * a model that gave tools.bash a long timeout but no run_code timeout_ms
 * expects the command to get that long, not to be cut at the program's 120s.
 * Background Bash is not bounded by the program, so it never extends it.
 */
function ptcBashDeadline(input, deadline) {
    const requested = input.timeout;
    if (input.run_in_background === true ||
        requested === undefined ||
        !Number.isFinite(requested) ||
        requested <= 0) {
        return deadline.atMs;
    }
    return deadline.extendForTimeout?.(requested) ?? deadline.atMs;
}
/**
 * Foreground timeout of a Bash call made inside a run_code program. The
 * program already has a wall clock (`timeout_ms`, 120s by default); a fixed
 * 120s/300s Bash bound would kill a long command even after the model raised
 * `timeout_ms`, so here the program's remaining time is the default and the
 * cap instead. With the default `timeout_ms` the remaining time never exceeds
 * 120s, so nothing changes for programs that do not raise it. A longer
 * requested timeout has already extended the deadline (ptcBashDeadline), so
 * the cap only bites at the one-hour maximum or for an expired program.
 *
 * Rounded up to whole seconds and at least 1: Pi treats 0 as "no timeout",
 * and rounding down would let Bash time out just before the program's own
 * wall clock, changing the result of a default program that runs too long.
 */
export function resolvePtcForegroundTimeout(input, deadlineAtMs, nowMs) {
    const remainingMs = Math.max(0, deadlineAtMs - nowMs);
    const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
    const requested = input.timeout;
    if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
        return { source: 'program_remaining', timeoutSeconds: remainingSeconds, remainingMs };
    }
    return requested > remainingSeconds
        ? { source: 'requested_capped', timeoutSeconds: remainingSeconds, remainingMs }
        : { source: 'requested', timeoutSeconds: requested, remainingMs };
}
function backgroundBashToolResult(taskId, status, details = {}) {
    const lead = status === 'auto_promoted'
        ? 'The command is still running and was yielded to a managed background task without restarting it.'
        : 'Background Bash task accepted; command startup may still be in progress.';
    const timing = details.timing;
    const timingText = timing?.commandTimeoutSeconds !== undefined
        ? ` Command limit: ${timing.commandTimeoutSeconds}s total; yielding does not reset it.`
        : '';
    const purpose = typeof details.description === 'string'
        ? `Purpose: ${limitDesktopHeadTailLines(details.description, {
            maxBytes: 1024,
            notice: () => '[purpose truncated]',
        }).text}\n`
        : '';
    const text = `<bash_background task_id="${taskId}">\n${purpose}${lead}${timingText} The owning conversation will automatically resume when it finishes; use task_output to inspect incremental output, and task_stop to cancel if that tool is available.\n</bash_background>`;
    return {
        tool_name: LocalBashToolDef.name,
        text,
        content: [{ type: 'text', text }],
        details: { ...details, status, task_id: taskId },
    };
}
function unavailableBackgroundBashOutputResult() {
    const text = '<bash_error>Background Bash requires native task_output. This Turn is missing task_output, so asynchronous Bash cannot be executed. Run the command in the foreground instead.</bash_error>';
    return {
        tool_name: LocalBashToolDef.name,
        text,
        content: [{ type: 'text', text }],
        details: {
            status: 'background_output_unavailable',
            error_code: 'BASH_BACKGROUND_OUTPUT_UNAVAILABLE',
        },
        isError: true,
    };
}
function toToolResult(toolName, res) {
    const content = res.content;
    return {
        tool_name: toolName,
        text: content
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('\n'),
        content,
        details: (res.details ?? {}),
        ...(res.terminate !== undefined ? { terminate: res.terminate } : {}),
    };
}
/**
 * Best-effort absolute path used to pre-detect read dispatch extensions and
 * to look up write captures. Mirrors the common pieces of pi's
 * `normalizePath` (tilde expansion + absolute pass-through) without pulling
 * pi's private path-utils. Any failure to resolve here just means the read
 * wrappers can apply their own path probing without changing write / edit
 * capture semantics.
 */
/**
 * Lexical normalization for capture hints and read dispatch, aligned with
 * Pi's `resolveToCwd` input. It is not the read-before-write key: the
 * read ledger (file-read-ledger.ts) deliberately keys by realpath, so symlink
 * aliases of one file share a read record; the version check still catches
 * any change made through either alias.
 */
export function normalizeLocalExistingPath(absolutePath, resolveAbsolutePath = resolvePath) {
    return resolveAbsolutePath(absolutePath);
}
function resolveLocalCandidatePath(input, workspaceRoot) {
    let path = input;
    if (path === '~') {
        return normalizeLocalExistingPath(homedir());
    }
    if (path.startsWith('~/') || (process.platform === 'win32' && path.startsWith('~\\'))) {
        path = resolvePath(homedir(), path.slice(2));
    }
    return normalizeLocalExistingPath(isAbsolute(path) ? path : resolvePath(workspaceRoot, path));
}
/**
 * Log label for a refused write. Logs must not carry a private path in full
 * (.harness/docs/code-standards.md), so a file inside the workspace is logged
 * workspace-relative and anything else as `<path>/<basename>`, the shape the
 * Mini App startup-failure log already uses.
 */
function writeGuardLogPath(inputPath, workspaceRoot) {
    const absolutePath = resolveLocalCandidatePath(inputPath, workspaceRoot);
    const fromWorkspace = relative(workspaceRoot, absolutePath);
    const outside = fromWorkspace === '' ||
        fromWorkspace === '..' ||
        fromWorkspace.startsWith(`..${sep}`) ||
        isAbsolute(fromWorkspace);
    return outside ? `<path>/${basename(absolutePath)}` : fromWorkspace.split(sep).join('/');
}
async function resolveLocalReadPath(input, workspaceRoot) {
    const literalResolved = resolveLocalCandidatePath(input, workspaceRoot);
    if (await pathExists(literalResolved))
        return literalResolved;
    const resolved = resolveLocalReadCandidatePath(input, workspaceRoot);
    if (await pathExists(resolved))
        return resolved;
    const amPmVariant = resolved.replace(/ (AM|PM)\./gi, '\u202f$1.');
    if (amPmVariant !== resolved && (await pathExists(amPmVariant)))
        return amPmVariant;
    const nfdVariant = resolved.normalize('NFD');
    if (nfdVariant !== resolved && (await pathExists(nfdVariant)))
        return nfdVariant;
    const curlyVariant = resolved.replace(/'/g, '\u2019');
    if (curlyVariant !== resolved && (await pathExists(curlyVariant)))
        return curlyVariant;
    const nfdCurlyVariant = nfdVariant.replace(/'/g, '\u2019');
    if (nfdCurlyVariant !== resolved && (await pathExists(nfdCurlyVariant))) {
        return nfdCurlyVariant;
    }
    return resolved;
}
function resolveLocalReadCandidatePath(input, workspaceRoot) {
    let path = normalizeLocalReadInput(input);
    if (path === '~') {
        return normalizeLocalExistingPath(homedir());
    }
    if (path.startsWith('~/') || (process.platform === 'win32' && path.startsWith('~\\'))) {
        path = resolvePath(homedir(), path.slice(2));
    }
    return normalizeLocalExistingPath(isAbsolute(path) ? path : resolvePath(workspaceRoot, path));
}
function normalizeLocalReadInput(input) {
    let normalized = input.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ');
    if (normalized.startsWith('@'))
        normalized = normalized.slice(1);
    if (/^file:\/\//.test(normalized))
        return fileURLToPath(normalized);
    return normalized;
}
async function pathExists(filePath) {
    try {
        await access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
function isFsNotFoundError(err) {
    return typeof err === 'object' && err !== null && err.code === 'ENOENT';
}
export { DEFAULT_FOREGROUND_BASH_TIMEOUT_SECONDS, MAX_FOREGROUND_BASH_TIMEOUT_SECONDS, DEFAULT_FOREGROUND_BASH_SOFT_YIELD_MS, } from './local-bash-timing.js';
//# sourceMappingURL=local-pi-tools.js.map