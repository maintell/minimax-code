/**
 * ModelGateway 适配（§5.4）。
 *
 * 属于 composition 层：领域服务只依赖 `ModelGateway` port，实现由这里注入。
 * 本适配不接触 DB 与文件，只负责「解析合同 → 规范化输入 → 调模型 → 输出形状校验」。
 *
 * 边界（§5.4 契约注释）：模型没有提交权限。这里只做输出形状校验与输出脱敏；
 * 信封校验（字节上限、小节骨架、首行 v2）一律由调用方在落盘前完成。
 */
import { createHash } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { normalizeLLMError, toLLMMetricErrorKind, } from '@mavis/shared/llm-error-classifier';
import { redactMemorySecrets } from '../secret-redactor.js';
import { estimateCaptureTokens } from '../contracts/token-estimate.js';
import { MANAGED_MINIMAX_PROVIDER_ID } from '../../model-system/index.js';
import { createConsolidationWorkdirTools } from './consolidation-workdir-tools.js';
const MAX_CACHED_CONTRACTS = 16;
/** 产物结构版本：3 起抽取与迁移都经提交工具输出，整理经工作目录文件输出。 */
const OUTPUT_SCHEMA_VERSION = 3;
// Leave headroom between the model's generation target and publication limits.
const CONSOLIDATION_PROMPT_BUDGET_RATIO = 0.8;
export class MemoryV2ModelGateway {
    options;
    contracts = new Map();
    constructor(options) {
        this.options = options;
    }
    async resolveContract(kind) {
        const config = this.options.config();
        const basePrompt = await this.options.readPrompt(kind);
        const prompt = kind === 'consolidation'
            ? `${basePrompt}\n\n本机时区（IANA）：${Intl.DateTimeFormat().resolvedOptions().timeZone}\n`
            : basePrompt;
        // 配置指定的记忆模型优先；未配置时回退运行时默认模型(§2.3)。
        const configured = configuredMemoryModel(config);
        const model = await this.options.completion.resolveModel({
            kind,
            reasoningEffort: configuredEffort(kind, config),
            ...(configured ? { modelName: configured } : {}),
        });
        const modelName = model.modelName;
        const reasoningEffort = configuredEffort(kind, config);
        const promptSha256 = sha256(prompt);
        const maxInputTokens = Math.max(1, Math.min(contractInputLimit(kind, config), positiveInteger(model.maxInputTokens, 'model input token limit') -
            singleCallOverheadTokens(kind, prompt)));
        const maxOutputTokens = positiveInteger(model.maxOutputTokens, 'model output token limit');
        // prompt 更新只改变调用快照，不使历史产物失效。格式或协议不兼容时显式提升版本；
        // 执行模型、推理强度与 token 容量仍从下一次调用起生效。
        const canonicalInputVersion = kind === 'consolidation' ? 6 : CAPTURE_CANONICAL_INPUT_VERSION;
        const artifactContract = {
            schemaVersion: 2,
            kind,
            outputSchemaVersion: OUTPUT_SCHEMA_VERSION,
            ...outputToolField(kind),
            ...contractConfigFields(kind, config),
            canonicalInputVersion,
        };
        const contractId = sha256(stableStringify({ ...artifactContract, promptSha256 }));
        const artifactContractId = `${kind}-v${OUTPUT_SCHEMA_VERSION}-input-v${canonicalInputVersion}:${sha256(stableStringify(artifactContract))}`;
        const contract = {
            kind,
            contractId,
            artifactContractId,
            modelName,
            reasoningEffort,
            promptSha256,
            outputSchemaVersion: OUTPUT_SCHEMA_VERSION,
            maxInputTokens,
            maxOutputTokens,
            contextWindow: positiveInteger(model.contextWindow, 'model context window'),
            prompt,
        };
        this.contracts.set(contractId, contract);
        this.trimContracts();
        return contract;
    }
    async capture(input) {
        return this.invoke({
            kind: 'capture',
            contractId: input.contractId,
            callerSignal: input.signal,
            parse: parseCaptureOutput,
            outputTool: CAPTURE_OUTPUT_TOOL,
            buildPayload: () => stableStringify({
                snapshot: input.snapshot,
                forgetRules: input.forgetRules,
                previousDocument: input.previousDocument,
                maxDocBytes: input.maxDocBytes,
            }),
        });
    }
    async consolidateInPlace(input) {
        if (input.signal.aborted)
            return { status: 'failed', reason: 'model-unavailable' };
        const cached = this.contracts.get(input.contractId);
        if (!isMatchingContract(cached, 'consolidation'))
            return { status: 'stale-contract' };
        const current = await this.resolveContract('consolidation');
        if (current.contractId !== input.contractId)
            return { status: 'stale-contract' };
        try {
            const result = await this.options.completion.runToolLoop({
                kind: 'consolidation',
                modelName: cached.modelName,
                reasoningEffort: cached.reasoningEffort,
                systemPrompt: `${cached.prompt}\n\n${CONSOLIDATION_AGENT_HARNESS}`,
                briefing: renderConsolidationBriefing(input),
                tools: createConsolidationWorkdirTools(input.workDir),
                executionMode: 'consolidation-agent',
                maxRequests: input.maxRequests,
                maxOutputTokens: cached.maxOutputTokens,
                signal: input.signal,
            });
            // 循环期间合同变化则本次编辑作废，调用方丢弃工作目录（§5.4）。
            const latest = await this.resolveContract('consolidation');
            if (latest.contractId !== input.contractId)
                return { status: 'stale-contract' };
            if (result.status === 'agent-limit-exceeded') {
                return { status: 'failed', reason: 'agent-limit-exceeded' };
            }
            // 编辑效果以工作目录内容为准；产物校验由 ConsolidationService 读回时执行。
            return { status: 'ok', output: { completed: true } };
        }
        catch (error) {
            const failure = classifyFailure(error);
            // 整理按错误类别决定草稿能否留到下次续跑，环境故障要说明是哪一类。
            return failure.status === 'failed' && failure.reason === 'model-unavailable'
                ? { ...failure, errorKind: llmErrorKind(error) }
                : failure;
        }
    }
    async migrateLegacy(input) {
        return this.invoke({
            kind: 'migration',
            contractId: input.contractId,
            callerSignal: input.signal,
            parse: parseMigrationOutput,
            outputTool: MIGRATION_OUTPUT_TOOL,
            buildPayload: () => stableStringify({
                source: input.source,
                agentName: input.agentName,
                maxDocBytes: input.maxDocBytes,
            }),
        });
    }
    async readQuota(kind) {
        const config = this.options.config();
        const model = await this.options.completion.resolveModel({
            kind,
            modelName: configuredMemoryModel(config),
            reasoningEffort: configuredEffort(kind, config),
        });
        if (!model.managedProvider || !model.modelName.startsWith(`${MANAGED_MINIMAX_PROVIDER_ID}/`)) {
            return { status: 'not-applicable', reason: 'unmanaged-model' };
        }
        return this.options.readSubscriptionQuota
            ? this.options.readSubscriptionQuota(model.modelName)
            : { status: 'unknown', reason: 'quota-reader-unavailable' };
    }
    async invoke(options) {
        const { kind, contractId, callerSignal, parse, buildPayload } = options;
        // 契约的 MemoryModelResult 没有 aborted 分支；调用方取消按 failed 上报,由其自行丢弃。
        if (callerSignal.aborted) {
            return { status: 'failed', reason: 'model-unavailable' };
        }
        const cached = this.contracts.get(contractId);
        if (!isMatchingContract(cached, kind))
            return { status: 'stale-contract' };
        const current = await this.resolveContract(kind);
        if (current.contractId !== contractId)
            return { status: 'stale-contract' };
        try {
            const raw = await this.options.completion.complete({
                kind,
                modelName: cached.modelName,
                reasoningEffort: cached.reasoningEffort,
                systemPrompt: cached.prompt,
                canonicalPayloadJson: buildPayload(),
                maxOutputTokens: cached.maxOutputTokens,
                signal: callerSignal,
                ...(options.outputTool ? { outputTool: options.outputTool } : {}),
            });
            // 调用期间合同变化则本次结果作废,不允许落盘(§5.4)。
            const latest = await this.resolveContract(kind);
            if (latest.contractId !== contractId)
                return { status: 'stale-contract' };
            return { status: 'ok', output: parse(raw) };
        }
        catch (error) {
            return classifyFailure(error);
        }
    }
    trimContracts() {
        while (this.contracts.size > MAX_CACHED_CONTRACTS) {
            const oldest = this.contracts.keys().next().value;
            if (oldest === undefined)
                return;
            this.contracts.delete(oldest);
        }
    }
}
function isMatchingContract(contract, kind) {
    return contract !== undefined && contract.kind === kind;
}
/**
 * 记忆只用一个模型：抽取、整理与迁移共用设置页维护的 consolidationModel；旧配置缺失该字段时
 * 回退 captureModel。两者都未配置时回退运行时默认模型。
 */
