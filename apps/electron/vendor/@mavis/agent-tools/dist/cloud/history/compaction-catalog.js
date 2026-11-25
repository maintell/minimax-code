import { createHash } from 'node:crypto';
import { z } from 'zod';
export const COMPACTION_CATALOG_ENTRY_SCHEMA = 'mavis.session.compaction.catalog.v1';
export const CompactionCatalogEntrySchema = z
    .object({
    schema: z.literal(COMPACTION_CATALOG_ENTRY_SCHEMA),
    session_id: z.string().min(1).max(256),
    snapshot_key: z.string().min(1).max(1_024),
    replacement_id: z.string().min(1).max(256),
    created_at_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    pre_snapshot_first_message_id: z.string().min(1).max(1_024),
    pre_snapshot_last_message_id: z.string().min(1).max(1_024),
    previous_summary_id: z.string().min(1).max(1_024).nullable(),
    previous_summary_sha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .nullable(),
    resulting_summary_id: z.string().min(1).max(1_024),
    resulting_summary_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
})
    .strict()
    .superRefine((entry, ctx) => {
    if ((entry.previous_summary_id === null) !== (entry.previous_summary_sha256 === null)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'previous summary id and hash must both be null or both be present',
        });
    }
});
export function catalogEntryAlreadyExists(entries, next) {
    const existing = entries.find((entry) => entry.replacement_id === next.replacement_id);
    if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(next)) {
            throw new Error(`compaction replacement ${next.replacement_id} already has different provenance`);
        }
        return true;
    }
    const latest = entries.at(-1);
    if (latest && next.created_at_ms < latest.created_at_ms) {
        throw new Error('compaction catalog entry created_at_ms is older than the latest entry');
    }
    return false;
}
/**
 * 解析 `compaction-catalog.jsonl` 正文:逐行 schema 校验、session 归属、
 * snapshot key 归属(由调用方断言)、replacement 唯一、created_at_ms 单调。
 * 任何一行不合法都抛错,catalog 不做容错丢行。
 */
export function parseCompactionCatalog(text, options) {
    const { key, sessionId } = options;
    const entries = [];
    const replacementIds = new Set();
    let previousCreatedAtMs = -1;
    for (const [lineIndex, raw] of text.split('\n').entries()) {
        if (raw.trim() === '')
            continue;
        let value;
        try {
            value = JSON.parse(raw);
        }
        catch (error) {
            throw new Error(`compaction catalog ${key} line ${lineIndex + 1} is invalid JSON: ${errorMessage(error)}`);
        }
        const parsed = CompactionCatalogEntrySchema.safeParse(value);
        if (!parsed.success) {
            throw new Error(`compaction catalog ${key} line ${lineIndex + 1} is invalid: ${parsed.error.message}`);
        }
        const entry = parsed.data;
        if (entry.session_id !== sessionId) {
            throw new Error(`compaction catalog ${key} contains a different session id`);
        }
        options.assertSnapshotKey(entry.snapshot_key);
        if (replacementIds.has(entry.replacement_id)) {
            throw new Error(`compaction catalog ${key} contains duplicate replacement ${entry.replacement_id}`);
        }
        if (entry.created_at_ms < previousCreatedAtMs) {
            throw new Error(`compaction catalog ${key} is not ordered by created_at_ms`);
        }
        replacementIds.add(entry.replacement_id);
        previousCreatedAtMs = entry.created_at_ms;
        entries.push(entry);
    }
    return entries;
}
/**
 * 由压缩前正史(`current`)与替换后正史(`next`)构造 catalog entry。
 * `next` 必须以 compaction summary 开头;summary 只允许出现在 index 0。
 */
export function buildCompactionCatalogEntry(sessionId, snapshotKey, current, next, provenance) {
    if (!provenance.replacementId) {
        throw new Error('compaction provenance replacementId must be non-empty');
    }
    if (!Number.isSafeInteger(provenance.createdAtMs) || provenance.createdAtMs < 0) {
        throw new Error('compaction provenance createdAtMs must be a non-negative safe integer');
    }
    const first = current[0];
    const last = current.at(-1);
    if (!first || !last) {
        throw new Error('pre-compaction snapshot must contain messages');
    }
    const previousSummary = leadingCompactionSummary(current, 'pre-compaction snapshot', false);
    const resultingSummary = leadingCompactionSummary(next, 'replacement history', true);
    if (!resultingSummary) {
        throw new Error('replacement history must start with a compaction summary');
    }
    return {
        schema: COMPACTION_CATALOG_ENTRY_SCHEMA,
        session_id: sessionId,
        snapshot_key: snapshotKey,
        replacement_id: provenance.replacementId,
        created_at_ms: provenance.createdAtMs,
        pre_snapshot_first_message_id: first.message_id,
        pre_snapshot_last_message_id: last.message_id,
        previous_summary_id: previousSummary?.messageId ?? null,
        previous_summary_sha256: previousSummary?.sha256 ?? null,
        resulting_summary_id: resultingSummary.messageId,
        resulting_summary_sha256: resultingSummary.sha256,
    };
}
/**
 * 校验 snapshot 内容与 catalog entry 记录的首尾 id、previous summary 一致。
 * 一致返回 undefined;不一致返回原因(调用方决定包装成何种错误)。
 */
export function compactionSnapshotMismatch(entry, messages) {
    if (messages[0]?.message_id !== entry.pre_snapshot_first_message_id ||
        messages.at(-1)?.message_id !== entry.pre_snapshot_last_message_id) {
        return 'snapshot bounds do not match catalog';
    }
    let summary;
    for (let ordinal = 0; ordinal < messages.length; ordinal += 1) {
        const message = messages[ordinal];
        if (message?.message.role !== 'compactionSummary')
            continue;
        if (ordinal !== 0 || summary) {
            return 'snapshot summary lineage does not match catalog';
        }
        summary = message;
    }
    if ((summary?.message_id ?? null) !== entry.previous_summary_id) {
        return 'snapshot summary lineage does not match catalog';
    }
    const summaryText = summary?.message.summary;
    const summaryHash = typeof summaryText === 'string'
        ? createHash('sha256').update(summaryText, 'utf8').digest('hex')
        : null;
    if (summaryHash !== entry.previous_summary_sha256) {
        return 'snapshot summary lineage does not match catalog';
    }
    return undefined;
}
function leadingCompactionSummary(messages, location, required) {
    let summary;
    for (let index = 0; index < messages.length; index += 1) {
        const entry = messages[index];
        if (!entry || entry.message.role !== 'compactionSummary')
            continue;
        if (index !== 0 || summary) {
            throw new Error(`${location} contains a non-leading or duplicate compaction summary`);
        }
        const text = entry.message.summary;
        if (typeof text !== 'string') {
            throw new Error(`${location} compaction summary must contain summary text`);
        }
        summary = {
            messageId: entry.message_id,
            sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
        };
    }
    if (required && !summary) {
        throw new Error(`${location} must contain a leading compaction summary`);
    }
    return summary;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=compaction-catalog.js.map