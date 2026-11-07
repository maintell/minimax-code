/**
 * LocalGrepTool —— `grep` 工具的 desktop 实现（对应 cloud/cloud-grep.ts）。
 *
 * 工具类只做编排：校验输入 → buildGrepArgs 组 argv → runRg 跑 ripgrep →
 * shared/grep-parse.ts 按 output_mode 做后处理（desktop 与 cloud 共用同一
 * 实现，P0-3/P1-1）。argv 组装是本文件导出的无 IO 纯函数。
 *
 * Hardening（对齐 cloud）：
 * - shared 敏感 deny-list 以 `--glob=!…` 追加（P0-2）
 * - LLM pattern 放 `--` 之后，`-` 开头 pattern 不可能被解析成 rg flag（P0-1）
 * - 用户 glob 过滤用 `=` 绑定，同理（P0-1）
 *
 * output_mode（P1-1）：默认 `files_with_matches` 只回文件列表（省 token，
 * 后续用 read/edit 跟进）；`content` / `count` opt-in。`offset` 分页（P1-2）。
 */
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
import { stat } from '../shared/physical-fs.js';
import { resolve } from 'node:path';
import { bindTool, withProgrammaticResult, } from '@mavis/agent-core/tools';
import { DEFAULT_GREP_OUTPUT_MODE, grepModeFlags, MAX_TOTAL_BYTES, parseCountOutput, parseFilesOutput, parseGrepOutput, splitGlobFilters, } from '../shared/grep-parse.js';
import { withCompatibleGrepToolResponse } from '../plugin-hooks/vendor-tool-response.js';
import { defaultScanExcludeArgs } from '../shared/rg-scan-policy.js';
import { LocalGrepToolDef } from './builtin-defs.js';
import { resolveGrepTarget, runRg, textResult } from './local-rg-runner.js';
import { isSensitiveSearchRoot, sensitiveExcludeArgs } from './local-sensitive.js';
import { withDesktopCompletenessReport } from './ptc-result-projection.js';
import { applyDesktopTextLimit, createDesktopOutputContinuation, DESKTOP_GREP_CONTENT_MAX_BYTES, isPtcChildCall, limitDesktopPrefixLines, withDesktopOutputContinuation, } from './output-limit.js';
const DEFAULT_GREP_LIMIT = 100;
export const MAX_FILESIZE_FLAG = '1M';
const INVALID_REGEX_ERROR_CODE = 'invalid_regex';
const MAX_GREP_ERROR_STDERR_BYTES = 4 * 1024;
export function buildGrepArgs(input, effectiveLimit, searchPath = '.') {
    const mode = input.output_mode ?? DEFAULT_GREP_OUTPUT_MODE;
    const offset = input.offset && input.offset > 0 ? Math.floor(input.offset) : 0;
    const ctxLines = mode === 'content' && input.context && input.context > 0 ? Math.floor(input.context) : 0;
    const args = [
        '--no-config',
        '--no-messages',
        '--hidden',
        `--max-filesize=${MAX_FILESIZE_FLAG}`,
        ...grepModeFlags(mode),
    ];
    if (mode === 'content') {
        // ripgrep applies --max-count per file; the surplus row lets
        // parseGrepOutput detect "more available" beyond the requested page.
        args.push('--null', `--max-count=${offset + effectiveLimit + 1}`);
    }
    if (input.ignoreCase)
        args.push('--ignore-case');
    if (input.literal)
        args.push('--fixed-strings');
    // Gitignore: grep always respects it (CC parity, no toggle). Callers can
    // narrow `path` to a specific artifact directory when it is genuinely needed.
    if (ctxLines > 0)
        args.push(`--context=${ctxLines}`);
    // Models frequently write "*.ts, *.tsx" — split on commas/whitespace like
    // reference CLI does, but keep brace expansions ({ts,tsx}) intact.
    if (input.glob) {
        for (const g of splitGlobFilters(input.glob))
            args.push(`--glob=${g}`);
    }
    args.push(...defaultScanExcludeArgs());
    // MUST come after any user glob: rg glob rules are last-match-wins, so the
    // deny-list only reliably excludes secrets when it is appended last.
    args.push(...sensitiveExcludeArgs());
    args.push('--', input.pattern, searchPath);
    return args;
}
export async function sortFilesByMtime(files, root, statFn = stat, mode = process.env.NODE_ENV === 'test' ? 'name' : 'mtime') {
    if (mode === 'name')
        return [...files].sort((a, b) => a.localeCompare(b));
    const stats = await Promise.allSettled(files.map((f) => statFn(resolve(root, f))));
    return files
        .map((file, i) => {
        const r = stats[i];
        return [file, r.status === 'fulfilled' ? (r.value.mtimeMs ?? 0) : 0];
    })
        .sort((a, b) => {
        const timeComparison = b[1] - a[1];
        if (timeComparison === 0)
            return a[0].localeCompare(b[0]);
        return timeComparison;
    })
        .map(([file]) => file);
}
// ─── 工具编排 ──────────────────────────────────────────────────────────
let LocalGrepTool = (() => {
    let _classDecorators = [bindTool(LocalGrepToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var LocalGrepTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            LocalGrepTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        workspaceRoot;
        rgOptions;
        constructor(workspaceRoot, 
        /** Runner overrides (byte cap / timeouts) — used by tests; production uses defaults. */
        rgOptions = {}) {
            this.workspaceRoot = workspaceRoot;
            this.rgOptions = rgOptions;
        }
        async execute(ctx, input, signal) {
            if (!input.pattern)
                throw new Error('grep pattern is required');
            const effectiveLimit = Math.max(1, Math.floor(input.limit ?? DEFAULT_GREP_LIMIT));
            const mode = input.output_mode ?? DEFAULT_GREP_OUTPUT_MODE;
            const offset = input.offset && input.offset > 0 ? Math.floor(input.offset) : 0;
            // Resolve the target to an rg cwd + search path: a directory searches `.`,
            // a single file runs from its parent with just the basename. Throws a clear
            // "grep path does not exist" before spawn, so a missing path never surfaces
            // as a misleading "ripgrep binary not found" (CC stats in validateInput too).
            const target = resolveGrepTarget(this.workspaceRoot, input.path);
            if (await isSensitiveSearchRoot(resolve(target.cwd, target.searchPath))) {
                return reportGrep(withCompatibleGrepToolResponse(textResult(LocalGrepToolDef.name, 'No matches found'), {
                    mode,
                    filenames: [],
                    appliedLimit: effectiveLimit,
                    appliedOffset: offset,
                }), emptyGrepData(mode));
            }
            const args = buildGrepArgs(input, effectiveLimit, target.searchPath);
            const result = await runRg(args, target.cwd, {
                ...this.rgOptions,
                ...(signal ? { signal } : {}),
            });
            if (result.timedOut)
                throw new Error('grep timed out');
            if (result.exitCode === 1) {
                return reportGrep(withCompatibleGrepToolResponse(textResult(LocalGrepToolDef.name, 'No matches found'), {
                    mode,
                    filenames: [],
                    appliedLimit: effectiveLimit,
                    appliedOffset: offset,
                }), emptyGrepData(mode));
            }
            // A byte-cap kill ends the child via signal (exitCode null) — that is a
            // truncation, not a failure: fall through and parse the partial stdout.
            if (result.exitCode !== 0 && !result.stdoutTruncated) {
                if (isRipgrepRegexParseError(result.stderr)) {
                    return invalidRegexResult(result.stderr, result.exitCode);
                }
                const reason = result.stderr.trim() || `ripgrep exited with code ${result.exitCode}`;
                throw new Error(`grep failed: ${reason}`);
            }
            const parseOpts = { limit: effectiveLimit, offset };
            let parsed;
            if (mode === 'files_with_matches') {
                // Sort newest-first BEFORE slicing so a truncated page keeps recently
                // changed (likely relevant) files (P1-4, mirrors reference CLI).
                const files = result.stdout
                    .split('\n')
                    .map((line) => line.replace(/\r$/, '').trim())
                    .filter((line) => line.length > 0);
                const sorted = await sortFilesByMtime(files, target.cwd);
                parsed = parseFilesOutput(sorted.join('\n'), parseOpts);
            }
            else if (mode === 'count') {
                parsed = parseCountOutput(result.stdout, parseOpts);
            }
            else {
                parsed = parseGrepOutput(result.stdout, {
                    ...parseOpts,
                    partitionContext: true,
                    // A run_code child keeps whole lines and the whole page (see isPtcChildCall).
                    ...(isPtcChildCall(ctx) ? { uncapped: true } : {}),
                });
            }
            const { text, details } = parsed;
            if (result.stdoutTruncated) {
                details.stdoutTruncated = true;
            }
            if (text.trim().length === 0) {
                if (result.stdoutTruncated) {
                    return reportGrep(outputCutBeforePageResult(mode, offset, effectiveLimit, details), emptyGrepData(mode));
                }
                return reportGrep(withCompatibleGrepToolResponse(textResult(LocalGrepToolDef.name, 'No matches found'), {
                    mode,
                    filenames: [],
                    appliedLimit: effectiveLimit,
                    appliedOffset: offset,
                }), emptyGrepData(mode));
            }
            let modelText = text;
            if (mode === 'files_with_matches' && details.truncated === true) {
                const nextOffset = offset + effectiveLimit;
                const sharedFooter = `\n\n[More available — use offset=${nextOffset}]`;
                const conditionalNotice = `[More available. If the omitted remainder is needed, use offset=${nextOffset} ` +
                    'with the same search arguments and output_mode.]';
                if (modelText.endsWith(sharedFooter)) {
                    modelText = `${modelText.slice(0, -sharedFooter.length)}\n\n${conditionalNotice}`;
                }
                details.desktop_output_continuation = createDesktopOutputContinuation({
                    next_offset: nextOffset,
                    offset_unit: 'file',
                    continuation_hint: {
                        tool: 'grep',
                        preserve_args: [
                            'pattern',
                            'path',
                            'glob',
                            'ignoreCase',
                            'literal',
                            'output_mode',
                            'limit',
                        ],
                        instruction: `If the omitted remainder is needed, call grep again with offset=${nextOffset}; ` +
                            'preserve the same search arguments and output_mode.',
                    },
                });
            }
            const finalText = result.stdoutTruncated
                ? `${modelText}\n\n[Output hit the byte safety cap; totals may be incomplete. Refine the pattern]`
                : modelText;
            const toolResult = withCompatibleGrepToolResponse({
                tool_name: LocalGrepToolDef.name,
                text: finalText,
                content: [{ type: 'text', text: finalText }],
                ...(Object.keys(details).length > 0 ? { details } : {}),
            }, {
                mode,
                filenames: parsed.facts.filenames,
                ...(parsed.facts.numLines !== undefined ? { numLines: parsed.facts.numLines } : {}),
                ...(parsed.facts.numMatches !== undefined ? { numMatches: parsed.facts.numMatches } : {}),
                ...(parsed.facts.totalFiles !== undefined ? { totalFiles: parsed.facts.totalFiles } : {}),
                ...(mode === 'content' ? { content: text } : {}),
                appliedLimit: effectiveLimit,
                appliedOffset: offset,
            });
            if (mode !== 'content') {
                return reportGrep(toolResult, mode === 'count'
                    ? { counts: [...(parsed.facts.counts ?? [])] }
                    : { files: [...parsed.facts.filenames] });
            }
            if (isPtcChildCall(ctx)) {
                // A run_code child gets every match line of the page in full; the
                // 16 KiB cap below is for the model (see isPtcChildCall).
                return reportGrep(withMatchLimitContinuation(toolResult, details, offset + effectiveLimit), {
                    matches: (parsed.matchEntries ?? []).map(({ path, line, text: matchText }) => ({
                        path,
                        line,
                        text: matchText,
                    })),
                }, parsed.uncappedOutput === true ||
                    Buffer.byteLength(finalText, 'utf8') > DESKTOP_GREP_CONTENT_MAX_BYTES);
            }
            let matchLineIndexes = parsed.matchLineIndexes ?? [];
            // Output line index of the first line still shown after leading context was dropped.
            let shownFrom = 0;
            const retainedMatchCount = (lineCount) => matchLineIndexes.filter((lineIndex) => lineIndex < lineCount).length;
            const parserWarnings = [];
            if (typeof details.matchLimitReached === 'number') {
                parserWarnings.push(`${details.matchLimitReached} matches limit reached`);
            }
            if (details.linesTruncated === true) {
                parserWarnings.push('some lines were truncated to 2000 chars; use read for full lines');
            }
            if (finalText.includes(`${MAX_TOTAL_BYTES / 1024}KB output limit reached`)) {
                parserWarnings.push(`${MAX_TOTAL_BYTES / 1024}KB parser limit reached`);
            }
            const desktopNotice = (originalBytes, retainedLines) => {
                const retainedMatches = retainedMatchCount(retainedLines.length);
                return `[desktop grep output truncated: original_bytes=${originalBytes}; ${result.stdoutTruncated ? 'ripgrep byte safety cap was reached; ' : ''}${parserWarnings.length > 0 ? `${parserWarnings.join('; ')}; ` : ''}if the omitted remainder is needed, continue with grep using offset=${offset + retainedMatches} and the same search arguments, or refine pattern/path/glob/context.]`;
            };
            const originalBytes = Buffer.byteLength(finalText, 'utf8');
            let desktopText = finalText;
            let limited = limitDesktopPrefixLines(desktopText, {
                maxBytes: DESKTOP_GREP_CONTENT_MAX_BYTES,
                notice: ({ originalBytes: noticeOriginalBytes, retainedLines }) => desktopNotice(noticeOriginalBytes, retainedLines),
            });
            // If large before-context fills the entire cap, continuing with the same
            // offset would repeat this page forever. Retry from the first actual match
            // and record the omission so the model gets a progressing continuation.
            if (limited.truncation && retainedMatchCount(limited.returnedBodyLines) === 0) {
                const firstMatchIndex = matchLineIndexes[0];
                if (firstMatchIndex !== undefined && firstMatchIndex > 0) {
                    const modelLines = desktopText.split('\n');
                    shownFrom = firstMatchIndex;
                    matchLineIndexes = matchLineIndexes.map((lineIndex) => lineIndex - firstMatchIndex);
                    parserWarnings.push('leading context was omitted to keep pagination progressing');
                    desktopText = modelLines.slice(firstMatchIndex).join('\n');
                    limited = limitDesktopPrefixLines(desktopText, {
                        maxBytes: DESKTOP_GREP_CONTENT_MAX_BYTES,
                        originalBytes,
                        notice: ({ originalBytes: noticeOriginalBytes, retainedLines }) => desktopNotice(noticeOriginalBytes, retainedLines),
                    });
                }
            }
            if (limited.truncation) {
                const lastRetainedMatchIndex = matchLineIndexes
                    .filter((lineIndex) => lineIndex < limited.returnedBodyLines)
                    .at(-1);
                if (lastRetainedMatchIndex !== undefined &&
                    lastRetainedMatchIndex + 1 < limited.returnedBodyLines) {
                    // Context after the last retained match belongs to the next offset
                    // page. Removing it here prevents duplicate context while keeping the
                    // match-offset contract stateless and deterministic.
                    desktopText = desktopText
                        .split('\n')
                        .slice(0, lastRetainedMatchIndex + 1)
                        .join('\n');
                    limited = limitDesktopPrefixLines(desktopText, {
                        maxBytes: DESKTOP_GREP_CONTENT_MAX_BYTES,
                        originalBytes,
                        notice: ({ originalBytes: noticeOriginalBytes, retainedLines }) => desktopNotice(noticeOriginalBytes, retainedLines),
                    });
                }
            }
            if (limited.truncation) {
                const nextOffset = offset + retainedMatchCount(limited.returnedBodyLines);
                limited = withDesktopOutputContinuation(limited, {
                    next_offset: nextOffset,
                    offset_unit: 'match',
                    continuation_hint: {
                        tool: 'grep',
                        preserve_args: [
                            'pattern',
                            'path',
                            'glob',
                            'ignoreCase',
                            'literal',
                            'context',
                            'output_mode',
                            'limit',
                        ],
                        instruction: `If the omitted remainder is needed, call grep again with offset=${nextOffset}; ` +
                            'preserve the same search arguments and output_mode.',
                    },
                });
            }
            // data lists only the match lines the output still shows (no context lines).
            const shownMatches = (parsed.matchEntries ?? [])
                .filter(({ lineIndex }) => lineIndex >= shownFrom &&
                (!limited.truncation || lineIndex - shownFrom < limited.returnedBodyLines))
                .map(({ path, line, text: matchText }) => ({ path, line, text: matchText }));
            return reportGrep(withMatchLimitContinuation(applyDesktopTextLimit(toolResult, limited), details, offset + effectiveLimit), { matches: shownMatches });
        }
    };
    return LocalGrepTool = _classThis;
})();
export { LocalGrepTool };
function emptyGrepData(mode) {
    if (mode === 'content')
        return { matches: [] };
    return mode === 'count' ? { counts: [] } : { files: [] };
}
/** Every non-error return states its completeness and carries the page as data. */
function reportGrep(result, data, uncappedOutput = false) {
    return withDesktopCompletenessReport(LocalGrepToolDef.name, result, {
        data,
        ...(uncappedOutput ? { uncappedOutput } : {}),
    });
}
/**
 * ripgrep's byte cap ended its output before this page, so an empty page does
 * not prove there are no more matches. Keep the truncation marker and say so
 * (mirrors glob) instead of "No matches found".
 */
function outputCutBeforePageResult(mode, offset, limit, details) {
    const text = `${offset > 0 ? `No more matches at offset ${offset}` : 'No matches found'}\n\n` +
        '[Output was truncated before this page could be reached. Refine pattern/path/glob or reduce offset]';
    return withCompatibleGrepToolResponse({
        tool_name: LocalGrepToolDef.name,
        text,
        content: [{ type: 'text', text }],
        details: { ...details, stdoutTruncated: true },
    }, { mode, filenames: [], appliedLimit: limit, appliedOffset: offset });
}
/**
 * At the match limit the next page starts at offset + limit (in matches).
 * PTC scripts get that as a structured continuation through the programmatic
 * side channel; details and the model text stay as they were.
 */
function withMatchLimitContinuation(result, details, nextOffset) {
    if (typeof details.matchLimitReached !== 'number')
        return result;
    // A Desktop 16 KiB cut already names the exact next offset in details.
    if (result.details?.desktop_output_truncation !== undefined)
        return result;
    return withProgrammaticResult(result, {
        completeness: { truncated: true, nextOffset, offsetUnit: 'match' },
    });
}
function isRipgrepRegexParseError(stderr) {
    return stderr.toLocaleLowerCase().includes('regex parse error:');
}
function invalidRegexResult(stderr, exitCode) {
    const rawStderr = stderr.trim();
    const errorSummary = lastRipgrepErrorLine(rawStderr) ?? 'invalid regular expression';
    const text = `Invalid search pattern: ${errorSummary}. ` +
        'Escape regex special characters (for example, use `\\(` for a literal parenthesis) ' +
        'or use `literal=true` for one exact string.';
    return {
        tool_name: LocalGrepToolDef.name,
        text,
        content: [{ type: 'text', text }],
        isError: true,
        details: {
            error_code: INVALID_REGEX_ERROR_CODE,
            exit_code: exitCode,
            stderr: Buffer.from(rawStderr, 'utf8')
                .subarray(0, MAX_GREP_ERROR_STDERR_BYTES)
                .toString('utf8'),
        },
    };
}
function lastRipgrepErrorLine(stderr) {
    const lines = stderr.split(/\r?\n/u);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (line?.toLocaleLowerCase().startsWith('error:')) {
            const summary = line.slice('error:'.length).trim();
            if (summary)
                return summary;
        }
    }
    return undefined;
}
//# sourceMappingURL=local-grep.js.map