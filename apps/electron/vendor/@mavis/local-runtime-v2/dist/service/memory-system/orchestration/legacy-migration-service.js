import { createHash } from 'node:crypto';
import { GLOBAL_SCOPE_KEY } from '../contracts.js';
import { estimateCaptureTokens } from '../contracts/token-estimate.js';
import { computeOutputDigest, renderSessionMirror, validateDocumentEnvelope, } from './session-doc.js';
// ---------------------------------------------------------------------------
// Synthetic Session ID (§8.3)
// ---------------------------------------------------------------------------
/**
 * Derive a migration synthetic session ID that is safe for file names on
 * both macOS and Windows. Format: `legacy-` + base64url(sha256(agentName + '\0' + sourceFile))[0..22]
 *
 * This avoids `/`, `:`, `\` that would break path safety contracts.
 */
function deriveLegacySessionId(agentName, sourceFile) {
    const hash = createHash('sha256')
        .update(`${agentName}\0${sourceFile}`, 'utf-8')
        .digest('base64url');
    // Take first 22 chars of base64url (≈16 bytes of entropy)
    return `legacy-${hash.slice(0, 22)}`;
}
// ---------------------------------------------------------------------------
// LegacyMigrationService implementation
// ---------------------------------------------------------------------------
/** 只迁移主 Agent 的旧记忆；main 是 mavis 的历史目录名，两处都可能存在。 */
const PRIMARY_AGENT_NAMES = ['mavis', 'main'];
const USER_MEMORY_SOURCE = 'memory/user.md';
/**
 * 单段迁移输入的字节上限。一个旧文件只能迁成一份不超过 maxSessionDocBytes（64KB）的文档，
 * 单次输出也有 token 上限；上百 KB 的 MEMORY.md 整份交给模型只能删内容或被截断。
 * 超过上限的文件按标题切段，每段独立迁移。段边界进入合成会话 ID，调整此值会让已切段的文件重新迁移。
 */
