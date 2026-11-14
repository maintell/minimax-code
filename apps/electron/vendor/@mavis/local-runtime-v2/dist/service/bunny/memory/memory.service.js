import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GLOBAL_SCOPE_KEY, MemoryScopeMutationCoordinator } from '../../memory-system/index.js';
import { fileDigest, BunnyMemoryFileStore } from './file-store.js';
import { conversationInputMessage, memoryBriefing, memoryOverLimitNotice, memoryWriteInvalid, } from '../../coordinator-text/index.js';
import { BunnyMemoryChangedError, validateModelChanges } from './validation.js';
import { dateKey, MAX_MEMORY_TOKENS, memoryTokens, overMemoryLimit } from './format.js';
import { BunnyMemorySessionSource } from './session-source.js';
import { createBunnyMemoryWorkdirTools } from './workdir-tools.js';
const DISABLED = { status: 'skipped', reason: 'memory-disabled' };
/** The first retry waits a minute, doubling per failure up to an hour (in memory, per process). */
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 3600_000;
/** Isolated editing and checked publication; never reads platform-global memory. */
export class BunnyMemoryService {
    options;
    store;
    source;
    abort = new AbortController();
    nowMs;
    /** Serializes background jobs only; it is never held by foreground reads or edits. */
    jobs = new MemoryScopeMutationCoordinator();
    /** Runs wait until this time after a model error or a run that failed its checks (spec 3.8). */
    retryAtMs = 0;
    failures = 0;
    constructor(options) {
        this.options = options;
        this.store = options.store;
        this.source = options.source;
        this.nowMs = options.nowMs ?? Date.now;
    }
    /** The memory block of Bunny's system prompt; empty, and `unreadable` told, when it cannot be read. */
    renderBunnyMemory(unreadable) {
        return this.store.renderBunnyMemory(unreadable);
    }
    /**
     * Capture and lint run one at a time. The store lock covers only the snapshot and the
     * checked publication, so the main conversation, remember and settings saves never wait
     * for a background model loop.
     */
    capture(sessionId) {
        if (!this.isEnabled())
            return Promise.resolve(DISABLED);
        return this.exclusive(() => this.reported(() => this.captureAll(sessionId)));
    }
    /**
     * The daily upkeep: once a day, the recorder catches up on every source and the
     * consolidator runs. Before the daily gate opens nothing runs, the recorder included;
     * capture cursors keep the messages until then.
     */
    lint(force = false) {
        if (!this.isEnabled())
            return Promise.resolve(DISABLED);
        return this.exclusive(() => this.reported(async () => {
            if (!force) {
                const { lastLintMs } = await this.store.withLock(() => this.store.lintState());
                if (dateKey(lastLintMs) === dateKey(this.nowMs()) ||
                    this.nowMs() - lastLintMs < 20 * 3600_000)
                    return { status: 'skipped', reason: 'already-linted' };
            }
            const captured = await this.captureAll();
            if (captured.status !== 'ok')
                return captured;
            const files = await this.store.withLock(() => this.store.reconcile());
            return this.edit('lint', files, undefined, () => this.store.markLint());
        }));
    }
    stop() {
        this.abort.abort();
    }
    isEnabled() {
        return this.options.enabled?.() ?? true;
    }
    exclusive(run) {
        return this.jobs.withScopeMutation(GLOBAL_SCOPE_KEY, run);
    }
    /** A run's failure is reported, then thrown on to the caller; a stop is not a failure. */
    async reported(run) {
        try {
            return await run();
        }
        catch (error) {
            if (!this.abort.signal.aborted)
                this.options.warn?.(error);
            throw error;
        }
    }
    /**
     * The next run waits after a model error and after a run that failed its checks, so a bad batch
     * is not rerun on every trigger. A concurrent edit is not a failure of the run: the next one
     * may go at once.
     */
    backOff(retryAtMs = 0) {
        this.retryAtMs = Math.max(retryAtMs, this.nowMs() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(this.failures++, 6)));
    }
    async captureAll(sessionId) {
        const ids = sessionId ? [sessionId] : this.source.candidates().map((row) => row.sessionId);
        for (const id of ids) {
            const result = await this.captureSession(id);
            if (result.status !== 'ok')
                return result;
        }
        return { status: 'ok' };
    }
    async captureSession(id) {
        for (;;) {
            this.abort.signal.throwIfAborted();
            const { files, batch } = await this.store.withLock(async () => {
                const snapshot = await this.store.reconcile();
                return { files: snapshot, batch: this.source.batch(id, snapshot['forgotten.md'] ?? '') };
            });
            if (!batch)
                return { status: 'ok' };
            const advance = () => this.source.advance(id, batch.throughRowId);
            // Only user words are evidence: a batch without new ones advances without a model run.
            if (batch.messages.some((message) => !message.processed && message.role === 'user')) {
                // The cursor moves only together with a successful publication.
                const result = await this.edit('capture', files, batch, advance);
                if (result.status !== 'ok')
                    return result;
            }
            else
                advance();
        }
    }
    async edit(kind, files, batch, onPublished) {
        if (this.retryAtMs > this.nowMs())
            return { status: 'skipped', reason: 'model-backoff' };
        const run = () => this.editWorkDir(kind, files, batch, onPublished);
        const ledger = this.options.ledger;
        let result;
        try {
            result = await (ledger
                ? ledger.run({
                    stage: kind === 'capture' ? 'capture' : 'consolidation',
                    operation: kind === 'capture' ? 'capture' : 'rebuild',
                    sourceRef: `bunny:${batch?.sessionId ?? 'lint'}`,
                }, run)
                : run());
        }
        catch (error) {
            this.failed(error);
            throw error;
        }
        return this.finished(result);
    }
    /** A run that threw: failed checks and model errors back off; a concurrent edit or a stop does not. */
    failed(error) {
        if (!(error instanceof BunnyMemoryChangedError) && !this.abort.signal.aborted)
            this.backOff();
    }
    /** A run that returned: a publication resets the backoff, an unavailable model extends it. */
    finished({ retryAtMs, ...result }) {
        if (result.status === 'ok')
            this.failures = 0;
        else if (result.reason === 'model-unavailable')
            this.backOff(retryAtMs);
        return result;
    }
    /** Runs outside the store lock on a snapshot; publication re-locks and checks the digest. */
    async editWorkDir(kind, files, batch, onPublished) {
        const today = dateKey(this.nowMs());
        const input = workInput(kind, files, this.nowMs(), batch);
        const workDir = await this.store.createWorkDir(input);
        try {
            await this.prepareInputs(workDir, kind, batch);
            const writable = new Set(Object.keys(input).filter((name) => name !== 'forgotten.md'));
            const policy = await this.options.readPrompt('memory-policy.md');
            const format = await this.options.readPrompt('memory-format.md');
            const prompt = (await this.options.readPrompt(`memory-${kind}.md`))
                .replaceAll('{memory_policy}', policy)
                .replaceAll('{memory_format}', format);
            const nextId = await this.store.nextEntryNumber();
            const result = await this.options.model.run({
                kind,
                prompt,
                briefing: memoryBriefing({
                    today,
                    nextEntryNumber: nextId,
                    writable: [...writable],
                    maxMemoryTokens: MAX_MEMORY_TOKENS,
                }),
                tools: createBunnyMemoryWorkdirTools(workDir, writable, {
                    ...(kind === 'lint' ? { source: this.source } : {}),
                    ...(kind === 'lint' && this.options.search ? { search: this.options.search } : {}),
                    check: async (path) => {
                        const written = await readOutput(workDir, writable, input, files);
                        try {
                            validateModelChanges(kind, files, written, { batch, final: false });
                        }
                        catch (error) {
                            return {
                                text: memoryWriteInvalid(path, error instanceof Error ? error.message : String(error)),
                                isError: true,
                            };
                        }
                        if (kind === 'lint' && path === 'MEMORY.md' && overMemoryLimit(written['MEMORY.md']))
                            return {
                                text: memoryOverLimitNotice(path, memoryTokens(written['MEMORY.md']), MAX_MEMORY_TOKENS),
                                isError: false,
                            };
                        return undefined;
                    },
                }),
                signal: this.abort.signal,
            });
            if (result.status !== 'ok')
                return result;
            const next = await readOutput(workDir, writable, input, files);
            validateModelChanges(kind, files, next, { batch });
            if (kind === 'lint')
                pruneDaily(next, this.nowMs());
            this.abort.signal.throwIfAborted();
            // A concurrent user edit changes the digest: publish rejects and the cursor stays put.
            await this.store.withLock(async () => {
                await this.store.publish(next, fileDigest(files));
                await onPublished();
            });
            return { status: 'ok' };
        }
        finally {
            await rm(workDir, { recursive: true, force: true });
        }
    }
    async prepareInputs(workDir, kind, batch) {
        if (kind === 'capture' && this.options.readWorkingState)
            await writeFile(join(workDir, 'working-state.md'), this.options.readWorkingState());
        if (batch)
            await writeFile(join(workDir, 'conversation.md'), batch.messages
                .map((message) => conversationInputMessage({
                sessionId: message.sessionId,
                messageId: message.messageId,
                at: new Date(message.atMs).toISOString(),
                role: message.role,
                processed: message.processed,
                text: message.text,
            }))
                .join('\n'));
        if (kind === 'lint') {
            await writeFile(join(workDir, 'bunny-methods.md'), await this.options.readMethods());
            await writeFile(join(workDir, 'manual-edits.md'), (await this.store.lintState()).manualEdits);
        }
    }
}
function workInput(kind, files, nowMs, batch) {
    const dates = new Set(kind === 'capture'
        ? batch.messages
            .filter((message) => !message.processed)
            .map((message) => dateKey(message.atMs))
        : Object.keys(files)
            .filter((name) => name.startsWith('daily/') && name.slice(6, -3) >= dateKey(nowMs - 30 * 86400_000))
            .map((name) => name.slice(6, -3)));
    dates.add(dateKey(nowMs));
    const input = {
        'MEMORY.md': files['MEMORY.md'],
        'forgotten.md': files['forgotten.md'],
    };
    for (const date of dates)
        input[`daily/${date}.md`] = files[`daily/${date}.md`] ?? `# ${date}\n\n## 记录\n`;
    return input;
}
async function readOutput(workDir, writable, input, files) {
    const next = { ...files };
    for (const name of writable) {
        const text = await readFile(join(workDir, name), 'utf8');
        if (text !== input[name] || files[name] !== undefined)
            next[name] = text;
    }
    return next;
}
function pruneDaily(files, nowMs) {
    const expired = Object.keys(files).filter((name) => name.startsWith('daily/') && name.slice(6, -3) < dateKey(nowMs - 180 * 86400_000));
    for (const name of expired)
        delete files[name];
    if (!expired.length)
        return;
    const today = dateKey(nowMs);
    const name = `daily/${today}.md`;
    files[name] ??= `# ${today}\n\n## 记录\n`;
    if (!files[name].includes('## 整理记录'))
        files[name] += '\n## 整理记录\n';
    files[name] += `- 删除过期 daily：${expired.join('、')}。保留 180 天。\n`;
}
//# sourceMappingURL=memory.service.js.map