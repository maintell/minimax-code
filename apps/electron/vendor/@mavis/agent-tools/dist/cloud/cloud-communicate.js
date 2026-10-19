/**
 * CloudCommunicateTool —— `communicate` 工具的 cloud 实现。
 *
 * 模型 schema 暴露两种调用形态:
 *   - **send mode**(默认): {to_session, content} → 发消息给已存在的 peer。
 *   - **spawn mode**:        {spawn: {agent_name, title?}, content} → 一次调用同时
 *                              创建一个 Branch 子 session 并把 content 作为它的首条
 *                              user_message。轻量验收/二次审视场景的 team 工具替代。
 *
 * Send 路径(原)走 archon-server `Communicate(command='prompt')`,服务端按
 * target.status 分流 START / INJECT。
 *
 * Spawn 路径走 `Communicate(command='spawn', spawn_config={...})` 这条原子链路,
 * archon-server `handleSpawn` 完成 agent 解析 + CreateChildSession + control_harness
 * START 一气呵成。三态结果:
 *   - Delivered            → ok:true,  child_session_id 必填,status="spawned"
 *   - CreateOkPromptFailed → ok:false, child_session_id 已 back-fill,提示用
 *                            to_session=<child_session_id> 走 send 路径补送
 *   - CreateFailed         → ok:false, 无 child_session_id,提示直接 spawn 重试
 *
 * Source 标签固定 ToolCall(=1),与 team-engine 的 TeamEngine(=2)区分。
 *
 * 失败语义同 send 路径:返业务失败 ToolResult,不抛异常打断 turn。
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
import { Type } from '@sinclair/typebox';
import { bindTool, } from '@mavis/agent-core/tools';
import { CommunicateDeliveryStatus, CommunicateSource, } from './runtime-types.js';
export const CommunicateToolDef = {
    name: 'communicate',
    description: 'Talk to another session — either an existing peer or a new subordinate spawned just for this task.\n' +
        '\n' +
        '**Send mode** (default): { to_session, content }. Use the `mavis` tool first to discover reachable peers: ' +
        '`mavis({ command: "session list", args: { mode: "peers", session_id: "<current-session-id>" } })`.\n' +
        '\n' +
        '**Spawn mode**: { spawn: { agent_name, title? }, content }. Atomically creates a Branch session under ' +
        'the current session and delivers `content` as its first user message. The new session does the work, ' +
        'reports back via its own `communicate`, then exits — useful for one-off review / verify / second-opinion ' +
        'passes when a full `team` cycle is overkill.\n' +
        '\n' +
        'Exactly one of `to_session` and `spawn` must be present.',
    schema: Type.Object({
        to_session: Type.Optional(Type.String({
            description: 'Send mode — target peer session_id. Mutually exclusive with `spawn`.',
        })),
        spawn: Type.Optional(Type.Object({
            agent_name: Type.String({
                description: 'Display name of the agent for the new subordinate session. Resolved by archon-server (single lookup, no fallback).',
            }),
            title: Type.Optional(Type.String({
                description: 'Optional short title for the new session (shown in listings).',
            })),
        }, {
            description: 'Spawn mode — open a fresh Branch session under the current session. Mutually exclusive with `to_session`.',
        })),
        content: Type.String({
            description: 'Message body. In send mode this is delivered to `to_session`. In spawn mode this becomes the first user message of the new session.',
        }),
    }),
};
let CloudCommunicateTool = (() => {
    let _classDecorators = [bindTool(CommunicateToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var CloudCommunicateTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            CloudCommunicateTool = _classThis = _classDescriptor.value;
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
            // Mode discrimination: exactly one of to_session / spawn.
            const hasSend = typeof input.to_session === 'string' && input.to_session.length > 0;
            const hasSpawn = !!input.spawn;
            if (hasSend && hasSpawn) {
                return localFailure('Invalid request: provide exactly one of `to_session` (send mode) or `spawn` (spawn mode), not both.');
            }
            if (!hasSend && !hasSpawn) {
                return localFailure('Invalid request: provide either `to_session` (send to a peer) or `spawn` (create a subordinate session).');
            }
            if (!input.content) {
                return localFailure('Invalid request: content is required and must be non-empty.');
            }
            return hasSpawn ? this.executeSpawn(ctx, input, signal) : this.executeSend(ctx, input, signal);
        }
        // ─── Send mode (existing behaviour) ───────────────────────────────────
        async executeSend(ctx, input, signal) {
            const toSession = input.to_session;
            if (toSession === ctx.sessionId) {
                return localFailure(`Invalid request: cannot communicate with self (to_session=${toSession} is the current session).`);
            }
            const resp = await this.archonServer.callRpc('Communicate', {
                communication_info: {
                    from_session: ctx.sessionId,
                    to_session: toSession,
                    command: 'prompt',
                    content: input.content,
                    // caller_chain: cloud-runtime 维护 — step 1 暂未串入,服务端做单跳防 loop
                    // (caller_chain.includes(to_session));完整链路在 step 2 补。
                    caller_chain: [],
                    source: CommunicateSource.ToolCall,
                },
                // archon-server `Communicate` 的 from_session 真值源,handler 用本字段
                // 覆盖 communication_info.from_session 做 ownership 校验防伪造。
                session_id: ctx.sessionId,
            }, signal);
            if (!resp.ok) {
                return {
                    tool_name: CommunicateToolDef.name,
                    text: resp.message,
                    content: [{ type: 'text', text: resp.message }],
                    details: {
                        ok: false,
                        mode: 'send',
                        to_session: toSession,
                        error_code: resp.error_code,
                        details_json: resp.details_json,
                    },
                };
            }
            return {
                tool_name: CommunicateToolDef.name,
                text: resp.message,
                content: [{ type: 'text', text: resp.message }],
                details: {
                    ok: true,
                    mode: 'send',
                    to_session: toSession,
                    details_json: resp.details_json,
                },
            };
        }
        // ─── Spawn mode ────────────────────────────────────────────────────────
        async executeSpawn(ctx, input, signal) {
            const spawn = input.spawn;
            // trim 尾空格再校验非空 —— LLM 拼 agent_name 时常带 trailing space,原值
            // 直接下发 archon-server,要么 lookup miss 报"agent not found",要么命中
            // 一个 `'foo '` 形态的 agent(跟 `'foo'` 不是同一行)。两种结局都是
            // 错名,先 trim 一次做"宽容输入"。leading space 一并清掉,因为同理。
            const agentName = spawn.agent_name.trim();
            if (!agentName) {
                return localFailure('Invalid request: spawn.agent_name is required and must be non-empty.');
            }
            const resp = await this.archonServer.callRpc('Communicate', {
                communication_info: {
                    from_session: ctx.sessionId,
                    to_session: '', // unused on spawn — handleSpawn ignores it
                    command: 'spawn',
                    content: '', // unused on spawn — initial_prompt lives in spawn_config
                    caller_chain: [],
                    source: CommunicateSource.ToolCall,
                },
                spawn_config: {
                    agent_name: agentName,
                    initial_prompt: input.content,
                    ...(spawn.title ? { title: spawn.title } : {}),
                },
                // archon-server `Communicate` 的 from_session 真值源(防 caller 伪造)。
                session_id: ctx.sessionId,
            }, signal);
            return mapSpawnResp(resp);
        }
    };
    return CloudCommunicateTool = _classThis;
})();
export { CloudCommunicateTool };
// ─── Helpers ─────────────────────────────────────────────────────────────
/**
 * Project archon-server's three-state CommunicateResp into a shape the LLM
 * can act on without reading wire enums:
 *   - Delivered            → ok:true,  status="spawned",       child_session_id present
 *   - CreateOkPromptFailed → ok:false, status="spawn_partial", retry_hint suggests send-mode retry
 *   - CreateFailed         → ok:false, status="spawn_failed",  retry_hint suggests retry from scratch
 */
