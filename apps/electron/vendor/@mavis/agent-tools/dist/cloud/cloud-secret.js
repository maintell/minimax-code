/**
 * CloudSecretTool —— `secret` 单一 LLM 工具,内部按 `command`
 * (`"list" / "create" / "update" / "delete"`)派发到 archon-server SecretService
 * 4 条 RPC。形态参考 `mavis` tool 的 dispatcher 风格,把 4 个相关 CRUD 收成
 * 一个工具暴露面,减少 LLM 工具列表噪音。
 *
 * **CLI 风格 args**:不再要 `args: {…}` JSON object,改成单一 `args: "<flags>"`
 * 字符串(`--name=OPENAI_API_KEY --value=sk-xxx --description="..."`)。模型对
 * shell 风格 args 的训练分布更稠,长字符串 value 也更自然(不用 JSON 转义反斜
 * 线)。解析走 `shell-quote.parse` 拆 token(支持引号 / 转义),`--key=value` /
 * `--key value` 两种形态都接受,布尔标志暂未使用。
 *
 * **command 容错**:agent 可能误传 `"secret list"` 当 command(被 description
 * 例子 "误导"),首词为 `secret` 时自动 trim 掉。
 *
 * 路由:HTTP path 跟前端 UI 共用同一组(/api/v1/secrets/*),鉴权全走
 * archon-server 标准管线;cloud-runtime 反向调时
 * `RemoteArchonServerAdapter.headers()` 自动注入 X-Archon-User-Id /
 * X-Archon-Biz-Id / X-Request-SK,跟 SessionExchange / executeShell 同套。
 *
 * **DB 是事实源**:一律先 RPC 成功,再 patch `ctx.secretStore` in-mem
 * (`applyCreate / applyUpdate / applyDelete`)。RPC 失败 store 不动 →
 * DB / 内存永不分裂。设计文档 D8:不防明文回显窗口 — create/update 的
 * tool_use payload 里 value 明文会先 emit 一帧再进 masker 池,这是 agent
 * 显式行为不视为泄漏。
 *
 * **client-side 预校验**:create / update 在打 RPC 前先做
 *   - name 正则 ^[A-Z][A-Z0-9_]{0,63}$
 *   - value UTF-8 字节长度 ≤ 4096
 * 避免无谓的网络 round-trip;server-side 同套校验是最终防线。
 *
 * **list 不返 value**:archon-server 永不返明文 value,只返
 * `SecretMeta { name, description, healthy, ... }` —— LLM 通过 list 知道
 * 有哪些 secret 可用、name 是什么、健不健康,**真正读 value 走
 * `${SECRET_NAME}` 注入**(env var 路径,不通过 LLM 文本)。
 *
 * **失败语义**:base_resp.status_code != 0 → 业务失败 ToolResult,不抛异常;
 * 跟 mavis / web_fetch 等 cloud tool 一致。HTTP-level 失败(网络 / 超时)
 * 由 archonServer.callRpc 自己抛错,turn 走 failed 路径。
 *
 * **secretStore 缺失 fallback**:tool 通过 `ctx.secretStore?` 访问 store,缺失
 * (legacy / test ctx 没注入)时跳过 patch — RPC 已经成功,store 跟不上的代价
 * 只是本 turn 内剩余 outbound 不被 masker 盖住,下次 START bootstrap 自然
 * 收敛。绝不抛错。
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
import { parse as shellParse } from 'shell-quote';
import { Type } from '@sinclair/typebox';
import { bindTool, } from '@mavis/agent-core/tools';
// ─── 共享约束 ─────────────────────────────────────────────────────────────
/** Name 正则 —— 跟 server-side / IDL 注释一致,client / server 同套防线。 */
const SECRET_NAME_REGEX = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Value 明文 UTF-8 字节长度上限。 */
const SECRET_VALUE_MAX_BYTES = 4096;
/** 支持的子命令集合 —— 用于 command trim 后的归一化校验。 */
const SECRET_COMMANDS = ['list', 'create', 'update', 'delete'];
// ─── tool def ───────────────────────────────────────────────────────────
export const SecretToolDef = {
    name: 'secret',
    description: `Create, list, update, and delete the user's encrypted secrets for cloud tools.

Use this when the user wants to save API keys, tokens, or other credentials so later commands can reference them as environment variables like \${OPENAI_API_KEY}. The list command only shows secret names and metadata; plaintext values are never returned.

Secret names must be uppercase env-var names, e.g. OPENAI_API_KEY.`,
    schema: Type.Object({
        command: Type.String({
            description: 'Subcommand: "list" / "create" / "update" / "delete". A leading "secret " prefix is tolerated and stripped.',
        }),
        args: Type.Optional(Type.String({
            description: 'CLI-style flags string. create: --name=NAME --value=PLAINTEXT [--description="..."]; update: --name=NAME [--value=NEW_VALUE] [--description="..."]; delete: --name=NAME; empty for list. Quote values with spaces.',
        })),
    }),
};
// ─── command / args 归一化 ─────────────────────────────────────────────
/**
 * 把 raw command 归一化到 `SecretCommand` 之一。
 *   - 多余空白 trim
 *   - 首词如果是 `secret`(大小写不敏感)就剥掉,容错 agent 误传 `"secret list"`
 *   - 剩下的第一词是 subcommand,**忽略**之后的尾部 token(防 `"secret list all"`
 *     这种乱填撞 unknown)
 * 不在集合内返 `{ ok: false }`,handler 返业务失败 ToolResult。
 */
