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
import { bindTool, } from '@mavis/agent-core/tools';
import { sanitizeBashSubprocessEnv, } from '@mavis/agent-core/bash-subprocess-env';
import { createBashTool, createEditTool, createReadTool, createWriteTool, } from '@earendil-works/pi-coding-agent/tools';
import { getShellConfig } from '@earendil-works/pi-coding-agent/shell';
import { access } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { homedir, release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { resolveBashDescription } from './local-bash-input.js';
import { DEFAULT_FOREGROUND_BASH_SOFT_YIELD_MS, resolveLocalBashTiming, validateBashCommand, withLocalBashTiming, } from './local-bash-timing.js';
import { localBashResultFromError, localBashResultFromPi, readBashExecutionOutcome, } from './local-bash-result.js';
import { LocalBashToolDef, LocalEditToolDef, LocalReadToolDef, LocalWriteToolDef, } from './builtin-defs.js';
import { executeLocalHostTrashIfRequested, } from './host-trash-executor.js';
import { inferReadVideoMimeType, readVideoAsToolResult } from '../shared/read-video.js';
import { buildReplaceAllEdit, ReplaceAllError } from '../shared/replace-all-edit.js';
import { checkBlockedDeviceRead, checkNonRegularFileRead, detectBinaryRead, } from '../shared/read-guards.js';
import { isPdfReadPath, readPdfAsToolResult } from '../shared/read-pdf.js';
import { isNotebookReadPath, readNotebookAsToolResult } from '../shared/read-notebook.js';
import { piReadResultToToolResult, readErrorResult } from '../shared/read-result.js';
import { executeEditWithLineNumberRetry, normalizeEditsForLineNumberRetry, } from '../shared/edit-line-number-retry.js';
import { createCapturingEditOperations } from '../shared/edit-capture.js';
import { withCompatibleBashToolResponseFromPiDetails, withCompatibleEditToolResponse, } from '../plugin-hooks/vendor-tool-response.js';
import { buildWriteToolResult, createCapturingWriteOperations } from '../shared/write-capture.js';
import { applyDesktopTextLimit, DESKTOP_BASH_MAX_BYTES, DESKTOP_BASH_PREVIEW_BYTES, DESKTOP_READ_TEXT_MAX_BYTES, limitDesktopHeadTailLines, limitDesktopPrefixLines, withDesktopOutputContinuation, } from './output-limit.js';
export function getLocalBashEnvironment() {
    let shell = 'unavailable';
    try {
        // Match local Bash execution, which does not select its shell from $SHELL.
        const selected = getShellConfig();
        shell = `${selected.type} (${selected.shell})`;
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
        tool;
        constructor(workspaceRoot) {
            this.workspaceRoot = workspaceRoot;
            this.tool = createReadTool(workspaceRoot);
        }
        async execute(ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            const readAbs = await resolveLocalReadPath(input.path, this.workspaceRoot);
            // Guard order (design doc §3): the device check comes first because
            // every later step that opens the file (binary sampling, PDF/notebook
            // parsing, pi itself) would hang forever on /dev/zero-style paths.
            const deviceError = checkBlockedDeviceRead(readAbs);
            if (deviceError)
                return readErrorResult(LocalReadToolDef.name, deviceError);
            // Closes the FIFO/socket/block-device blind spot the path-only device
            // guard misses (one stat, follows symlinks) — a named pipe would block
            // the whole turn just like /dev/zero.
            const irregularError = await checkNonRegularFileRead(readAbs);
            if (irregularError)
                return readErrorResult(LocalReadToolDef.name, irregularError);
            // pi natively inlines images (jpg/png/gif/webp). Video is not part of
            // pi's built-in mime detection, so we mirror cloud-runtime here: when
            // the path looks like an inline-capable video, run the shared helper
            // first and fall through to pi only when (a) the extension is not a
            // recognised video, or (b) the candidate path does not exist (let pi's
            // NFD / curly-quote / AM-PM fallbacks have a chance to find the file).
            const videoMime = inferReadVideoMimeType(readAbs);
            if (videoMime) {
                try {
                    return await readVideoAsToolResult({
                        toolName: LocalReadToolDef.name,
                        absolutePath: readAbs,
                        mimeType: videoMime,
                        capabilities: ctx.parentAgentConfig?.model?.capabilities,
                        signal,
                    });
                }
                catch (err) {
                    if (!isFsNotFoundError(err))
                        throw err;
                    // ENOENT — let pi retry with its macOS-aware path variants.
                }
            }
            // PDF / notebook dispatch: these never reach pi (which would read them
            // as UTF-8 garbage / raw JSON).
            if (isPdfReadPath(readAbs)) {
                return readPdfAsToolResult({
                    toolName: LocalReadToolDef.name,
                    absolutePath: readAbs,
                    pages: input.pages,
                    signal,
                });
            }
            if (isNotebookReadPath(readAbs)) {
                return readNotebookAsToolResult({
                    toolName: LocalReadToolDef.name,
                    absolutePath: readAbs,
                    signal,
                });
            }
            // Binary guard: pi would decode anything else as UTF-8 — turn silent
            // garbage into an explicit, recoverable tool error.
            const binary = await detectBinaryRead(readAbs);
            if (binary.binary)
                return readErrorResult(LocalReadToolDef.name, binary.message);
            // Strip `pages` before delegating: pi's read schema does not know the
            // parameter, and models occasionally send it for non-PDF files.
            const { pages: _pages, ...piInput } = input;
            const res = await this.tool.execute('', piInput, signal);
            const result = piReadResultToToolResult(LocalReadToolDef.name, res, {
                offset: input.offset,
            });
            return limitDesktopReadTextResult(result, input.offset);
        }
    };
    return LocalReadTool = _classThis;
})();
export { LocalReadTool };
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
        constructor(workspaceRoot) {
            this.workspaceRoot = workspaceRoot;
        }
        async execute(_ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            // Per-execute capture context. This tool instance is a process-level
            // singleton (buildLocalToolRegistry), so an instance-level pending map
            // would be shared across concurrent writes; binding capture to a single
            // execute keeps each write's byte count / diff its own. The injected
            // writeFile still runs inside pi's withFileMutationQueue slot: it captures
            // the old file (BOM/encoding/content) and writes with the preserved
            // encoding — see write-capture.ts / design doc.
            const { operations, takeCapture } = createCapturingWriteOperations();
            const tool = createWriteTool(this.workspaceRoot, { operations });
            const res = await tool.execute('', input, signal);
            const capture = takeCapture(resolveLocalCandidatePath(input.path, this.workspaceRoot));
            return buildWriteToolResult(LocalWriteToolDef.name, input.path, input.content, capture, toToolResult(LocalWriteToolDef.name, res).text);
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
        async execute(_ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            // Translate the compatible style public schema (file_path + old_string +
            // new_string + optional replace_all) into pi's internal
            // { path, edits: [{ oldText, newText }] } shape so we still get
            // pi's BOM strip / line-ending restore / unified-diff /
            // withFileMutationQueue locking for free. The execution is then routed
            // through the line-number-retry wrapper so a model that pasted read's
            // `N→` prefixes into old_string still recovers (CR !4027 P1).
            const piInput = await buildPiEditInput(input, this.workspaceRoot);
            const capture = createCapturingEditOperations();
            const tool = createEditTool(this.workspaceRoot, { operations: capture.operations });
            const res = await executeEditWithLineNumberRetry(tool, piInput, signal);
            const result = toToolResult(LocalEditToolDef.name, res);
            const editCapture = capture.takeCapture(resolveLocalCandidatePath(input.file_path, this.workspaceRoot));
            if (!editCapture)
                return result;
            const normalized = result.details?.line_number_prefixes_stripped === true
                ? normalizeEditsForLineNumberRetry([
                    { oldText: input.old_string, newText: input.new_string },
                ])?.[0]
                : undefined;
            return withCompatibleEditToolResponse(result, {
                filePath: editCapture.path,
                oldString: normalized?.oldText ?? input.old_string,
                newString: normalized?.newText ?? input.new_string,
                originalFile: editCapture.originalFile,
                replaceAll: input.replace_all === true,
                userModified: false,
            });
        }
    };
    return LocalEditTool = _classThis;
})();
export { LocalEditTool };
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
            return { path: replacement.path, edits: replacement.edits };
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
        tool;
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
            // Env sanitizer (design: bash-tool-optimization.md §2.2). Layer A boundary
            // strip is always on; Layer B secret scrub follows the resolved policy.
            // The background executor and the pi-turn-runner fallback apply the same
            // hook — keep the three spawn sites in sync.
            this.tool = createBashTool(workspaceRoot, {
                output: {
                    strategy: 'head_tail',
                    maxBytes: DESKTOP_BASH_PREVIEW_BYTES,
                    maxLines: Number.MAX_SAFE_INTEGER,
                },
                spawnHook: (ctx) => {
                    const { env, removed } = sanitizeBashSubprocessEnv(ctx.env, this.envPolicy);
                    this.lastEnvRemoved = removed;
                    return { ...ctx, env };
                },
            });
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
                return {
                    tool_name: LocalBashToolDef.name,
                    text,
                    content: [{ type: 'text', text }],
                    isError: true,
                    details: { status: 'invalid_input', error_code: 'BASH_INVALID_INPUT' },
                };
            }
            try {
                const result = await this.executeValidated(ctx, { ...input, description }, timing, signal);
                return { ...result, details: { ...result.details, description } };
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
            const hostTrashResult = await executeLocalHostTrashIfRequested({
                toolInput: input,
                workspaceRoot: this.workspaceRoot,
                runtime: this.hostTrashRuntime,
                envPolicy: this.envPolicy,
                timeoutSeconds: resolveForegroundTimeout({ timeout: timing.commandTimeoutSeconds }),
                ...(signal ? { signal } : {}),
            });
            if (hostTrashResult) {
                return applyDesktopTextLimit(hostTrashResult, limitDesktopBashOutput(hostTrashResult.text));
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
            const foregroundInput = { ...rest, timeout: timing.commandTimeoutSeconds };
            if (ctx.canConsumeBackgroundBashOutput === true &&
                ctx.allowBashAutoPromotion !== false &&
                this.backgroundAdapter?.runManagedForeground) {
                const managed = await this.backgroundAdapter.runManagedForeground(ctx, foregroundInput, DEFAULT_FOREGROUND_BASH_SOFT_YIELD_MS, signal);
                if (managed.status !== 'completed') {
                    if (managed.status === 'auto_promoted' && managed.taskId) {
                        return backgroundBashToolResult(managed.taskId, 'auto_promoted', this.consumeEnvSanitizationHint({
                            ...managed.details,
                            description: input.description,
                            timing: { ...timing, ...managed.details?.timing },
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
                }), timing);
                return applyDesktopTextLimit(result, limitDesktopBashOutput(result.text, managedFullOutputPath, result.details, managed.taskId));
            }
            let result;
            try {
                const tool = this.sandboxOperationsFactory
                    ? createBashTool(this.workspaceRoot, {
                        output: {
                            strategy: 'head_tail',
                            maxBytes: DESKTOP_BASH_PREVIEW_BYTES,
                            maxLines: Number.MAX_SAFE_INTEGER,
                        },
                        operations: this.sandboxOperationsFactory.create({
                            identity: directForegroundIdentity(ctx),
                            workspaceRoot: this.workspaceRoot,
                        }),
                        spawnHook: (spawnContext) => {
                            const { env, removed } = sanitizeBashSubprocessEnv(spawnContext.env, this.envPolicy);
                            this.lastEnvRemoved = removed;
                            return { ...spawnContext, env };
                        },
                    })
                    : this.tool;
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
            result = withLocalBashTiming(result, timing);
            const fullOutputPath = typeof result.details?.fullOutputPath === 'string'
                ? result.details.fullOutputPath
                : undefined;
            const limited = limitDesktopBashOutput(result.text, fullOutputPath, result.details);
            result = applyDesktopTextLimit(result, limited);
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
function limitDesktopBashOutput(text, fullOutputPath, details, taskId) {
    const output = details?.output;
    let previewText = text;
    if (!taskId) {
        if (details?.truncation?.truncated) {
            previewText += `\n\n[desktop bash output truncated: original_bytes=${output?.rawBytes}; original head+tail shown.${fullOutputPath ? ` Full output: ${fullOutputPath}` : ''}]`;
        }
        if (output?.persistenceError) {
            previewText += `\n\n[Output persistence failed; complete output is unavailable: ${output.persistenceError}]`;
        }
    }
    const limited = limitDesktopHeadTailLines(previewText, {
        maxBytes: DESKTOP_BASH_MAX_BYTES,
        notice: ({ originalBytes }) => fullOutputPath
            ? `[desktop bash output truncated: original_bytes=${originalBytes}; head+tail shown; boundary lines may be UTF-8 byte-truncated; Full output: ${fullOutputPath}]`
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
            : fullOutputPath
                ? {
                    tool: 'read',
                    preserve_args: ['path'],
                    instruction: `Read the full output at ${fullOutputPath}; continue long reads with the returned next_offset.`,
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
 * Keep the ledger key byte-for-byte aligned with Pi's `resolveToCwd` input.
 * This is deliberately lexical: `realpath` would collapse symlink aliases and
 * broaden a read authorization beyond the path spelling the agent inspected.
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