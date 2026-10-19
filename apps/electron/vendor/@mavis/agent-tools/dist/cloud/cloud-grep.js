/**
 * CloudGrepTool —— `grep` 工具的 cloud 实现。
 *
 * 把 rg 命令转给沙箱 `executeShell` 跑(详见 sandbox-rg-runner.ts 的设计
 * rationale)。本类负责:
 *   - 输入校验 + workspace 围栏
 *   - 构造 rg 参数(output_mode 映射、sensitive deny-list、`--no-config`、
 *     `--max-filesize`、content 模式 `--max-count=offset+limit+1`)
 *   - 解析 rg 输出:exit code 1 = no matches,2 = error
 *   - 输出后处理走 shared/grep-parse.ts(与 desktop 同一实现,P0-3/P1-1):
 *     files_with_matches(默认)/content/count 三种 output_mode + offset 分页
 *
 * 注意:sensitive deny-list 必须追加在用户 glob 之后(rg glob 规则
 * last-match-wins,否则用户 glob 会覆盖 `!` 排除规则重新包含敏感文件)。
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
import { isAbsolute, resolve } from 'node:path';
import { bindTool } from '@mavis/agent-core/tools';
import { DEFAULT_GREP_OUTPUT_MODE, grepModeFlags, parseCountOutput, parseFilesOutput, parseGrepOutput, splitGlobFilters, } from '../shared/grep-parse.js';
import { CloudGrepToolDef as GrepToolDef, } from './builtin-defs.js';
import { withCompatibleGrepToolResponse } from '../plugin-hooks/vendor-tool-response.js';
import { assertWithinWorkspace } from './path-guard.js';
import { runRgInSandbox, shellQuote, withSensitiveExcludeArgs } from './sandbox-rg-runner.js';
const DEFAULT_LIMIT = 100;
const MAX_FILESIZE_FLAG = '1M';
let CloudGrepTool = (() => {
    let _classDecorators = [bindTool(GrepToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var CloudGrepTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            CloudGrepTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        workspaceRoot;
        archonServer;
        constructor(workspaceRoot, archonServer) {
            this.workspaceRoot = workspaceRoot;
            this.archonServer = archonServer;
        }
        async execute(ctx, input, signal) {
            if (!input.pattern) {
                throw new Error('grep pattern is required');
            }
            // Floor before it reaches `--max-count`: the schema types limit as a
            // number, and a fractional value would render `--max-count=3.5` → rg
            // exits 2 ("grep failed"). Mirrors local-grep / cloud-glob.
            const effectiveLimit = Math.max(1, Math.floor(input.limit ?? DEFAULT_LIMIT));
            const mode = input.output_mode ?? DEFAULT_GREP_OUTPUT_MODE;
            const offset = input.offset && input.offset > 0 ? Math.floor(input.offset) : 0;
            const ctxLines = mode === 'content' && input.context && input.context > 0 ? Math.floor(input.context) : 0;
            const root = resolve(this.workspaceRoot);
            const searchRoot = input.path
                ? isAbsolute(input.path)
                    ? resolve(input.path)
                    : resolve(root, input.path)
                : root;
            await assertWithinWorkspace(searchRoot, root);
            const baseArgs = [
                '--no-config',
                '--no-messages',
                '--hidden',
                `--max-filesize=${MAX_FILESIZE_FLAG}`,
                ...grepModeFlags(mode),
            ];
            if (mode === 'content') {
                // ripgrep applies --max-count per file; the surplus row lets
                // parseGrepOutput detect "more available" beyond the requested page.
                baseArgs.push('--null', `--max-count=${offset + effectiveLimit + 1}`);
            }
            if (input.ignoreCase)
                baseArgs.push('--ignore-case');
            if (input.literal)
                baseArgs.push('--fixed-strings');
            // Gitignore: grep always respects it (CC parity, no toggle).
            if (ctxLines > 0)
                baseArgs.push(`--context=${ctxLines}`);
            if (input.glob) {
                for (const g of splitGlobFilters(input.glob))
                    baseArgs.push(`--glob=${shellQuote(g)}`);
            }
            // withSensitiveExcludeArgs appends the deny-list AFTER the user glob —
            // required because rg glob rules are last-match-wins.
            const args = withSensitiveExcludeArgs(baseArgs);
            const result = await runRgInSandbox(this.archonServer, {
                cwd: searchRoot,
                args,
                patternAndTargets: [input.pattern, '.'],
                ctx,
                ...(signal ? { signal } : {}),
            });
            if (result.timedOut) {
                throw new Error('grep timed out');
            }
            if (result.exitCode === 1) {
                return withCompatibleGrepToolResponse({
                    tool_name: GrepToolDef.name,
                    text: 'No matches found',
                    content: [{ type: 'text', text: 'No matches found' }],
                }, {
                    mode,
                    filenames: [],
                    appliedLimit: effectiveLimit,
                    appliedOffset: offset,
                });
            }
            // Sandbox output truncation is not a failure — parse the partial stdout
            // and flag it (mirrors desktop stdoutTruncated handling).
            if (result.exitCode !== 0 && !result.outputTruncated) {
                const reason = result.stderr.trim() || `ripgrep exited with code ${result.exitCode}`;
                throw new Error(`grep failed: ${reason}`);
            }
            const parseOpts = { limit: effectiveLimit, offset };
            const parsed = mode === 'files_with_matches'
                ? parseFilesOutput(result.stdout, parseOpts)
                : mode === 'count'
                    ? parseCountOutput(result.stdout, parseOpts)
                    : parseGrepOutput(result.stdout, parseOpts);
            const { text, details } = parsed;
            if (text.trim().length === 0) {
                return withCompatibleGrepToolResponse({
                    tool_name: GrepToolDef.name,
                    text: 'No matches found',
                    content: [{ type: 'text', text: 'No matches found' }],
                }, {
                    mode,
                    filenames: [],
                    appliedLimit: effectiveLimit,
                    appliedOffset: offset,
                });
            }
            if (result.outputTruncated) {
                details.outputTruncated = true;
            }
            const finalText = result.outputTruncated
                ? `${text}\n\n[Sandbox output was truncated; totals may be incomplete. Refine the pattern]`
                : text;
            return withCompatibleGrepToolResponse({
                tool_name: GrepToolDef.name,
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
        }
    };
    return CloudGrepTool = _classThis;
})();
export { CloudGrepTool };
//# sourceMappingURL=cloud-grep.js.map