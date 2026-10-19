import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
/** 完整本地调试记录；业务调用只观察结果，日志失败独立降级。 */
export class MemoryDiagnostics {
    options;
    context = new AsyncLocalStorage();
    pending = Promise.resolve();
    warned = false;
    constructor(options) {
        this.options = options;
    }
    async run(operation, request, work, newRun = false) {
        const parent = this.context.getStore();
        const run = newRun || !parent ? this.newRun(parent?.run.runId) : parent.run;
        if (!run.enabled)
            return this.context.run({ run }, work);
        const spanId = randomUUID();
        const parentSpanId = newRun ? undefined : parent?.spanId;
        const startedAtMs = this.options.nowMs();
        return this.context.run({ run, spanId }, async () => {
            this.event('operation.started', { operation, request, parentSpanId });
            try {
                const result = await work();
                this.event('operation.completed', {
                    operation,
                    result,
                    durationMs: this.options.nowMs() - startedAtMs,
                });
                return result;
            }
            catch (error) {
                this.event('operation.failed', {
                    operation,
                    error,
                    durationMs: this.options.nowMs() - startedAtMs,
                });
                throw error;
            }
            finally {
                await this.flush();
            }
        });
    }
    event(event, payload) {
        try {
            const current = this.context.getStore();
            const run = current?.run ?? this.newRun();
            if (!run.enabled)
                return undefined;
            const eventId = randomUUID();
            const record = {
                version: 1,
                timestampMs: this.options.nowMs(),
                runId: run.runId,
                parentRunId: run.parentRunId,
                spanId: current?.spanId,
                sequence: ++run.sequence,
                eventId,
                event,
                payload,
            };
            // 调用时固定消息快照，后续模型循环追加 messages 不改变已记录的请求。
            const line = `${JSON.stringify(record, diagnosticJson)}\n`;
            this.pending = this.append(this.pending, run.fileName, line);
            return eventId;
        }
        catch (error) {
            this.warn(error);
            return undefined;
        }
    }
    async flush() {
        await this.pending;
    }
    newRun(parentRunId) {
        const enabled = this.options.enabled();
        if (!enabled)
            return { enabled: false, runId: '', fileName: '', sequence: 0 };
        const runId = randomUUID();
        return {
            enabled,
            runId,
            parentRunId,
            fileName: `${this.options.nowMs()}-${runId}.jsonl`,
            sequence: 0,
        };
    }
    async append(previous, fileName, line) {
        await previous;
        try {
            const dir = join(this.options.dataDir, 'memeory');
            await mkdir(this.options.dataDir, { recursive: true });
            await assertDirectory(this.options.dataDir);
            await mkdir(dir, { recursive: true, mode: 0o700 });
            await assertDirectory(dir);
            const handle = await open(join(dir, fileName), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
            try {
                await handle.writeFile(line, 'utf8');
            }
            finally {
                await handle.close();
            }
        }
        catch (error) {
            this.warn(error);
        }
    }
    warn(error) {
        if (this.warned)
            return;
        this.warned = true;
        process.emitWarning('Memory diagnostic logs could not be written.', {
            code: 'MEMORY_DIAGNOSTICS_WRITE_FAILED',
            detail: `directory=${join(this.options.dataDir, 'memeory')}; error=${error instanceof Error ? error.message : String(error)}`,
        });
    }
}
async function assertDirectory(path) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Unsafe diagnostic directory');
}
function diagnosticJson(_key, value) {
    if (value instanceof Error)
        return {
            name: value.name,
            message: value.message,
            stack: value.stack,
            code: Reflect.get(value, 'code'),
            cause: value.cause,
        };
    if (value instanceof Set)
        return [...value];
    if (value instanceof Map)
        return Object.fromEntries(value);
    if (typeof value === 'bigint')
        return value.toString();
    return value;
}
/** 仅用于 Promise 型 port；代理保持原接收对象和原始返回值，逐方法记录输入与输出。 */
export function traceMemoryPort(trace, name, port) {
    const methods = new Map();
    return new Proxy(port, {
        get(target, key, receiver) {
            const method = Reflect.get(target, key, receiver);
            if (typeof method !== 'function')
                return method;
            if (!methods.has(key))
                methods.set(key, (...args) => trace.run(`${name}.${String(key)}`, args, () => Reflect.apply(method, target, args)));
            return methods.get(key);
        },
    });
}
//# sourceMappingURL=diagnostics.js.map