function normalizeCommand(raw) {
    const trimmed = raw.trim();
    if (!trimmed) {
        return { ok: false, error: 'command must be non-empty' };
    }
    const tokens = trimmed.split(/\s+/);
    // strip leading "secret " (case-insensitive) — see normalizeCommand docstring.
    if (tokens.length > 1 && tokens[0]?.toLowerCase() === 'secret') {
        tokens.shift();
    }
    const head = (tokens[0] ?? '').toLowerCase();
    if (!isSecretCommand(head)) {
        return {
            ok: false,
            error: `unknown command "${raw}"; want one of: ${SECRET_COMMANDS.join(' / ')}`,
        };
    }
    return { ok: true, command: head };
}
function isSecretCommand(s) {
    return SECRET_COMMANDS.includes(s);
}
function parseCliArgs(raw) {
    const out = { flags: {}, positionals: [] };
    if (!raw)
        return out;
    const tokens = shellParse(raw).filter((t) => typeof t === 'string');
    for (let i = 0; i < tokens.length; i += 1) {
        const tok = tokens[i];
        if (tok === undefined)
            continue;
        if (!tok.startsWith('--')) {
            out.positionals.push(tok);
            continue;
        }
        const stripped = tok.slice(2);
        const eq = stripped.indexOf('=');
        if (eq >= 0) {
            // `--key=value` 或 `--key=`(空 value)
            out.flags[stripped.slice(0, eq)] = stripped.slice(eq + 1);
            continue;
        }
        // `--key value` 或裸 `--key`(布尔)
        const next = tokens[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
            out.flags[stripped] = next;
            i += 1;
        }
        else {
            out.flags[stripped] = '';
        }
    }
    return out;
}
// ─── 共享 helper ────────────────────────────────────────────────────────
function businessFailureResult(command, resp) {
    const statusCode = resp.base_resp?.status_code ?? 0;
    const message = resp.base_resp?.status_msg ??
        `archon-server secret ${command} returned non-zero status_code=${statusCode}`;
    return {
        tool_name: SecretToolDef.name,
        text: message,
        content: [{ type: 'text', text: message }],
        details: { ok: false, command, status_code: statusCode },
    };
}
function clientValidationFailureResult(command, message) {
    return {
        tool_name: SecretToolDef.name,
        text: message,
        content: [{ type: 'text', text: message }],
        details: { ok: false, command, reason: 'client_validation_failed' },
    };
}
function utf8ByteLength(s) {
    return Buffer.byteLength(s, 'utf8');
}
function projectMeta(meta) {
    return {
        name: meta.name,
        ...(meta.description ? { description: meta.description } : {}),
        ...(meta.healthy !== undefined ? { healthy: meta.healthy } : {}),
        created_at: meta.created_at,
        updated_at: meta.updated_at,
        ...(meta.last_used_at !== undefined ? { last_used_at: meta.last_used_at } : {}),
    };
}
// ─── tool impl ─────────────────────────────────────────────────────────
let CloudSecretTool = (() => {
    let _classDecorators = [bindTool(SecretToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var CloudSecretTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            CloudSecretTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        archonServer;
        constructor(archonServer) {
            this.archonServer = archonServer;
        }
        async execute(ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            const normalized = normalizeCommand(input.command);
            if (!normalized.ok) {
                // 这里 command 还没归一,沿用原始字符串到 result.details 便于诊断。
                return clientValidationFailureResult(input.command, normalized.error);
            }
            const parsed = parseCliArgs(input.args);
            switch (normalized.command) {
                case 'list':
                    return this.handleList(signal);
                case 'create':
                    return this.handleCreate(ctx, parsed, signal);
                case 'update':
                    return this.handleUpdate(ctx, parsed, signal);
                case 'delete':
                    return this.handleDelete(ctx, parsed, signal);
            }
        }
        async handleList(signal) {
            const resp = await this.archonServer.callRpc('ListSecrets', {}, signal);
            if ((resp.base_resp?.status_code ?? 0) !== 0) {
                return businessFailureResult('list', resp);
            }
            const entries = (resp.secrets ?? []).map(projectMeta);
            const text = formatListResp(entries);
            return {
                tool_name: SecretToolDef.name,
                text,
                content: [{ type: 'text', text }],
                details: { ok: true, command: 'list', count: entries.length, secrets: entries },
            };
        }
        async handleCreate(ctx, args, signal) {
            const name = args.flags.name;
            const value = args.flags.value;
            const description = args.flags.description;
            if (!name) {
                return clientValidationFailureResult('create', '--name=<NAME> is required');
            }
            if (!SECRET_NAME_REGEX.test(name)) {
                return clientValidationFailureResult('create', `Invalid --name="${name}": must match ^[A-Z][A-Z0-9_]{0,63}$`);
            }
            if (value === undefined) {
                return clientValidationFailureResult('create', '--value=<PLAINTEXT> is required');
            }
            const valueBytes = utf8ByteLength(value);
            if (valueBytes === 0) {
                return clientValidationFailureResult('create', '--value must be non-empty');
            }
            if (valueBytes > SECRET_VALUE_MAX_BYTES) {
                return clientValidationFailureResult('create', `--value exceeds max ${SECRET_VALUE_MAX_BYTES} bytes (got ${valueBytes} bytes UTF-8)`);
            }
            const resp = await this.archonServer.callRpc('CreateSecret', {
                name,
                value,
                ...(description !== undefined ? { description } : {}),
            }, signal);
            if ((resp.base_resp?.status_code ?? 0) !== 0) {
                return businessFailureResult('create', resp);
            }
            // DB 已成功 → patch hot cache,让 masker 立刻盖住后续 outbound 里出现的 value
            // 字面量。secretStore 缺失(legacy ctx)只跳过 patch,RPC 已成功不退化为失败。
            ctx.secretStore?.applyCreate?.(name, value);
            const meta = resp.secret
                ? projectMeta(resp.secret)
                : { name, created_at: 0, updated_at: 0 };
            const text = `Created secret "${name}"${meta.description ? ` (${meta.description})` : ''}. Value stored encrypted; use \${${name}} to reference it.`;
            return {
                tool_name: SecretToolDef.name,
                text,
                content: [{ type: 'text', text }],
                details: { ok: true, command: 'create', secret: meta },
            };
        }
        async handleUpdate(ctx, args, signal) {
            const name = args.flags.name;
            const value = args.flags.value;
            const description = args.flags.description;
            if (!name) {
                return clientValidationFailureResult('update', '--name=<NAME> is required');
            }
            if (!SECRET_NAME_REGEX.test(name)) {
                return clientValidationFailureResult('update', `Invalid --name="${name}": must match ^[A-Z][A-Z0-9_]{0,63}$`);
            }
            if (value === undefined && description === undefined) {
                return clientValidationFailureResult('update', 'Must provide at least one of --value / --description to update.');
            }
            if (value !== undefined) {
                const valueBytes = utf8ByteLength(value);
                if (valueBytes === 0) {
                    return clientValidationFailureResult('update', '--value must be non-empty when provided');
                }
                if (valueBytes > SECRET_VALUE_MAX_BYTES) {
                    return clientValidationFailureResult('update', `--value exceeds max ${SECRET_VALUE_MAX_BYTES} bytes (got ${valueBytes} bytes UTF-8)`);
                }
            }
            const resp = await this.archonServer.callRpc('UpdateSecret', {
                name,
                ...(value !== undefined ? { value } : {}),
                ...(description !== undefined ? { description } : {}),
            }, signal);
            if ((resp.base_resp?.status_code ?? 0) !== 0) {
                return businessFailureResult('update', resp);
            }
            // applyUpdate 在 newValue 缺失 / value 没变时是 no-op,单独描述更新不会
            // 触发 masker 重建。
            ctx.secretStore?.applyUpdate?.(name, value);
            const meta = resp.secret
                ? projectMeta(resp.secret)
                : { name, created_at: 0, updated_at: 0 };
            const changed = [];
            if (value !== undefined)
                changed.push('value');
            if (description !== undefined)
                changed.push('description');
            const text = `Updated secret "${name}" (${changed.join(' + ')}).`;
            return {
                tool_name: SecretToolDef.name,
                text,
                content: [{ type: 'text', text }],
                details: { ok: true, command: 'update', secret: meta, changed },
            };
        }
        async handleDelete(ctx, args, signal) {
            const name = args.flags.name;
            if (!name) {
                return clientValidationFailureResult('delete', '--name=<NAME> is required');
            }
            if (!SECRET_NAME_REGEX.test(name)) {
                return clientValidationFailureResult('delete', `Invalid --name="${name}": must match ^[A-Z][A-Z0-9_]{0,63}$`);
            }
            const resp = await this.archonServer.callRpc('DeleteSecret', { name }, signal);
            if ((resp.base_resp?.status_code ?? 0) !== 0) {
                return businessFailureResult('delete', resp);
            }
            // 删 in-mem;不存在的 key 是 no-op。masker 在 store 真删时才 rebuild。
            ctx.secretStore?.applyDelete?.(name);
            const text = `Deleted secret "${name}".`;
            return {
                tool_name: SecretToolDef.name,
                text,
                content: [{ type: 'text', text }],
                details: { ok: true, command: 'delete', name },
            };
        }
    };
    return CloudSecretTool = _classThis;
})();
export { CloudSecretTool };
// ─── formatters ─────────────────────────────────────────────────────────
function formatListResp(entries) {
    if (entries.length === 0) {
        return 'No secrets configured. Use secret({ command: "create", args: "--name=... --value=..." }) to add one.';
    }
    const lines = [`${entries.length} secret(s):`];
    for (const e of entries) {
        const parts = [`- ${e.name}`];
        if (e.description)
            parts.push(`(${e.description})`);
        if (e.healthy === false)
            parts.push('[UNHEALTHY: encrypted blob unreadable; please reset]');
        lines.push(parts.join(' '));
    }
    lines.push('');
    lines.push(`Reference values in commands via \${SECRET_NAME}.`);
    return lines.join('\n');
}
//# sourceMappingURL=cloud-secret.js.map