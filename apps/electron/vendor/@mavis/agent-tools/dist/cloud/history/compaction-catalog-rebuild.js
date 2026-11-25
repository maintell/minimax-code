/**
 * 存量 session compaction catalog 惰性补建。
 *
 * 背景:catalog(`compaction-catalog.jsonl`)是会话分享功能引入的新结构。老路径
 * 的 compaction 只写 pre-compaction snapshot 然后 replace 正史,不写 catalog;
 * 所以存量 session 的历史 snapshot 在 catalog 里没有 entry,分享 cutoff 落在
 * 已压缩区间时 locate 只能 miss。本模块从 OSS snapshots/ 目录反推这些存量
 * snapshot 的 provenance,把补建出的 entry 前插进 catalog。
 *
 * 关键推导规则(同 session compaction 严格串行,时间序 = 因果序):
 * - snapshot 文件名 `YYYYMMDDTHHMMSSmmm-{replacementId}-snapshot` 自带创建时间
 *   与 replacement id;时间戳做 parse↔format 严格 round-trip 校验,解析不了的
 *   对象不是本时间线产物,直接忽略。
 * - snapshot 是 compaction *前* 的完整正史,其 leading compactionSummary 即
 *   该次 compaction 的 previous summary;resulting summary 无法从 snapshot 自身
 *   得到,取"时间上紧邻的下一个 artifact(更新的 snapshot / 已有 entry / 当前
 *   正史头)"观察到的 previous summary —— 串行保证归因唯一。
 * - 孤儿识别:老路径先写 snapshot 再 replace,replace 未执行(进程死亡等)则
 *   snapshot 是孤儿,表现为紧邻下一个 artifact 的 previous summary 与它自己的
 *   previous summary 相同(replacement 未落地,summary 没变)。孤儿跳过 —— 其
 *   内容必然被下一个 artifact 或当前正史头覆盖,跳过无损。且孤儿不消费
 *   expected,连续孤儿场景依然归因正确。
 * - 异常 snapshot(不可读 / 空 / summary 布局非法 / replacement 冲突)设为
 *   链障(chain barrier):比它更老的候选全部跳过,直到遇到已有 catalog entry
 *   用它的 previous summary 重置推导链 —— 宁可少建,绝不伪造 provenance。
 * - 写入用 `replaceCompactionCatalog` 整写:appendCompactionCatalog 的
 *   created_at_ms 单调约束不允许把更老的 entry 追加到已有 entry 之后。
 */
