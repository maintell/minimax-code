/**
 * Migration copy (MR1) of v1 `channels/attachment-retry.ts`.
 */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
const DEFAULT_BACKOFF_MS = [500, 1500, 5000];
/**
 * 判定一个错误是否"可重试":
 *   - 自定义 `isPermanentError` 命中 → false
 *   - `retryableErrors` 列表非空:任一关键字 (大小写不敏感) 命中
 *     `err.message` 或 `err.code` → true;否则 → false
 *   - `retryableErrors` 未传:HTTP 4xx → false;其余 (5xx、网络、unknown) → true
 */
function isRetryableError(err, opts) {
    if (opts.isPermanentError(err))
        return false;
    if (opts.retryableErrors && opts.retryableErrors.length > 0) {
        return matchesAnyKeyword(err, opts.retryableErrors);
    }
    return !isLikely4xxHttpError(err);
}
function matchesAnyKeyword(err, keywords) {
    const haystacks = [];
    if (err instanceof Error)
        haystacks.push(err.message);
    const code = err?.code;
    if (typeof code === 'string')
        haystacks.push(code);
    const status = err?.status;
    if (typeof status === 'number' || typeof status === 'string')
        haystacks.push(String(status));
    const statusCode = err?.statusCode;
    if (typeof statusCode === 'number' || typeof statusCode === 'string') {
        haystacks.push(String(statusCode));
    }
    for (const kw of keywords) {
        const needle = kw.toLowerCase();
        for (const hay of haystacks) {
            if (hay.toLowerCase().includes(needle))
                return true;
        }
    }
    return false;
}
/**
 * 启发式判断一个错误是否是 HTTP 4xx (业务级失败,不应重试)。仅看
 * `status` / `statusCode` 字段,不解析 message (避免误匹配"5xx in body"
 * 之类的描述)。
 */
function isLikely4xxHttpError(err) {
    const status = readNumericStatus(err);
    if (status === null)
        return false;
    return status >= 400 && status < 500;
}
function readNumericStatus(err) {
    const candidates = [
        err?.status,
        err?.statusCode,
    ];
    for (const c of candidates) {
        if (typeof c === 'number' && Number.isFinite(c) && c >= 100 && c < 1000) {
            return c;
        }
        if (typeof c === 'string') {
            const n = Number(c);
            if (Number.isFinite(n) && n >= 100 && n < 1000)
                return n;
        }
    }
    return null;
}
/**
 * 给定一个返回 Promise 的下载函数,加一层指数退避重试。
 *
 * - `fn` 成功 resolve → 直接返回结果。
 * - `fn` reject → 判断是否可重试:
 *     - 不可重试 → 立刻 throw (最后一次)
 *     - 可重试 & 未到上限 → 退避 `backoffMs[attempt-1]` 后重试
 *     - 可重试 & 已达上限 → 调用 `onDeadLetter` (若提供),然后 throw
 *
 * `onDeadLetter` 抛出的异常**不会**冒泡 (被吞掉 + log),符合
 * "DLQ 自身不能反过来阻塞主流程" 的 fire-and-forget 约束。
 */
export async function withRetry(fn, opts = {}, onDeadLetter) {
    const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
    const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const nowMs = opts.nowMs ?? Date.now;
    const chain = [];
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
            lastErr = err;
            chain.push(toAttemptRecord(err, attempt));
            const nextDelayMs = classifyAttemptFailure({ err, attempt, maxAttempts, backoff, opts });
            opts.onAttemptFailed?.(err, attempt, nextDelayMs);
            if (nextDelayMs === null) {
                // 终态:不可重试 或 已穷尽尝试次数
                await settleDeadLetter({ onDeadLetter, err, attempt, chain, nowMs });
                throw err;
            }
            // 可重试 & 还有尝试:退避后继续
            if (nextDelayMs > 0)
                await sleep(nextDelayMs);
        }
    }
    // 防御性:理论上不可达 (循环要么 return 要么 throw)。保险起见再抛一次。
    // v2 变更: 非 Error 值包一层 Error 以满足 no-throw-literal;此分支本就不可达,
    // 包装只影响防御路径的错误形态,不改变任何可达行为。
    if (lastErr instanceof Error)
        throw lastErr;
    throw new Error(String(lastErr));
}
/** 终态返回 null;可重试返回该次退避毫秒数 (0 表示立即重试)。 */
function classifyAttemptFailure(input) {
    const { err, attempt, maxAttempts, backoff, opts } = input;
    const retryable = isRetryableError(err, {
        retryableErrors: opts.retryableErrors ?? [],
        isPermanentError: opts.isPermanentError ?? (() => false),
    });
    const hasMoreAttempts = attempt < maxAttempts;
    if (!retryable || !hasMoreAttempts)
        return null;
    return backoff[attempt - 1] ?? backoff.at(-1);
}
/** DLQ 回调自身失败,绝不允许阻塞主流程,只 log。 */
async function settleDeadLetter(input) {
    if (!input.onDeadLetter)
        return;
    try {
        await input.onDeadLetter(input.err, input.attempt, input.chain);
    }
    catch (dlqErr) {
        logger.error({ err: dlqErr, attempt: input.attempt, ts: input.nowMs() }, 'Attachment dead-letter callback failed');
    }
}
function toAttemptRecord(err, attempt) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err?.code;
    const status = readNumericStatus(err) ?? undefined;
    return {
        attempt,
        message,
        ...(typeof code === 'string' ? { code } : {}),
        ...(typeof status === 'number' ? { status } : {}),
    };
}
/**
 * 死信队列持久化层。
 *
 * - `record(entry)`:写 `<dataDir>/tmp/im-attachments/dead-letter/{ts}-{platform}-{refKind}.json`。
 *   任何失败 (mkdir / writeFile / JSON.stringify) 都被吞掉并 log,不抛。
 *   这条目录**不**进 `LocalAttachmentCleanup` 扫描 — 失败事件需要长期
 *   留存供排查。
 * - `list(filter)`:倒序返回全部 dead-letter 记录 (新→旧),支持
 *   sessionId / platform / since 三维过滤。
 */
