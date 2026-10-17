/**
 * CloudSkillTool —— `skill` 工具的 cloud 实现。
 *
 * 按 cloud-runtime 提供的 turn-local effective Skill lookup 读取 SKILL.md。
 * Plugin Skill 直接读取已校验 package 中的正文；hosted Skill 优先走 OSS
 * (`registryStore` + `ossClient` 全部就绪时)，否则 fallback 到 sandbox
 * 本地 skill-hosting 路径。没有 lookup 的旧调用方保持原 hosted 行为。
 *
 * 工具 def 在本文件里就近定义 —— `skill` 是 cloud-runtime 专有的 host-only
 * 工具,agent-core 不需要知道它。SchemaShape:
 *   { name: string }   // effective skill name (matches SKILL.md frontmatter)
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
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { bindTool, } from '@mavis/agent-core/tools';
import { formatSkillContent, resolveSkillContent as resolveSkillContentFromOss, } from './skill-reader.js';
export const SkillReadToolDef = {
    name: 'skill',
    description: 'Loads the complete SKILL.md instructions for an available hosted or plugin skill.\n\n' +
        '- Load a skill when the user explicitly names it (including `/name`), or its name and description in `available_skills` clearly match the request or linked resource. Do not load unrelated skills.\n' +
        '- Set `name` to an exact catalog name or one the user explicitly provided, without a leading slash; preserve any `plugin:skill` prefix. Do not guess names or invoke built-in CLI commands such as `/help` or `/clear`.\n' +
        '- Before related task actions, make this the first and only tool call in the assistant step. Wait for the complete result, then follow its instructions to perform the task.\n' +
        '- Reuse complete instructions already in context when their loading prerequisites are satisfied; an earlier-turn result does not satisfy a current-turn loading requirement.\n' +
        '- If the skill is not found or cannot be read, it has not been loaded. Do not claim to have used it.',
    schema: Type.Object({
        name: Type.String({
            description: 'Exact skill name from the catalog or user, without a leading slash; preserve any plugin prefix.',
        }),
    }),
};
let CloudSkillTool = (() => {
    let _classDecorators = [bindTool(SkillReadToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var CloudSkillTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            CloudSkillTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        deps;
        constructor(deps) {
            this.deps = deps;
        }
        async execute(_ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            const name = (typeof input.name === 'string' && input.name.trim()) || 'unknown-skill';
            const outcome = await this.readSkillContent(_ctx, name, signal);
            return {
                tool_name: SkillReadToolDef.name,
                text: outcome.text,
                content: [{ type: 'text', text: outcome.text }],
                details: {
                    kind: 'skill',
                    skill: name,
                    found: outcome.found,
                    readable: outcome.readable,
                    source: outcome.source,
                    owner: 'cloud_host',
                },
            };
        }
        async readSkillContent(ctx, name, signal) {
            const { skillsDir, registryStore, ossClient, log } = this.deps;
            const selected = ctx.skillLookup?.lookup(name);
            if (ctx.skillLookup && !selected)
                return notFound(name);
            if (selected?.source === 'plugin') {
                return {
                    text: formatSkillContent(selected.name, selected.content, selected.location),
                    found: true,
                    readable: true,
                    source: 'plugin',
                };
            }
            if (!skillsDir)
                return notFound(name);
            const hostedName = selected?.name ?? name;
            const content = registryStore && ossClient && log
                ? await resolveSkillContentFromOss(hostedName, {
                    log,
                    registryStore,
                    ossClient,
                    skillsDir,
                })
                : await readLocalHostedSkillContent(skillsDir, hostedName);
            // OSS / 本地读取本身不接 signal(底层 SDK 限制);abort 在 await 之后立刻
            // 抛出,避免接下来 format + 返回的多余工作。真正的 IO cancel 要等 OSS
            // client / fs SDK 自己加 signal 支持。
            if (signal?.aborted)
                throw new Error('Operation aborted');
            if (content === null) {
                return notFound(hostedName);
            }
            const skillDir = join(skillsDir, hostedName);
            return {
                text: formatSkillContent(hostedName, content, skillDir),
                found: true,
                readable: true,
                source: 'hosted',
            };
        }
    };
    return CloudSkillTool = _classThis;
})();
export { CloudSkillTool };
function notFound(name) {
    return {
        text: `Cloud Host skill not found: ${name}`,
        found: false,
        readable: false,
        source: 'none',
    };
}
async function readLocalHostedSkillContent(skillsDir, name) {
    const localSkillMd = join(skillsDir, name, 'SKILL.md');
    try {
        return await readFile(localSkillMd, 'utf-8');
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=cloud-skill.js.map