import { createHash } from 'node:crypto';
import { COMPACTION_CATALOG_ENTRY_SCHEMA, } from './compaction-catalog.js';
export async function rebuildLegacyCompactionCatalog(input) {
    const { sessionId, store, currentHead } = input;
    const existing = await store.loadCompactionCatalog(sessionId);
    const allKeys = await store.listCompactionSnapshotKeys(sessionId);
    const cataloguedKeys = new Set(existing.map((entry) => entry.snapshot_key));
    const knownReplacementIds = new Set(existing.map((entry) => entry.replacement_id));
    // ── 枚举 + 解析:未编目且文件名可解析的 snapshot 才是候选 ────────────────
    const candidates = [];
    for (const key of allKeys) {
        if (cataloguedKeys.has(key))
            continue;
        const parsed = parseSnapshotKey(key);
        if (!parsed)
            continue; // 非本时间线产物,忽略
        const candidate = {
            kind: 'candidate',
            snapshotKey: key,
            replacementId: parsed.replacementId,
            createdAtMs: parsed.createdAtMs,
            anomalous: false,
        };
        if (knownReplacementIds.has(parsed.replacementId)) {
            // replacement 已有既存 provenance 却指向另一个 snapshot key —— 异常,设链障。
            candidate.anomalous = true;
            candidates.push(candidate);
            continue;
        }
        knownReplacementIds.add(parsed.replacementId);
        try {
            const messages = await store.readCompactionSnapshot(sessionId, key);
            const first = messages?.[0];
            const last = messages?.at(-1);
            if (!messages || !first || !last) {
                candidate.anomalous = true;
            }
            else {
                candidate.firstMessageId = first.message_id;
                candidate.lastMessageId = last.message_id;
                candidate.previousSummary = extractLeadingSummary(messages);
            }
        }
        catch {
            candidate.anomalous = true;
        }
        candidates.push(candidate);
    }
    if (candidates.length === 0) {
        return { status: 'complete', addedEntries: 0, skippedSnapshots: 0 };
    }
    // ── 时间线:候选 + 已有 entry,按 created_at_ms 升序;同刻候选排前 ────────
    const timeline = [
        ...candidates,
        ...existing.map((entry) => ({
            kind: 'entry',
            createdAtMs: entry.created_at_ms,
            previousSummary: entry.previous_summary_id !== null && entry.previous_summary_sha256 !== null
                ? { messageId: entry.previous_summary_id, sha256: entry.previous_summary_sha256 }
                : null,
        })),
    ].sort((a, b) => {
        if (a.createdAtMs !== b.createdAtMs)
            return a.createdAtMs - b.createdAtMs;
        return rank(a) - rank(b);
    });
    // ── 反向推导:从最新的观察点(当前正史头)往老走 ──────────────────────────
    let expected = null;
    let broken = false;
    try {
        expected = extractLeadingSummary(currentHead);
    }
    catch {
        // 正史头 summary 布局非法:最新观察点不可信,直到遇到已有 entry 前不补建。
        broken = true;
    }
    const rebuiltNewestFirst = [];
    let skippedSnapshots = 0;
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
        const item = timeline[index];
        if (!item)
            continue;
        if (item.kind === 'entry') {
            // 已有 entry 是可信 provenance:用它的 previous summary 重置推导链。
            expected = item.previousSummary;
            broken = false;
            continue;
        }
        if (item.anomalous) {
            skippedSnapshots += 1;
            broken = true;
            continue;
        }
        if (broken) {
            skippedSnapshots += 1;
            continue;
        }
        const own = item.previousSummary ?? null;
        if (summaryEquals(own, expected)) {
            // 紧邻下一个 artifact 的 previous summary 没变 ⟹ 本次 replacement 未落地,
            // 孤儿。跳过且不消费 expected(连续孤儿共享同一个基底)。
            skippedSnapshots += 1;
            continue;
        }
        if (expected === null) {
            // summary 不可能"消失":更新的观察点没有 summary,而本 snapshot 有 ——
            // 时间线矛盾,不伪造 provenance,之后更老的候选全部跳过。
            skippedSnapshots += 1;
            broken = true;
            continue;
        }
        if (item.firstMessageId === undefined || item.lastMessageId === undefined) {
            skippedSnapshots += 1;
            broken = true;
            continue;
        }
        rebuiltNewestFirst.push({
            schema: COMPACTION_CATALOG_ENTRY_SCHEMA,
            session_id: sessionId,
            snapshot_key: item.snapshotKey,
            replacement_id: item.replacementId,
            created_at_ms: item.createdAtMs,
            pre_snapshot_first_message_id: item.firstMessageId,
            pre_snapshot_last_message_id: item.lastMessageId,
            previous_summary_id: own?.messageId ?? null,
            previous_summary_sha256: own?.sha256 ?? null,
            resulting_summary_id: expected.messageId,
            resulting_summary_sha256: expected.sha256,
        });
        expected = own;
    }
    if (rebuiltNewestFirst.length === 0) {
        return { status: 'unchanged', addedEntries: 0, skippedSnapshots };
    }
    const rebuilt = rebuiltNewestFirst.reverse();
    const merged = mergeByCreatedAt(rebuilt, existing);
    await store.replaceCompactionCatalog(sessionId, merged);
    return { status: 'rebuilt', addedEntries: rebuilt.length, skippedSnapshots };
}
/** 同刻排序:候选(更老的产物)排在已有 entry 之前。 */
function rank(item) {
    return item.kind === 'candidate' ? 0 : 1;
}
function summaryEquals(a, b) {
    if (a === null || b === null)
        return a === b;
    return a.messageId === b.messageId && a.sha256 === b.sha256;
}
/**
 * 归并补建 entry 与既有 entry(各自内部已升序)。同 created_at_ms 时补建的
 * 排前 —— 补建 entry 全部来自比既有 entry 更老的时代。
 */