export class LocalDeadLetterStore {
    dataDir;
    nowMs;
    logger;
    constructor(options) {
        this.dataDir =
            typeof options.dataDir === 'function'
                ? options.dataDir
                : () => options.dataDir;
        this.nowMs = options.nowMs ?? Date.now;
        this.logger = options.logger ?? consoleDeadLetterLogger();
    }
    /** 死信队列根目录 — 与 attachment scratch area 同一根,但路径独立。 */
    deadLetterDir() {
        return join(this.dataDir(), 'tmp', 'im-attachments', 'dead-letter');
    }
    /**
     * 写入一条死信记录。**任何失败都不会抛出** (fire-and-forget):
     *   - mkdir 失败 → log error,return
     *   - JSON.stringify 失败 (理论上不会,但循环引用等) → log error,return
     *   - writeFile 失败 (磁盘满 / 权限) → log error,return
     * 这条契约保证 DLQ 自身挂了不会反过来阻塞主消息 dispatch。
     */
    async record(entry) {
        const ts = entry.ts ?? this.nowMs();
        const full = { ...entry, ts };
        const dir = this.deadLetterDir();
        const filename = composeDeadLetterFilename(full);
        const fullPath = join(dir, filename);
        try {
            await mkdir(dir, { recursive: true });
            const json = JSON.stringify(full, null, 2);
            await writeFile(fullPath, json, 'utf8');
        }
        catch (err) {
            this.logger.error(`[attachment-retry] ${ts} failed to persist dead-letter for ${entry.platform}/${entry.refKind} (sessionId=${entry.sessionId}, messageId=${entry.messageId})`, err);
            // best-effort 清理:写失败的 0 字节文件不留下,避免下次扫描困惑
            try {
                await rm(fullPath, { force: true });
            }
            catch {
                /* ignore */
            }
        }
    }
    /**
     * 倒序 (ts desc) 返回所有死信记录。可选按 sessionId / platform / since
     * 过滤。损坏的 JSON 文件被跳过并 log,不抛。
     */
    async list(filter = {}) {
        const dir = this.deadLetterDir();
        let files;
        try {
            const entries = await readdir(dir);
            files = entries.filter((f) => f.endsWith('.json'));
        }
        catch (err) {
            // 目录不存在 → 当作"暂无记录"
            const code = err?.code;
            if (code === 'ENOENT')
                return [];
            this.logger.error(`[attachment-retry] cannot list dead-letter dir ${dir}`, err);
            return [];
        }
        const results = [];
        for (const file of files) {
            const fullPath = join(dir, file);
            try {
                const raw = await (await import('node:fs/promises')).readFile(fullPath, 'utf8');
                const parsed = JSON.parse(raw);
                if (!parsed || typeof parsed !== 'object')
                    continue;
                if (!matchesFilter(parsed, filter))
                    continue;
                results.push(parsed);
            }
            catch (err) {
                this.logger.error(`[attachment-retry] failed to parse dead-letter file ${fullPath}`, err);
            }
        }
        results.sort((a, b) => b.ts - a.ts);
        return results;
    }
}
function matchesFilter(entry, filter) {
    if (filter.sessionId && entry.sessionId !== filter.sessionId)
        return false;
    if (filter.platform && entry.platform !== filter.platform)
        return false;
    if (typeof filter.since === 'number' && entry.ts < filter.since)
        return false;
    return true;
}
function composeDeadLetterFilename(entry) {
    const safeKey = entry.refKey.replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 32) || 'unknown';
    return `${entry.ts}-${entry.platform}-${entry.refKind}-${safeKey}.json`;
}
function consoleDeadLetterLogger() {
    return {
        error: (message, err) => {
            logger.error({ err, message }, 'Attachment dead-letter store failed');
        },
    };
}
// ---------------------------------------------------------------------------
// Downloader-side helpers
// ---------------------------------------------------------------------------
/**
 * 构造"下载成功但希望被记入死信队列"的回调。
 *
 * 包装 `LocalDeadLetterStore.record` + 重试链,把 DLQ entry 的必填字段
 * (platform / sessionId / messageId / refKind / refKey) 提到闭包外,
 * downloader 只需 `const onDead = makeDeadLetterCallback(store, ...)`
 * 然后 `withRetry(fn, retryOpts, onDead)`。
 *
 * 注意:返回的回调会 **吞掉** `record` 自身的错误 (因为 `withRetry` 已经
 * 兜底过一次了),不重复 log。
 */
export function makeDeadLetterCallback(store, meta) {
    if (!store) {
        return () => {
            /* no DLQ configured — silent */
        };
    }
    return async (err, _attempt, chain) => {
        const finalError = err instanceof Error ? err.message : String(err);
        try {
            await store.record({
                ...meta,
                errorChain: chain,
                finalError,
            });
        }
        catch {
            // 写 DLQ 文件失败也不能阻塞:withRetry 的 settleDeadLetter 已兜底 log。
        }
    };
}
//# sourceMappingURL=attachment-retry.js.map