function configuredMemoryModel(config) {
    return config.consolidationModel ?? config.captureModel;
}
function configuredEffort(kind, config) {
    return kind === 'consolidation'
        ? config.consolidationReasoningEffort
        : config.captureReasoningEffort;
}
/**
 * 单发调用（抽取与迁移）的系统提示与输出工具定义也占模型输入窗口，合同上限先扣掉这部分，
 * 剩余额度才分给 payload；整理是多轮工具循环，上下文随读取增长，按自身预算约束。
 */
function singleCallOverheadTokens(kind, prompt) {
    if (kind === 'consolidation')
        return 0;
    return estimateCaptureTokens(prompt) + estimateCaptureTokens(JSON.stringify(outputTool(kind)));
}
/** 单发调用一律经工具提交产物；工具定义决定输出结构，因此进入合同。 */
function outputTool(kind) {
    return kind === 'capture' ? CAPTURE_OUTPUT_TOOL : MIGRATION_OUTPUT_TOOL;
}
function outputToolField(kind) {
    return kind === 'consolidation' ? {} : { outputTool: outputTool(kind) };
}
function contractInputLimit(kind, config) {
    if (kind === 'consolidation')
        return config.maxConsolidationInputTokens;
    return config.maxCaptureInputTokens;
}
function contractConfigFields(kind, config) {
    if (kind === 'consolidation') {
        return {
            artifactPromptBudgetRatio: CONSOLIDATION_PROMPT_BUDGET_RATIO,
            maxSelectedSessions: config.maxSelectedSessions,
            maxMemoryMarkdownBytes: config.maxMemoryMarkdownBytes,
            maxSummaryInjectionTokens: config.maxSummaryInjectionTokens,
        };
    }
    return { maxSessionDocBytes: config.maxSessionDocBytes };
}
/**
 * 与会话内容无关的模型服务故障：稍后重发同一请求即可能成功，归为 model-unavailable，
 * 由 Reconciler 停止本批且不消耗该会话的重试次数（§10）。其余类别归为 model-request-failed。
 */
