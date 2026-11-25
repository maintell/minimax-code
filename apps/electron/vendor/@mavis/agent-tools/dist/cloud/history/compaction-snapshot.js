import { PersistedMessageSchema, keepLeadingHistoryArtifact, } from '../continuation/persisted-message.js';
/**
 * 严格解析 pre-compaction snapshot(jsonl):任何一行不是合法 PersistedMessage
 * 都抛错。snapshot 是只读归档,不像正史那样容错丢行。第一条之后的 `history_artifact`
 * 去掉(同 parsePersistedMessageLines),不抛错。
 */
export function parseStrictPersistedJsonl(body, key) {
    const messages = [];
    for (const [lineIndex, raw] of utf8Lines(body)) {
        if (raw.trim() === '')
            continue;
        let value;
        try {
            value = JSON.parse(raw);
        }
        catch (error) {
            throw new Error(`snapshot ${key} line ${lineIndex + 1} is invalid JSON: ${errorMessage(error)}`);
        }
        const parsed = PersistedMessageSchema.safeParse(value);
        if (!parsed.success) {
            throw new Error(`snapshot ${key} line ${lineIndex + 1} is invalid: ${parsed.error.message}`);
        }
        messages.push(keepLeadingHistoryArtifact(parsed.data, messages.length));
    }
    return messages;
}
/**
 * 宽松解析 pre-compaction snapshot:不合法的行跳过并记入 `skipped`,不抛错。合法行的处理同
 * {@link parseStrictPersistedJsonl}。`skipped` 只有行号、类别与字段路径,不含行内容。
 *
 * 没有复用 `parsePersistedMessageLineSequence`:这里要每行的原始 JSON(核对 catalog)与首个 issue 的
 * 字段路径,那份的回调只给行号和带 zod 原文的说明。坏行的判定(PersistedMessageSchema 与
 * keepLeadingHistoryArtifact)三份解析共用;与严格版一样不 trim,合法行的结果与严格解析相同。
 */
export function parseLenientPersistedJsonl(body) {
    const messages = [];
    const raw = [];
    // 最近一条没进 raw 的原始行;解析完时它若还在,就是最后一行。
    let tail;
    const skipped = [];
    for (const [lineIndex, text] of utf8Lines(body)) {
        if (text.trim() === '')
            continue;
        const lineNo = lineIndex + 1;
        let value;
        try {
            value = JSON.parse(text);
        }
        catch {
            skipped.push({ lineNo, kind: 'invalid-json' });
            continue;
        }
        if (isRecord(value)) {
            const line = rawSnapshotLine(value);
            if (raw.length === 0 || line.message['role'] === 'compactionSummary') {
                raw.push(line);
                tail = undefined;
            }
            else {
                tail = line;
            }
        }
        const parsed = PersistedMessageSchema.safeParse(value);
        if (!parsed.success) {
            const path = parsed.error.issues[0]?.path;
            skipped.push({
                lineNo,
                kind: 'invalid-schema',
                ...(path && path.length > 0 ? { field: path.join('.') } : {}),
            });
            continue;
        }
        messages.push(keepLeadingHistoryArtifact(parsed.data, messages.length));
    }
    if (tail)
        raw.push(tail);
    return { messages, raw, skipped };
}
function rawSnapshotLine(value) {
    const messageId = value['message_id'];
    const message = value['message'];
    return {
        message_id: typeof messageId === 'string' ? messageId : '',
        message: isRecord(message) ? message : {},
    };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * 序列化为 jsonl,强制行尾 `\n`(对象存储是裸字节流,没有协议层兜底行尾)。空数组写成一个 `\n`。
 * 逐行编码后拼接字节,与整段文本一次编码的字节相同,但不会生成整份 history 大小的字符串。
 */
export function serializePersistedJsonl(msgs) {
    if (msgs.length === 0)
        return Buffer.from('\n', 'utf8');
    const lines = [];
    for (let index = 0; index < msgs.length; index += 1) {
        // 与 `join` 相同:空位与没有 JSON 形式的值写成空行。
        const line = index in msgs ? JSON.stringify(msgs[index]) : undefined;
        lines.push(Buffer.from(`${line ?? ''}\n`, 'utf8'));
    }
    return Buffer.concat(lines);
}
/**
 * `body.toString('utf8').split('\n')` 的各行及其下标,逐行解码。`\n` 字节不会出现在 UTF-8 多字节序列
 * 内部,逐行解码与整体解码后再切分得到的各行相同,且不会生成整份对象大小的字符串。
 */
function* utf8Lines(body) {
    let start = 0;
    for (let index = 0;; index += 1) {
        const end = body.indexOf(0x0a, start);
        yield [index, body.toString('utf8', start, end === -1 ? body.length : end)];
        if (end === -1)
            return;
        start = end + 1;
    }
}
/**
 * 断言 snapshot key 是 `snapshotPrefix` 的直接子对象 `<id>.jsonl`,且 id 不含
 * 控制字符、不是相对路径标记。不满足即视为越出该 session。
 */
export function assertCompactionSnapshotKey(snapshotPrefix, sessionId, snapshotKey) {
    if (!snapshotKey.startsWith(snapshotPrefix) || !snapshotKey.endsWith('.jsonl')) {
        throw new Error(`snapshot key is outside session ${sessionId}`);
    }
    const snapshotId = snapshotKey.slice(snapshotPrefix.length, -'.jsonl'.length);
    if (!snapshotId || snapshotId.includes('/') || !isSafeSegment(snapshotId)) {
        throw new Error(`snapshot key is outside session ${sessionId}`);
    }
}
function isSafeSegment(value) {
    if (value === '.' || value === '..')
        return false;
    for (let i = 0; i < value.length; i += 1) {
        const code = value.charCodeAt(i);
        if (code <= 0x1f || code === 0x7f || code === 0x2f)
            return false;
    }
    return true;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=compaction-snapshot.js.map