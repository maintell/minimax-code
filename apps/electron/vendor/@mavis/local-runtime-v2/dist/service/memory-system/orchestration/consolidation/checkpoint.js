import { MEMORY_SUMMARY_FILE } from '../../contracts.js';
import { addedSummaryRequestLines } from '../artifact-edit.js';
/** 草稿记录的格式版本；字段含义变化时提升，旧版本的草稿直接丢弃。 */
const CHECKPOINT_VERSION = 1;
/** 同一份草稿最多续跑的次数。续跑期间草稿没有任何改动的那次不计入（例如额度仍未恢复）。 */
const MAX_CHECKPOINT_RESUMES = 5;
/** 草稿最长保留时间，覆盖按周重置的额度。 */
const MAX_CHECKPOINT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * 可以留草稿的模型错误类别：模型调用自身的重试用完后仍失败的环境故障。鉴权失败、找不到模型与
 * 取消不在其中，草稿留着也等不到恢复。
 */
const RESUMABLE_ERROR_KINDS = new Set([
    'usage_limit',
    'credits_exhausted',
    'overloaded',
    'server_error',
    'network',
    'timeout',
]);
const NUMERIC_META_FIELDS = [
    'frozenAtMs',
    'resumeCount',
    'resetEpoch',
    'governanceRevision',
];
/**
 * 这次失败能否留草稿续跑：限流，或额度、余额、过载、5xx、网络、超时这些环境故障，以及本轮自己的
 * 1 小时时限到期。请求预算耗尽、鉴权失败、取消、合同变化与其余失败都不留。
 */
export function isResumableFailure(result, timedOut) {
    if (result.status === 'rate-limited')
        return true;
    if (result.status !== 'failed' || result.reason === 'agent-limit-exceeded')
        return false;
    if (timedOut)
        return true;
    return (result.reason === 'model-unavailable' &&
        result.errorKind !== undefined &&
        RESUMABLE_ERROR_KINDS.has(result.errorKind));
}
/**
 * 冻结之后已发布产物与基线的变化。摘要只多了「## 记忆请求」行（保存 note 时程序直接写入）时返回
 * 这些行，发布时补进草稿；索引、其余基线或摘要别处有任何变化时返回 undefined，草稿作废，
 * 免得覆盖用户手改或治理直编。
 */