const ENVIRONMENT_FAILURE_KINDS = new Set([
    'abort',
    'timeout',
    'network',
    'server_error',
    'overloaded',
    'credits_exhausted',
    'usage_limit',
    'auth',
    'not_found',
]);
function classifyFailure(error) {
    if (error instanceof SyntaxError || error instanceof InvalidModelOutputError) {
        return { status: 'failed', reason: 'model-invalid-output' };
    }
    const retryAtMs = rateLimitRetryAtMs(error);
    if (retryAtMs !== undefined) {
        return retryAtMs > 0 ? { status: 'rate-limited', retryAtMs } : { status: 'rate-limited' };
    }
    const kind = llmErrorKind(error);
    if (kind === 'rate_limited' || kind === 'tpm_rate_limited')
        return { status: 'rate-limited' };
    return {
        status: 'failed',
        reason: ENVIRONMENT_FAILURE_KINDS.has(kind) ? 'model-unavailable' : 'model-request-failed',
    };
}
function llmErrorKind(error) {
    return toLLMMetricErrorKind(normalizeLLMError({
        raw: error,
        ...(typeof error === 'string' ? { errorMessage: error } : {}),
    }).facts);
}
/** 识别上游限流并取出 retryAtMs;拿不到具体时刻时返回 0 表示「限流但无重试时刻」。 */
function rateLimitRetryAtMs(error) {
    if (typeof error !== 'object' || error === null)
        return undefined;
    const record = error;
    const status = record.status ?? record.statusCode;
    if (status !== 429)
        return undefined;
    const retryAt = record.retryAtMs;
    return typeof retryAt === 'number' && Number.isFinite(retryAt) ? retryAt : 0;
}
class InvalidModelOutputError extends Error {
}
/**
 * 整理 agent 的运行框架说明（§5.6）。追加在整理 prompt 之后：
 * prompt 资产负责整理判断规则，这里只交代工具边界与完成协议。
 */