function mergeByCreatedAt(rebuilt, existing) {
    const merged = [];
    let i = 0;
    let j = 0;
    while (i < rebuilt.length || j < existing.length) {
        const a = rebuilt[i];
        const b = existing[j];
        if (a !== undefined && (b === undefined || a.created_at_ms <= b.created_at_ms)) {
            merged.push(a);
            i += 1;
        }
        else if (b !== undefined) {
            merged.push(b);
            j += 1;
        }
    }
    return merged;
}
const SNAPSHOT_ID_PATTERN = /^(\d{8}T\d{9})-(.+)-snapshot$/u;
/**
 * 从 snapshot 对象 key 解析创建时间与 replacement id。
 * 时间戳要求严格 round-trip(parse 后 format 回原串),拒绝 `20261399T...` 之类
 * 位数对但不是合法时刻的串;解析失败返回 null(该对象不是本时间线产物)。
 */
export function parseSnapshotKey(snapshotKey) {
    const name = snapshotKey.slice(snapshotKey.lastIndexOf('/') + 1);
    if (!name.endsWith('.jsonl'))
        return null;
    const snapshotId = name.slice(0, -'.jsonl'.length);
    const match = SNAPSHOT_ID_PATTERN.exec(snapshotId);
    if (!match)
        return null;
    const [, timestamp, replacementId] = match;
    if (!timestamp || !replacementId)
        return null;
    const createdAtMs = Date.UTC(Number(timestamp.slice(0, 4)), Number(timestamp.slice(4, 6)) - 1, Number(timestamp.slice(6, 8)), Number(timestamp.slice(9, 11)), Number(timestamp.slice(11, 13)), Number(timestamp.slice(13, 15)), Number(timestamp.slice(15, 18)));
    if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0)
        return null;
    if (formatSnapshotTimestamp(createdAtMs) !== timestamp)
        return null;
    return { replacementId, createdAtMs };
}
/**
 * 与 context-lifecycle-manager 的 snapshotId 时间戳格式保持一致
 * (`YYYYMMDDTHHMMSSmmm`,UTC 零填充,字典序 = 时间序)。
 * 那边是模块私有函数,这里本地实现并靠 parse↔format round-trip 互验。
 */
export function formatSnapshotTimestamp(ms) {
    const d = new Date(ms);
    const pad = (value, width = 2) => String(value).padStart(width, '0');
    return (`${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
        `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}` +
        `${pad(d.getUTCMilliseconds(), 3)}`);
}
/**
 * 提取正史 / snapshot 的 leading compaction summary。
 * 布局约束与 message-store 的 leadingCompactionSummary 一致:summary 只能出现
 * 在 index 0 且最多一条,summary 文本必须是 string;违反即抛错(调用方按
 * anomalous 处理)。没有 summary 返回 null(尚未 compaction 过的时代)。
 */
function extractLeadingSummary(messages) {
    let summary = null;
    for (let index = 0; index < messages.length; index += 1) {
        const entry = messages[index];
        if (!entry || entry.message.role !== 'compactionSummary')
            continue;
        if (index !== 0 || summary) {
            throw new Error('history contains a non-leading or duplicate compaction summary');
        }
        const text = entry.message.summary;
        if (typeof text !== 'string') {
            throw new Error('compaction summary must contain summary text');
        }
        summary = {
            messageId: entry.message_id,
            sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
        };
    }
    return summary;
}
//# sourceMappingURL=compaction-catalog-rebuild.js.map