export function publishedDrift(round, current) {
    if (current.index !== round.publishedIndex)
        return undefined;
    if (baselineKey(round.job.baseline) !== baselineKey(current.baseline))
        return undefined;
    const baselineLines = summaryDrift(summaryOf(round.job.baseline), summaryOf(current.baseline));
    if (baselineLines === undefined)
        return undefined;
    return summaryDrift(round.publishedSummary, current.summary);
}
function summaryDrift(before, after) {
    if (before === after)
        return [];
    if (before === undefined || after === undefined)
        return undefined;
    return addedSummaryRequestLines(before, after);
}
function summaryOf(baseline) {
    return baseline.find((file) => file.fileName === MEMORY_SUMMARY_FILE)?.content;
}
/** 除摘要外的基线内容；摘要单独按请求行比较。 */
function baselineKey(baseline) {
    return JSON.stringify(baseline
        .filter((file) => file.fileName !== MEMORY_SUMMARY_FILE)
        .map((file) => JSON.stringify([file.fileName, file.content]))
        .sort());
}
function staleReason(meta, scope, nowMs) {
    if (!scope || scope.resetEpoch !== meta.resetEpoch)
        return 'reset';
    if (scope.governanceRevision !== meta.governanceRevision)
        return 'governance';
    if (meta.resumeCount >= MAX_CHECKPOINT_RESUMES)
        return 'resume-limit';
    if (nowMs - meta.frozenAtMs > MAX_CHECKPOINT_AGE_MS)
        return 'expired';
    return undefined;
}
function decodeMeta(text) {
    if (text === undefined)
        return undefined;
    try {
        const value = JSON.parse(text);
        if (value?.version !== CHECKPOINT_VERSION || typeof value.contractId !== 'string')
            return undefined;
        return NUMERIC_META_FIELDS.every((field) => Number.isSafeInteger(value[field]))
            ? value
            : undefined;
    }
    catch {
        return undefined;
    }
}
function decodePayload(text, meta) {
    if (text === undefined)
        return undefined;
    try {
        const value = JSON.parse(text);
        if (typeof value?.inputDigest !== 'string' ||
            typeof value.job !== 'object' ||
            !Array.isArray(value.protectedLines))
            return undefined;
        const stored = value;
        return {
            ...stored,
            protectedLines: new Set(stored.protectedLines),
            frozenAtMs: meta.frozenAtMs,
            resumeCount: meta.resumeCount,
            governanceRevision: meta.governanceRevision,
        };
    }
    catch {
        return undefined;
    }
}
function encode(round) {
    const meta = {
        version: CHECKPOINT_VERSION,
        frozenAtMs: round.frozenAtMs,
        resumeCount: round.resumeCount,
        resetEpoch: round.job.resetEpoch,
        governanceRevision: round.governanceRevision,
        contractId: round.job.contract.contractId,
    };
    const payload = {
        job: round.job,
        inputDigest: round.inputDigest,
        mode: round.mode,
        changes: round.changes,
        protectedLines: [...round.protectedLines],
        kept: round.kept,
        initialIndex: round.initialIndex,
        publishedIndex: round.publishedIndex,
        publishedSummary: round.publishedSummary,
    };
    return { meta: JSON.stringify(meta), payload: JSON.stringify(payload) };
}
/** 草稿的保存、读取、取出与清理；判断规则见本文件开头。 */
export class ConsolidationCheckpoints {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async has(scopeKey) {
        return (await this.deps.fileStore.readConsolidationCheckpoint(scopeKey, 'meta')) !== undefined;
    }
    /**
     * 保存草稿，工作目录随之移走。保存失败返回 false，由调用方照常删除工作目录，下次从头整理。
     */
    async save(round, workDir, failure) {
        const scopeKey = round.job.scopeKey;
        try {
            await this.deps.fileStore.saveConsolidationCheckpoint(scopeKey, workDir, encode(round));
        }
        catch (error) {
            this.event('consolidation.checkpoint-save-failed', { scopeKey, error: String(error) });
            return false;
        }
        this.event('consolidation.checkpoint-saved', {
            scopeKey,
            ...failure,
            frozenAtMs: round.frozenAtMs,
            resumeCount: round.resumeCount,
        });
        return true;
    }
    /** 读出可以续跑的草稿；已经失效或读不出的草稿就地删除并返回 undefined。 */
    async load(scope, contractId) {
        const { fileStore } = this.deps;
        const meta = decodeMeta(await fileStore.readConsolidationCheckpoint(scope.scopeKey, 'meta'));
        if (!meta)
            return this.discard(scope.scopeKey, 'invalid');
        const stale = staleReason(meta, scope, this.deps.nowMs()) ??
            (meta.contractId === contractId ? undefined : 'contract');
        if (stale)
            return this.discard(scope.scopeKey, stale);
        const round = decodePayload(await fileStore.readConsolidationCheckpoint(scope.scopeKey, 'payload'), meta);
        if (!round)
            return this.discard(scope.scopeKey, 'invalid');
        if (publishedDrift(round, await this.published(scope.scopeKey)) === undefined)
            return this.discard(scope.scopeKey, 'artifacts-changed');
        return round;
    }
    /** 取出草稿的工作目录续跑；草稿记录随即删除。 */
    take(scopeKey) {
        return this.deps.fileStore.takeConsolidationCheckpoint(scopeKey);
    }
    async published(scopeKey) {
        return {
            index: await this.deps.fileStore.readMemoryIndex(scopeKey),
            summary: await this.deps.fileStore.readMemorySummary(scopeKey),
            baseline: await this.deps.repository.listBaselineFiles(scopeKey),
        };
    }
    /** 删除已经失效的草稿。只读身份记录，不调用模型；单个 scope 出错不影响其余。 */
    async dropStale() {
        for (const scopeKey of await this.deps.fileStore.listConsolidationCheckpoints()) {
            try {
                const meta = decodeMeta(await this.deps.fileStore.readConsolidationCheckpoint(scopeKey, 'meta'));
                const reason = meta
                    ? staleReason(meta, await this.deps.repository.getScope(scopeKey), this.deps.nowMs())
                    : 'invalid';
                if (reason)
                    await this.discard(scopeKey, reason);
            }
            catch (error) {
                this.event('consolidation.checkpoint-cleanup-failed', { scopeKey, error: String(error) });
            }
        }
    }
    /** 不论是否失效，删除全部草稿；单个 scope 出错不影响其余。 */
    async dropAll(reason) {
        for (const scopeKey of await this.deps.fileStore.listConsolidationCheckpoints()) {
            try {
                await this.discard(scopeKey, reason);
            }
            catch (error) {
                this.event('consolidation.checkpoint-cleanup-failed', { scopeKey, error: String(error) });
            }
        }
    }
    /** 记录一次作废；草稿已经取出时只记事件。 */
    discarded(scopeKey, reason) {
        this.event('consolidation.checkpoint-discarded', { scopeKey, reason });
    }
    async discard(scopeKey, reason) {
        await this.deps.fileStore.deleteConsolidationCheckpoint(scopeKey);
        this.discarded(scopeKey, reason);
        return undefined;
    }
    event(event, payload) {
        this.deps.diagnostics?.event(event, payload);
    }
}
//# sourceMappingURL=checkpoint.js.map