const CONSOLIDATION_AGENT_HARNESS = [
    '## 运行方式（内部 agent 工作目录）',
    '',
    '你在临时工作目录中执行任务简报指定的 INIT 或 INCREMENTAL 模式。两种模式都通过文件工具写入产物，最终回复正文不承担交付。可用工具：',
    '- `list_files`：列出工作目录中的全部文件。',
    '- `read_file`：按 path 与可选 line_offset 读取最多 200 行，沿 next_line_offset 续读，null 表示末尾。',
    '- `write_file`：整体覆写 MEMORY.md 或 memory_summary.md。',
    '- `edit_file`：把 MEMORY.md 或 memory_summary.md 中唯一出现的 old_string 替换为 new_string，new_string 为空即删除。',
    '- 其余文件只读。',
    '',
    '约定：',
    '1. 先完整读取 `changes.md`；INIT 分段读完本轮全部材料与规则，INCREMENTAL 按变化清单读取相关材料。',
    '2. 直接编辑 `MEMORY.md` 与 `memory_summary.md`；这是本轮唯一需要产出的两个文件。',
    '3. `changes.md`「本轮之外的来源」所列来源不在本轮，它们在 `MEMORY.md` 中的已有条目保持原样，不删除、不改写来源标注；只有该来源遗忘规则（工作目录中的 `<来源>.rules.md`）命中的内容与本轮 note 明确要求遗忘的内容可以移除。',
    '4. INCREMENTAL 用 `edit_file` 只改变化的条目，不要整份重写 MEMORY.md；单次回复的输出有长度上限，超出时其中的工具调用会被截断且不会执行。',
    '5. 编辑完成后结束工具调用，最终回复无格式要求；宿主读取文件校验结果。',
    '6. 模型请求次数与 token 预算有限，避免重复读取同一文件。',
].join('\n');
/** 续跑时附在简报末尾：草稿已含上次完成的修改，只补做还没处理的变化。 */
const RESUMED_CONSOLIDATION_NOTE = '这是一次续跑：上一次整理因模型服务故障中断，工作目录中的 MEMORY.md 与 memory_summary.md 已经包含上次完成的修改。先读 changes.md 与这两份草稿，只处理草稿里还没有体现的变化，不要从头重写。';
/** 首条用户简报：程序合成的变更事实与预算；逐行 diff 在工作目录 changes.md。 */
function renderConsolidationBriefing(input) {
    const { changes } = input;
    const indexBudget = consolidationPromptBudget(input.maxIndexBytes);
    const summaryBudget = consolidationPromptBudget(input.maxSummaryTokens);
    const lines = [
        `本轮 ${input.mode} 整理；通过文件工具维护两份产物：`,
        `- 新增会话文档：${changes.addedSessionIds.length}`,
        `- 更新会话文档：${changes.updatedSessionIds.length}`,
        `- 已退出选集（条目已由程序删除，勿恢复）：${changes.removedSessionIds.length}`,
        `- 产物存在用户权威修改：${changes.artifactsModified ? '是（尊重现有产物内容）' : '否'}`,
        `- 本轮之外来源的遗忘规则有更新：${changes.forgetRuleSourceIds.length}（按 changes.md 标注的 .rules.md 移除命中内容）`,
        '',
        `MEMORY.md 生成目标预算 ${indexBudget} 字节；memory_summary.md 生成目标预算 ${summaryBudget} token，首行必须是 v2。`,
        `- note 变化：新增 ${changes.addedNotePaths.length}，修改 ${changes.updatedNotePaths.length}，移除 ${changes.removedNotePaths.length}。`,
        '请从 changes.md 开始，按 next_line_offset 读完整清单；差异截断时按路径补读。旧 note 按需读取，禁止修改或删除 note 文件。',
    ];
    if (input.resumed)
        lines.push('', RESUMED_CONSOLIDATION_NOTE);
    return lines.join('\n');
}
function consolidationPromptBudget(hardLimit) {
    return Math.max(1, Math.floor(hardLimit * CONSOLIDATION_PROMPT_BUDGET_RATIO));
}
const CAPTURE_OUTPUT_TOOL = {
    name: 'submit_memory_extraction',
    description: '提交本会话的抽取结果。仅调用一次；摘要与原始记忆均为空表示无值得保存的内容。',
    parameters: Type.Object({
        rollout_summary: Type.String({
            description: '会话目标、任务、证据、结果与未完成事项的复盘摘要。',
        }),
        rollout_slug: Type.Union([Type.String(), Type.Null()], {
            description: '简短会话名称，未知时为空或 null。',
        }),
        raw_memory: Type.String({
            description: '可复用的 Markdown 记忆，包含用户偏好、事实与决策或做法与避坑小节。',
        }),
    }, { additionalProperties: false }),
};
/** 三字段均进入现有文档事实源；名称只作正文，镜像路径仍由会话 ID 决定。 */
function parseCaptureOutput(value) {
    if (!Value.Check(CAPTURE_OUTPUT_TOOL.parameters, value)) {
        throw new InvalidModelOutputError('Invalid memory extraction tool arguments');
    }
    const normalize = (text) => redactMemorySecrets(text.replace(/\r\n?/gu, '\n')).content.trim();
    const summary = normalize(value.rollout_summary);
    const memory = normalize(value.raw_memory);
    const slug = normalize(value.rollout_slug ?? '');
    // 原始记忆为空即模型判定无事可记；摘要与名称只是复盘，单独留存对整理没有价值。
    if (!memory)
        return { document: '' };
    if (!summary)
        throw new InvalidModelOutputError('Expected a summary for the raw memory');
    return {
        document: `# ${slug.split('\n')[0] || '会话记忆'}\n\n## 简短名称\n${slug}\n\n## 会话摘要\n${summary}\n\n## 原始记忆\n${memory}`,
    };
}
const MIGRATION_OUTPUT_TOOL = {
    name: 'submit_migrated_memory',
    description: '提交该旧记忆文件迁移后的会话记忆文档。仅调用一次；document 为空表示没有值得迁移的内容。',
    parameters: Type.Object({
        document: Type.String({
            description: '迁移后的 Markdown 会话记忆文档，不含 frontmatter。',
        }),
    }, { additionalProperties: false }),
};
/** 旧记忆迁移返回一份文档字符串；输出侧脱敏与换行归一在此完成。 */
function parseMigrationOutput(value) {
    if (!Value.Check(MIGRATION_OUTPUT_TOOL.parameters, value)) {
        throw new InvalidModelOutputError('Invalid memory migration tool arguments');
    }
    const normalized = value.document.replace(/\r\n?/gu, '\n');
    return { document: redactMemorySecrets(normalized).content };
}
/** 键排序的稳定序列化:相同输入必须产生相同字节(§2.4)。 */
/**
 * 抽取输入投影版本：6 起工具结果按首尾截断，并随输入附带上一版会话记忆文档。
 * 版本进入 contractId，变化后全部会话按新输入重抽一次。
 */
const CAPTURE_CANONICAL_INPUT_VERSION = 6;
function stableStringify(value) {
    return JSON.stringify(sortKeys(value));
}
function sortKeys(value) {
    if (Array.isArray(value))
        return value.map(sortKeys);
    if (typeof value !== 'object' || value === null)
        return value;
    const source = value;
    const sorted = {};
    for (const key of Object.keys(source).sort()) {
        if (source[key] !== undefined)
            sorted[key] = sortKeys(source[key]);
    }
    return sorted;
}
function positiveInteger(value, label) {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Invalid ${label}: ${value}`);
    }
    return value;
}
function sha256(value) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}
//# sourceMappingURL=model-gateway.js.map