const LEGACY_PART_MAX_BYTES = 24 * 1024;
/** 迁移落点恒为全局作用域，文档 frontmatter 标注来源 agent（§8.3）。 */
export class MemoryLegacyMigrationService {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async listPending() {
        const { record } = await this.deps.onboarding.inspect();
        // 没有进度字段的 migrate 记录来自旧版预览流程，只在接受成功后写入，迁移早已完成；
        // 收尾登记完成说明全部文件都已处理，之后每轮不再读取旧目录。
        if (record?.legacyChoice !== 'migrate' ||
            !record.migratedLegacySessionIds ||
            record.legacyRecallDisabled) {
            return [];
        }
        // 选择迁移之后用户执行过 Reset：Reset 即清空，剩余旧记忆不再迁入。
        if (await this.resetSinceMigrationStarted(record.legacyMigrationResetEpoch))
            return [];
        const migrated = new Set(record.migratedLegacySessionIds);
        const handled = new Set([...migrated, ...(record.abandonedLegacySessionIds ?? [])]);
        const { sources, userMemory } = await this.readSources();
        const userParts = sources.filter((source) => source.userAuthored);
        // 用户资料全部分段迁入后才清空原文件；清空失败或进程中断时，下一轮在这里补做。
        if (userMemory !== undefined && userParts.every((part) => migrated.has(part.sessionId))) {
            await this.deps.fileStore.clearLegacyUserMemory(userMemory);
        }
        const pending = sources.filter((source) => !handled.has(source.sessionId));
        // 收尾独立于逐文件迁移：写配置失败或进程中断时，后续每轮在这里重试，直到登记完成。
        if (pending.length === 0 && !record.legacyRecallDisabled) {
            await this.deps.disableLegacyRecall(PRIMARY_AGENT_NAMES[0]);
            this.deps.onboarding.markLegacyRecallDisabled();
        }
        return pending;
    }
    async abandon(candidate) {
        this.deps.onboarding.markLegacySessionAbandoned(candidate.sessionId);
        await this.finish();
    }
    async migrate(candidate) {
        const config = this.deps.config();
        // 一轮迁移进行中关闭了记忆写入：不再调用模型、写库或清空资料，下次唤醒按当时开关决定。
        if (!config.writeEnabled)
            return { status: 'stale-input' };
        const contract = await this.deps.modelGateway.resolveContract('migration');
        // 纪元在模型调用前固定：调用期间发生 Reset 时提交按 stale-input 作废，不写回 Reset 前的结果。
        const { resetEpoch } = await this.deps.repository.ensureScope(GLOBAL_SCOPE_KEY);
        const input = {
            source: {
                sourceFile: candidate.sourceFile,
                content: candidate.content,
                userAuthored: candidate.userAuthored,
            },
            agentName: candidate.agentName,
            maxDocBytes: config.maxSessionDocBytes,
        };
        // 旧文件是用户已整理过的知识，截断会静默丢内容；超出输入预算的文件整份跳过并如实上报。
        if (estimateCaptureTokens(JSON.stringify(input)) > contract.maxInputTokens) {
            return { status: 'deferred', reason: 'size-limit-exceeded' };
        }
        const modelResult = await this.deps.modelGateway.migrateLegacy({
            ...input,
            contractId: contract.contractId,
            signal: new AbortController().signal,
        });
        if (modelResult.status === 'stale-contract')
            return { status: 'stale-input' };
        if (modelResult.status !== 'ok')
            return { status: 'deferred', reason: failureReason(modelResult) };
        const envelope = validateDocumentEnvelope(modelResult.output.document, config.maxSessionDocBytes);
        if (envelope.status === 'invalid')
            return { status: 'deferred', reason: envelope.reason };
        if (envelope.status === 'ok' && !(await this.commit(candidate, envelope.content, resetEpoch))) {
            return { status: 'stale-input' };
        }
        this.deps.onboarding.markLegacySessionMigrated(candidate.sessionId);
        await this.finish();
        return { status: envelope.status === 'ok' ? 'migrated' : 'empty' };
    }
    /**
     * 最后一个文件处理完毕时立即收尾；清空资料与停用旧召回失败都由下一次 listPending 补做，
     * 不把已经成功的迁移或放弃登记记成失败。
     */
    async finish() {
        try {
            await this.listPending();
        }
        catch {
            // 下一轮重试收尾。
        }
    }
    /** 旧版记录没有起始纪元，按未发生 Reset 处理。 */
    async resetSinceMigrationStarted(startEpoch) {
        if (startEpoch === undefined)
            return false;
        const scope = await this.deps.repository.getScope(GLOBAL_SCOPE_KEY);
        return scope !== undefined && scope.resetEpoch !== startEpoch;
    }
    /** 主 Agent 的旧文件加用户资料副本，大文件已切段；用户资料归属第一个存在旧目录的主 Agent。 */
    async readSources() {
        const sources = [];
        for (const agentName of PRIMARY_AGENT_NAMES) {
            for (const file of await this.deps.fileStore.readLegacyAgentSources(agentName)) {
                sources.push(...candidatesOf(agentName, file.sourceFile, file.content, false));
            }
        }
        const userMemory = await this.deps.fileStore.snapshotLegacyUserMemory();
        if (userMemory !== undefined) {
            const owner = sources[0]?.agentName ?? PRIMARY_AGENT_NAMES[0];
            sources.unshift(...candidatesOf(owner, USER_MEMORY_SOURCE, userMemory, true));
        }
        return { sources, userMemory };
    }
    /** 迁移文档与正常抽取文档同构：单事务提交后物化镜像（§8.4）。返回 false 表示提交前作用域已变化。 */
    async commit(candidate, content, resetEpoch) {
        return this.deps.scopeMutation.withScopeMutation(GLOBAL_SCOPE_KEY, async () => {
            if (!this.deps.config().writeEnabled)
                return false;
            const previous = await this.deps.repository.getSessionState(GLOBAL_SCOPE_KEY, candidate.sessionId);
            const now = this.deps.nowMs();
            const meta = {
                sessionId: candidate.sessionId,
                sourceRevision: candidate.sourceRevision,
                sourceDigest: candidate.sourceRevision,
                capturedAtMs: now,
                agentName: candidate.agentName,
                projectName: undefined,
                workspaceDir: undefined,
            };
            const mirror = renderSessionMirror(meta, content);
            const result = await this.deps.repository.commitCapture({
                ...meta,
                scopeKey: GLOBAL_SCOPE_KEY,
                expectedResetEpoch: resetEpoch,
                expectedSourceRevision: previous?.sourceRevision,
                sessionCreatedAtMs: now,
                captureContractId: 'legacy-migration',
                outputDigest: computeOutputDigest(mirror),
                content,
            });
            if (result === 'stale-input')
                return false;
            try {
                await this.deps.fileStore.writeSessionMemory(GLOBAL_SCOPE_KEY, candidate.sessionId, mirror);
            }
            catch {
                // 镜像由 Reconciler 补物化（§6.4）。
            }
            return true;
        });
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** 一个旧文件对应的待迁项：不超过单段上限时整份一项，否则每段一项，来源标注 `#part-<序号>-of-<总数>`。 */
function candidatesOf(agentName, sourceFile, content, userAuthored) {
    const parts = splitLegacyContent(content);
    if (parts.length <= 1) {
        // 小文件原样一项；大文件只剩一段时（其余是空白）用切好的这一段，保证不超过单段上限。
        return [candidateOf(agentName, sourceFile, parts[0] ?? content, userAuthored)];
    }
    return parts.map((part, index) => candidateOf(agentName, `${sourceFile}#part-${index + 1}-of-${parts.length}`, part, userAuthored));
}
/**
 * 按标题切段：先以 `#` / `##` 标题为界分节，超长的节再按空行分段，再按行，最后按字符；
 * 然后顺序装箱，每段不超过 LEGACY_PART_MAX_BYTES。各段逐字保留原文，只去掉段首尾的空白。
 */
function splitLegacyContent(content) {
    if (utf8Bytes(content) <= LEGACY_PART_MAX_BYTES)
        return [content];
    const parts = [];
    let current = '';
    for (const unit of splitUnits(content, [/(?=^#{1,2}\s)/mu, /(?<=\n[ \t]*\n)/u, /(?<=\n)/u])) {
        if (current && utf8Bytes(current) + utf8Bytes(unit) > LEGACY_PART_MAX_BYTES) {
            parts.push(current);
            current = '';
        }
        current += unit;
    }
    if (current)
        parts.push(current);
    return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}
function splitUnits(text, separators) {
    if (utf8Bytes(text) <= LEGACY_PART_MAX_BYTES)
        return [text];
    const [separator, ...rest] = separators;
    if (!separator)
        return splitByBytes(text);
    return text.split(separator).flatMap((piece) => splitUnits(piece, rest));
}
/** 没有任何换行可切的超长行：按字符装箱，不切断多字节字符。 */
function splitByBytes(text) {
    const chunks = [];
    let current = '';
    for (const char of text) {
        if (current && utf8Bytes(current) + utf8Bytes(char) > LEGACY_PART_MAX_BYTES) {
            chunks.push(current);
            current = '';
        }
        current += char;
    }
    if (current)
        chunks.push(current);
    return chunks;
}
function utf8Bytes(value) {
    return Buffer.byteLength(value, 'utf8');
}
function candidateOf(agentName, sourceFile, content, userAuthored) {
    return {
        sessionId: deriveLegacySessionId(agentName, sourceFile),
        sourceRevision: sha256(content),
        agentName,
        sourceFile,
        content,
        userAuthored,
    };
}
/** 限流按模型服务环境故障处理，由 Reconciler 停止本批且不计次。 */
function failureReason(result) {
    return result.status === 'failed' ? result.reason : 'model-unavailable';
}
function sha256(value) {
    return createHash('sha256').update(value, 'utf-8').digest('base64url');
}
//# sourceMappingURL=legacy-migration-service.js.map