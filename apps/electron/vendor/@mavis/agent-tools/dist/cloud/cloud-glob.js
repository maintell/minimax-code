/**
 * CloudGlobTool —— `glob` 工具的 cloud 实现。
 *
 * 用 `rg --files --glob=<pattern>` 在沙箱里列匹配文件,等价于 pi 的 find
 * 工具但我们改名为 `glob`。同样套 sensitive deny-list,并 clamp 到 limit。
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
import { resolve } from 'node:path';
import { bindTool } from '@mavis/agent-core/tools';
import { CloudGlobToolDef as GlobToolDef, } from './builtin-defs.js';
import { withCompatibleGlobToolResponse } from '../plugin-hooks/vendor-tool-response.js';
import { assertWithinWorkspace } from './path-guard.js';
import { runRgInSandbox, shellQuote, withSensitiveExcludeArgs } from './sandbox-rg-runner.js';
const DEFAULT_LIMIT = 1_000;
let CloudGlobTool = (() => {
    let _classDecorators = [bindTool(GlobToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var CloudGlobTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            CloudGlobTool = _classThis = _classDescriptor.value;
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
            const startedAt = Date.now();
            if (!input.pattern) {
                throw new Error('glob pattern is required');
            }
            const limit = Math.max(1, Math.floor(input.limit ?? DEFAULT_LIMIT));
            const root = resolve(this.workspaceRoot);
            const searchRoot = input.path ? resolve(root, input.path) : root;
            await assertWithinWorkspace(searchRoot, root);
            const args = withSensitiveExcludeArgs([
                '--no-config',
                '--no-messages',
                '--files',
                '--hidden',
                // Deterministic gitignore behavior (CC parity): without --no-ignore the
                // outcome depends on pattern shape (`**/*` pierces ignored dirs,
                // `**/*.ts` does not). Gitignored files are ALWAYS listed; the deny-list
                // appended by withSensitiveExcludeArgs still applies.
                '--no-ignore',
                // Newest-first so a truncated page keeps recently changed files (P1-4).
                ...(input.sort === 'modified' ? ['--sortr=modified'] : []),
                `--glob=${shellQuote(input.pattern)}`,
            ]);
            const result = await runRgInSandbox(this.archonServer, {
                cwd: searchRoot,
                args,
                patternAndTargets: [],
                ctx,
                ...(signal ? { signal } : {}),
            });
            if (result.timedOut) {
                throw new Error('glob timed out');
            }
            // rg --files: exit code 1 = no files matched (NOT an error), 2 = error.
            // Sandbox output truncation is not a failure — list the partial output.
            if (result.exitCode !== 0 && result.exitCode !== 1 && !result.outputTruncated) {
                const reason = result.stderr.trim() || `ripgrep exited with code ${result.exitCode}`;
                throw new Error(`glob failed: ${reason}`);
            }
            const allLines = result.stdout
                .split('\n')
                .map((line) => line.replace(/\r$/, '').trim())
                .filter((line) => line.length > 0);
            const lines = allLines.slice(0, limit);
            const truncated = allLines.length > limit || result.outputTruncated;
            let text = lines.length === 0 ? 'No files matched' : lines.join('\n');
            const details = { matched: lines.length, limit };
            if (truncated) {
                details.truncated = true;
                const total = result.outputTruncated ? `${allLines.length}+` : `${allLines.length}`;
                text +=
                    `\n\n[Results truncated: showing ${lines.length} of ${total}. ` +
                        `Refine the pattern, raise limit, or pass sort="modified" to surface recently changed files]`;
            }
            return withCompatibleGlobToolResponse({
                tool_name: GlobToolDef.name,
                text,
                content: [{ type: 'text', text }],
                details,
            }, {
                durationMs: Date.now() - startedAt,
                filenames: lines,
                truncated,
                totalMatches: allLines.length,
                countIsComplete: !result.outputTruncated,
            });
        }
    };
    return CloudGlobTool = _classThis;
})();
export { CloudGlobTool };
//# sourceMappingURL=cloud-glob.js.map