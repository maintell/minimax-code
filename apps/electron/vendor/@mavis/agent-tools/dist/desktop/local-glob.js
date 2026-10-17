/**
 * LocalGlobTool —— `glob` 工具的 desktop 实现（对应 cloud/cloud-glob.ts）。
 *
 * `rg --files` 以 ignore-aware 方式枚举文件，用户 glob 在 runner 流内匹配；
 * 编排同 local-grep.ts，argv 组装是本文件导出的无 IO 纯函数。
 *
 * Hardening（对齐 cloud）：
 * - shared 敏感 deny-list 以 `--glob=!…` 追加（P0-2）
 * - pattern 不进入 rg argv，`-` 开头 pattern 不可能被解析成 rg flag（P0-1）
 *
 * sort（P1-4）：可选 `sort="modified"` 映射 rg `--sortr=modified`（新→旧）。
 * 默认不排序——rg `--sort*` 会禁用并行，大目录变慢；结果被 limit 截断时在
 * notice 里提示可用排序让「留下的」更可能相关。
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
import { bindTool } from '@mavis/agent-core/tools';
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { defaultScanNoiseDirectoriesInSearchRoot, defaultScanExcludeArgs, filterGlobPaths, findGlobMagicIndex, globToPathRegex, isBroadFileScan, isNarrowSearchRoot, resolveGlobStaticSearchRoot, } from '../shared/rg-scan-policy.js';
import { withCompatibleGlobToolResponse } from '../plugin-hooks/vendor-tool-response.js';
import { LocalGlobToolDef } from './builtin-defs.js';
import { resolveSearchRoot, runRg, textResult } from './local-rg-runner.js';
import { isSensitiveSearchRoot, sensitiveExcludeArgs } from './local-sensitive.js';
import { createDesktopOutputContinuation } from './output-limit.js';
const DEFAULT_GLOB_LIMIT = 200;
function isExactFilePattern(pattern) {
    const normalized = pattern.replaceAll('\\', '/');
    return (findGlobMagicIndex(normalized) < 0 &&
        normalized.length > 0 &&
        normalized !== '.' &&
        normalized !== '..' &&
        !normalized.endsWith('/'));
}
export function buildGlobArgs(input) {
    const broadFileScan = input.broadFileScan ?? isBroadFileScan(input.pattern);
    return [
        '--no-config',
        '--no-messages',
        '--files',
        '--hidden',
        // Respect project / Git ignore rules by default so generated artifacts,
        // dependency trees, and local environments do not flood project scans.
        ...(input.include_ignored ? ['--no-ignore'] : []),
        // Newest-first so a truncated page keeps recently changed (likely
        // relevant) files. Off by default: rg --sort* disables parallelism.
        ...(input.sort === 'modified' ? ['--sortr=modified'] : []),
        // Positive rg globs override ignore rules when they match an ignored file
        // or directory. Enumerate the ignore-aware working set and filter the
        // runner stream before unmatched paths can consume the stdout byte cap.
        ...defaultScanExcludeArgs({
            broadFileScan,
            includeDirectoryNoise: input.includeDirectoryNoise,
            allowedDirectoryNoise: input.allowedDirectoryNoise,
        }),
        // Keep the security deny-list last so later scan-policy changes cannot
        // accidentally re-include sensitive paths.
        ...sensitiveExcludeArgs(),
    ];
}
// ─── 绝对路径 pattern 处理（CC extractGlobBaseDirectory parity） ─────────
//
// rg --glob 只匹配相对路径：模型传 `/Users/x/src/**/*.ts` 会静默零结果。
// 把 pattern 的静态前缀提取为搜索根、剩余部分作相对 pattern。
export function splitAbsoluteGlob(pattern) {
    if (!isAbsolute(pattern))
        return { pattern };
    const magicIndex = findGlobMagicIndex(pattern);
    if (magicIndex < 0) {
        // Literal absolute path: search its directory for its basename.
        return { root: dirname(pattern), pattern: basename(pattern) };
    }
    const prefix = pattern.slice(0, magicIndex);
    const cut = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\'));
    if (cut <= 0)
        return { root: '/', pattern: pattern.slice(1) };
    let root = prefix.slice(0, cut);
    // Windows drive root: "C:" means "cwd on drive C" (relative) — force "C:/".
    if (/^[A-Za-z]:$/.test(root))
        root += '/';
    return { root, pattern: pattern.slice(cut + 1) };
}
// ─── 工具编排 ──────────────────────────────────────────────────────────
let LocalGlobTool = (() => {
    let _classDecorators = [bindTool(LocalGlobToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var LocalGlobTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            LocalGlobTool = _classThis = _classDescriptor.value;
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
        async execute(_ctx, input, signal) {
            const startedAt = Date.now();
            if (!input.pattern)
                throw new Error('glob pattern is required');
            const limit = Math.max(1, Math.floor(input.limit ?? DEFAULT_GLOB_LIMIT));
            const offset = input.offset && input.offset > 0 ? Math.floor(input.offset) : 0;
            const split = splitAbsoluteGlob(input.pattern);
            const patternRoot = split.root;
            let effectivePattern = split.pattern;
            // The permission gate reviews `input.path` — an absolute pattern is only
            // a convenience spelling and MUST NOT widen the approved scope. Compare
            // via realpath so a workspace-internal symlink pointing outside
            // (workspace/link -> /etc) cannot smuggle the search root out (same
            // approach as cloud's assertWithinWorkspace). Escaping roots are
            // rejected and routed through `path` (which the gate audits).
            const base = resolveSearchRoot(this.workspaceRoot, input.path);
            let searchRoot = base;
            if (patternRoot) {
                let baseReal;
                let patternRootReal;
                try {
                    baseReal = await realpath(base);
                    patternRootReal = await realpath(resolve(patternRoot));
                }
                catch {
                    throw new Error(`glob path does not exist: ${input.path ?? patternRoot}`);
                }
                const rel = relative(baseReal, patternRootReal);
                const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
                if (!inside) {
                    throw new Error(`glob absolute pattern escapes the approved search path (${base}); pass the directory via "path" so the permission gate can review it`);
                }
                // rg always runs from the reviewed base — running from the pattern's
                // subdirectory would return paths relative to that subdirectory, which
                // follow-up read/edit would then resolve against the base and hit the
                // wrong files. Fold the subdirectory back into the glob instead.
                searchRoot = baseReal;
                if (rel !== '') {
                    effectivePattern = `${rel.split('\\').join('/')}/${effectivePattern}`;
                }
            }
            // Clear error for a missing path — spawn's cwd ENOENT would otherwise
            // surface as a misleading "ripgrep binary not found".
            try {
                await stat(searchRoot);
            }
            catch {
                throw new Error(`glob path does not exist: ${input.path ?? searchRoot}`);
            }
            if (await isSensitiveSearchRoot(searchRoot)) {
                return withCompatibleGlobToolResponse(textResult(LocalGlobToolDef.name, 'No files matched'), {
                    durationMs: Date.now() - startedAt,
                    filenames: [],
                    truncated: false,
                    totalMatches: 0,
                    countIsComplete: true,
                });
            }
            const requestedRoot = resolveGlobStaticSearchRoot(effectivePattern, searchRoot);
            const narrowSearchRoot = await isNarrowSearchRoot(requestedRoot, this.workspaceRoot);
            const exactFilePattern = isExactFilePattern(effectivePattern);
            const explicitIgnoredScope = narrowSearchRoot || exactFilePattern;
            if (input.include_ignored && !explicitIgnoredScope) {
                throw new Error('include_ignored requires a narrow path, pattern prefix, or exact filename; narrow the search scope before inspecting ignored artifacts');
            }
            const broadFileScan = isBroadFileScan(effectivePattern) && !narrowSearchRoot;
            const allowedDirectoryNoise = defaultScanNoiseDirectoriesInSearchRoot(requestedRoot, searchRoot);
            const result = await runRg(buildGlobArgs({
                pattern: effectivePattern,
                ...(input.sort ? { sort: input.sort } : {}),
                ...(input.include_ignored ? { include_ignored: true } : {}),
                broadFileScan,
                includeDirectoryNoise: Boolean(input.include_ignored && narrowSearchRoot && !exactFilePattern),
                allowedDirectoryNoise,
            }), searchRoot, {
                ...this.rgOptions,
                stdoutLineRegex: globToPathRegex(effectivePattern),
                maxStdoutLines: offset + limit + 1,
                ...(signal ? { signal } : {}),
            });
            if (result.timedOut)
                throw new Error('glob timed out');
            // rg --files: exit 1 = no files matched (NOT an error), 2 = error. A
            // byte-cap kill ends the child via signal (exitCode null) — that is a
            // truncation, not a failure: fall through and list the partial output.
            if (result.exitCode !== 0 && result.exitCode !== 1 && !result.stdoutTruncated) {
                const reason = result.stderr.trim() || `ripgrep exited with code ${result.exitCode}`;
                throw new Error(`glob failed: ${reason}`);
            }
            const discoveredLines = result.stdout
                .split('\n')
                .map((line) => line.replace(/\r$/, '').trim())
                .filter((line) => line.length > 0);
            const allLines = filterGlobPaths(discoveredLines, effectivePattern);
            const lines = allLines.slice(offset, offset + limit);
            const truncated = allLines.length > offset + lines.length || result.stdoutTruncated;
            let text = lines.length > 0
                ? lines.join('\n')
                : offset > 0
                    ? `No more files matched at offset ${offset}`
                    : 'No files matched';
            const details = { matched: lines.length, limit, offset };
            if (truncated) {
                details.truncated = true;
                if (lines.length > 0) {
                    const nextOffset = offset + lines.length;
                    details.next_offset = nextOffset;
                    details.desktop_output_continuation = createDesktopOutputContinuation({
                        next_offset: nextOffset,
                        offset_unit: 'file',
                        continuation_hint: {
                            tool: 'glob',
                            preserve_args: ['pattern', 'path', 'include_ignored', 'limit', 'sort'],
                            instruction: `If the omitted remainder is needed, call glob again with offset=${nextOffset}; ` +
                                'preserve the same search arguments.',
                        },
                    });
                    text +=
                        `\n\n[Results truncated: showing ${lines.length} paths from offset ${offset}. ` +
                            `If the omitted remainder is needed, use offset=${nextOffset} with the same search arguments. ` +
                            `Refine path/pattern or pass sort="modified" to surface recently changed files]`;
                }
                else {
                    text +=
                        '\n\n[Output was truncated before this page could be reached. ' +
                            'Refine path/pattern or reduce offset]';
                }
            }
            return withCompatibleGlobToolResponse({
                tool_name: LocalGlobToolDef.name,
                text,
                content: [{ type: 'text', text }],
                details,
            }, {
                durationMs: Date.now() - startedAt,
                filenames: lines,
                truncated,
                totalMatches: allLines.length,
                countIsComplete: !result.stdoutTruncated,
            });
        }
    };
    return LocalGlobTool = _classThis;
})();
export { LocalGlobTool };
//# sourceMappingURL=local-glob.js.map