function mapSpawnResp(resp) {
    const baseDetails = {
        mode: 'spawn',
        ...(resp.details_json ? { details_json: resp.details_json } : {}),
    };
    if (resp.ok && resp.delivery_status === CommunicateDeliveryStatus.Delivered) {
        const childId = resp.child_session_id ?? '';
        return {
            tool_name: CommunicateToolDef.name,
            text: resp.message || `Spawned subordinate session ${childId} and delivered the task.`,
            content: [{ type: 'text', text: resp.message || `Spawned ${childId}.` }],
            details: {
                ...baseDetails,
                ok: true,
                status: 'spawned',
                child_session_id: childId,
            },
        };
    }
    if (resp.delivery_status === CommunicateDeliveryStatus.CreateOkPromptFailed) {
        const childId = resp.child_session_id ?? '';
        const retryHint = `The subordinate session ${childId} was created but the initial prompt failed to deliver. ` +
            `Retry by calling communicate({ to_session: "${childId}", content: "<your task>" }).`;
        const message = resp.message ? `${resp.message} — ${retryHint}` : retryHint;
        return {
            tool_name: CommunicateToolDef.name,
            text: message,
            content: [{ type: 'text', text: message }],
            details: {
                ...baseDetails,
                ok: false,
                status: 'spawn_partial',
                child_session_id: childId,
                retry_hint: retryHint,
                error_code: resp.error_code,
            },
        };
    }
    // CreateFailed (or any other ok:false / unknown delivery_status with no child)
    const retryHint = 'Spawn failed before the subordinate session was created. Retry the spawn call from scratch.';
    const message = resp.message ? `${resp.message} — ${retryHint}` : retryHint;
    return {
        tool_name: CommunicateToolDef.name,
        text: message,
        content: [{ type: 'text', text: message }],
        details: {
            ...baseDetails,
            ok: false,
            status: 'spawn_failed',
            retry_hint: retryHint,
            error_code: resp.error_code,
        },
    };
}
function localFailure(message) {
    return {
        tool_name: CommunicateToolDef.name,
        text: message,
        content: [{ type: 'text', text: message }],
        details: { ok: false, error_code: 1 /* InvalidRequest */ },
    };
}
//# sourceMappingURL=cloud-communicate.js.map