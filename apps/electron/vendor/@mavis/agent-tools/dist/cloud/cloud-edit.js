/**
 * CloudEditTool —— `edit` 工具的 cloud 实现。
 *
 * 委托给 pi `createEditTool`,workspace 围栏只在 execute 入口做一次:
 * `resolveWithinWorkspace` 校验 LLM 给的 path 在 workspace 内,再把绝对路径
 * 透传给 pi。pi 自带 BOM strip + CRLF→LF normalize + unique-match check +
 * 多 edit 非重叠校验 + 生成 unified diff,比我们历史手写的 indexOf-replace
 * 更鲁棒;且通过 `withFileMutationQueue` 跟 write 共享 path 锁,杜绝并发踩踏。
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
import { CloudEditToolDef as EditToolDef, } from './builtin-defs.js';
import { createEditTool } from '@earendil-works/pi-coding-agent';
import { assertOfficeGuard, hasOfficeGuardGate } from './office-guard.js';
import { resolveWithinWorkspace } from './path-guard.js';
import { buildReplaceAllEdit, ReplaceAllError, withReplaceAllCount, } from '../shared/replace-all-edit.js';
import { executeEditWithLineNumberRetry, normalizeEditsForLineNumberRetry, } from '../shared/edit-line-number-retry.js';
import { createCapturingEditOperations } from '../shared/edit-capture.js';
import { withCompatibleEditToolResponse } from '../plugin-hooks/vendor-tool-response.js';
let CloudEditTool = (() => {
    let _classDecorators = [bindTool(EditToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var CloudEditTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            CloudEditTool = _classThis = _classDescriptor.value;
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
            const abs = await resolveWithinWorkspace(input.file_path, this.workspaceRoot);
            if (signal?.aborted)
                throw new Error('Operation aborted');
            // Office direct-edit guard — engages only when archon-server downloads
            // the `office-intercept` builtin hook. See office-guard.ts header.
            if (hasOfficeGuardGate(ctx.parentAgentConfig)) {
                assertOfficeGuard('Edit', input.file_path, abs);
            }
            // Translate the compatible style public schema (file_path + old_string +
            // new_string + optional replace_all) into pi's internal
            // { path, edits: [{ oldText, newText }] } shape. `replace_all: true`
            // collapses every occurrence of old_string into a single full-file
            // edit so we still get pi's BOM strip / line-ending restore /
            // unified-diff / withFileMutationQueue locking on the actual write.
            let piEdits;
            let replacedCount;
            if (input.replace_all === true) {
                try {
                    const replacement = await buildReplaceAllEdit(abs, input.old_string, input.new_string);
                    piEdits = replacement.edits;
                    replacedCount = replacement.replacedCount;
                }
                catch (err) {
                    if (err instanceof ReplaceAllError) {
                        throw new Error(err.message);
                    }
                    throw err;
                }
            }
            else {
                piEdits = [{ oldText: input.old_string, newText: input.new_string }];
            }
            // Route the actual write through the line-number-retry wrapper so a
            // model that pasted read's `N→` prefixes into old_string still
            // recovers (CR !4027 P1).
            const capture = createCapturingEditOperations();
            const tool = createEditTool(this.workspaceRoot, { operations: capture.operations });
            const piResult = await executeEditWithLineNumberRetry(tool, { path: abs, edits: piEdits }, signal);
            const res = replacedCount === undefined ? piResult : withReplaceAllCount(piResult, abs, replacedCount);
            const textContent = res.content.filter((c) => c.type === 'text');
            const text = textContent.map((c) => c.text).join('\n');
            const result = {
                tool_name: EditToolDef.name,
                text,
                content: textContent,
                details: (res.details ?? {}),
            };
            const editCapture = capture.takeCapture(abs);
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
    return CloudEditTool = _classThis;
})();
export { CloudEditTool };
//# sourceMappingURL=cloud-edit.js.map