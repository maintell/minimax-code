import { DESKTOP_BASH_MAX_OUTPUT_BYTES, DESKTOP_BASH_MAX_PENDING_OUTPUT_BYTES, } from '@mavis/agent-tools/desktop';
const OUTPUT_READ_CHUNK_BYTES = 64 * 1024;
const ERROR_OUTPUT_PREFIX_CHARS = 64 * 1024;
const INITIAL_RECOVERY_RETRY_MS = 100;
const MAX_RECOVERY_RETRY_MS = 5_000;
const MAX_RECOVERY_CHARS = 1024 * 1024;
const TERMINAL_REPAIR_ATTEMPTS = 3;
const TERMINAL_REPAIR_DELAY_MS = 25;
const OUTPUT_PROGRESS_INTERVAL_MS = 1_000;
export class BackgroundBashOutputWriter {
    host;
    ownerSessionId;
    taskId;
    limits;
    outputBytes = 0;
    streamedOutput = false;
    streamedTextForError = '';
    limitError;
    lastOutputRef;
    pendingContent = '';
    retainedBytes = 0;
    pendingBytes = 0;
    writingBytes = 0;
    drainPromise;
    rawOutputAccounting = false;
    persistenceIncomplete = false;
    recoveryOffset = 0;
    recoveryContent = '';
    droppedRecoveryBytes = 0;
    omittedBytes = 0;
    retryTimer;
    retryDelayMs = INITIAL_RECOVERY_RETRY_MS;
    settling = false;
    pendingProgress;
    progressTimer;
    progressWrite;
    constructor(host, ownerSessionId, taskId, limits = {}) {
        this.host = host;
        this.ownerSessionId = ownerSessionId;
        this.taskId = taskId;
        this.limits = limits;
    }
    push = (content, byteLength) => {
        if (byteLength !== undefined)
            this.rawOutputAccounting = true;
        this.outputBytes += byteLength ?? Buffer.byteLength(content, 'utf8');
        if (!content)
            return;
        const contentBytes = Buffer.byteLength(content, 'utf8');
        if (this.limitError) {
            this.omittedBytes += contentBytes;
            return;
        }
        const retained = this.retainWithinBudget(content, contentBytes);
        const retainedBytes = Buffer.byteLength(retained, 'utf8');
        this.streamedOutput = true;
        if (this.streamedTextForError.length < ERROR_OUTPUT_PREFIX_CHARS) {
            this.streamedTextForError += content.slice(0, ERROR_OUTPUT_PREFIX_CHARS - this.streamedTextForError.length);
        }
        if (this.persistenceIncomplete)
            this.queueRecovery(retained);
        else {
            this.pendingContent += retained;
            this.pendingBytes += retainedBytes;
        }
        this.startDrain();
        if (this.limitError)
            this.limits.onLimit?.(this.limitError);
    };
    retainWithinBudget(content, contentBytes) {
        const maxOutputBytes = this.limits.maxOutputBytes ?? DESKTOP_BASH_MAX_OUTPUT_BYTES;
        const maxPendingBytes = this.limits.maxPendingBytes ?? DESKTOP_BASH_MAX_PENDING_OUTPUT_BYTES;
        const outputAvailable = Math.max(0, maxOutputBytes - this.retainedBytes);
        const available = Math.min(outputAvailable, this.persistenceIncomplete
            ? Number.POSITIVE_INFINITY
            : Math.max(0, maxPendingBytes - this.pendingBytes - this.writingBytes));
        const retained = contentBytes > available ? utf8Prefix(content, available) : content;
        const retainedBytes = Buffer.byteLength(retained, 'utf8');
        this.retainedBytes += retainedBytes;
        if (contentBytes > available) {
            this.omittedBytes += contentBytes - retainedBytes;
            const bufferExceeded = available < outputAvailable;
            this.limitError = Object.assign(new Error(`Command stopped: ${bufferExceeded ? 'pending output buffer' : 'captured output'} exceeded ${bufferExceeded ? maxPendingBytes : maxOutputBytes} bytes. Saved output is incomplete.`), { code: 'BASH_OUTPUT_LIMIT' });
        }
        return retained;
    }
    async settleSuccess(result) {
        this.beginSettlement();
        await this.flush();
        if (!this.streamedOutput && !this.rawOutputAccounting) {
            const facts = result.details?.output;
            this.outputBytes = facts?.rawBytes ?? Buffer.byteLength(result.text, 'utf8');
        }
        if (!this.persistenceIncomplete) {
            return this.lastOutputRef ?? (await this.appendTerminalOutput(result.text));
        }
        try {
            return await this.repairPendingOutput();
        }
        catch (error) {
            this.warn('repair', error);
            return this.lastOutputRef;
        }
    }
    async settleFailure(content) {
        this.beginSettlement();
        await this.flush();
        if (this.persistenceIncomplete) {
            try {
                const repaired = await this.repairPendingOutput();
                return (await this.appendTerminalOutput(content)) ?? repaired;
            }
            catch (error) {
                this.warn('repair', error);
                return this.lastOutputRef;
            }
        }
        return this.appendTerminalOutput(content);
    }
    describePersistence(outputRef) {
        return {
            rawBytes: this.outputBytes,
            persistence: !this.persistenceIncomplete && !this.limitError && this.omittedBytes === 0 && outputRef
                ? 'complete'
                : 'incomplete',
            omittedBytes: this.omittedBytes,
        };
    }
    startDrain() {
        // Once the bounded window overflows, defer its omission marker until the
        // executor settles. This freezes the byte count while it is persisted and
        // keeps ambiguous "append succeeded, response failed" retries prefix-safe.
        if (this.drainPromise || this.retryTimer || (!this.settling && this.droppedRecoveryBytes > 0))
            return;
        this.drainPromise = this.drainAndRelease();
    }
    async drainAndRelease() {
        try {
            await this.drain();
        }
        finally {
            this.drainPromise = undefined;
        }
    }
    async repairOrRetry() {
        try {
            const outputRef = await this.repairPendingOutput();
            if (outputRef)
                this.lastOutputRef = outputRef;
            return true;
        }
        catch (error) {
            this.warn('repair', error);
            this.scheduleRetry();
            return false;
        }
    }
    async drain() {
        for (;;) {
            if (this.persistenceIncomplete) {
                if (!this.settling && this.droppedRecoveryBytes > 0)
                    return;
                if (!(await this.repairOrRetry()))
                    return;
                continue;
            }
            if (!this.pendingContent)
                return;
            const content = this.pendingContent;
            this.pendingContent = '';
            this.writingBytes = this.pendingBytes;
            this.pendingBytes = 0;
            const outputRef = await this.tryAppend(content, 'stdout');
            this.writingBytes = 0;
            if (outputRef)
                this.lastOutputRef = outputRef;
            else {
                this.persistenceIncomplete = true;
                this.recoveryOffset = this.lastOutputRef?.offset ?? 0;
                this.queueRecovery(content);
                this.queueRecovery(this.pendingContent);
                this.pendingContent = '';
                this.pendingBytes = 0;
            }
        }
    }
    async flush() {
        this.startDrain();
        await Promise.all([this.drainPromise, this.progressWrite]);
    }
    beginSettlement() {
        this.settling = true;
        if (this.retryTimer)
            clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
        clearTimeout(this.progressTimer);
        this.progressTimer = undefined;
        this.pendingProgress = undefined;
    }
    scheduleProgress(outputRef) {
        if (this.settling)
            return;
        if (outputRef)
            this.pendingProgress = outputRef;
        if (!this.pendingProgress || this.progressTimer || this.progressWrite)
            return;
        this.progressTimer = setTimeout(() => {
            this.progressTimer = undefined;
            const pending = this.pendingProgress;
            this.pendingProgress = undefined;
            if (!pending)
                return;
            this.progressWrite = this.persistProgress(pending);
        }, OUTPUT_PROGRESS_INTERVAL_MS);
        this.progressTimer.unref?.();
    }
    async persistProgress(pending) {
        try {
            await this.host.backgroundTaskService.patch(this.taskId, { outputRef: pending });
        }
        catch (error) {
            this.pendingProgress ??= pending;
            this.warn('save progress', error);
        }
        finally {
            this.progressWrite = undefined;
            this.scheduleProgress();
        }
    }
    scheduleRetry() {
        if (this.settling || this.retryTimer || this.droppedRecoveryBytes > 0)
            return;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            this.startDrain();
        }, this.retryDelayMs);
        this.retryTimer.unref?.();
        this.retryDelayMs = Math.min(this.retryDelayMs * 2, MAX_RECOVERY_RETRY_MS);
    }
    queueRecovery(content) {
        if (!content)
            return;
        const availableChars = this.droppedRecoveryBytes > 0
            ? 0
            : Math.max(0, MAX_RECOVERY_CHARS - this.recoveryContent.length);
        let retained = content.slice(0, availableChars);
        if (retained && isHighSurrogate(retained.charCodeAt(retained.length - 1))) {
            retained = retained.slice(0, -1);
        }
        this.recoveryContent += retained;
        const droppedBytes = Math.max(0, Buffer.byteLength(content, 'utf8') - Buffer.byteLength(retained, 'utf8'));
        this.droppedRecoveryBytes += droppedBytes;
        this.omittedBytes += droppedBytes;
    }
    warn(operation, error) {
        try {
            this.host.matrixLogger?.warn({ sessionId: this.ownerSessionId, turnId: this.taskId }, `Failed to ${operation} background bash output: ${formatError(error)}`);
        }
        catch {
            // Diagnostics must not turn a recoverable persistence failure into a
            // runner failure after the command has already settled.
        }
    }
    async repairPendingOutput() {
        const recoveryContent = this.recoveryContent;
        const droppedRecoveryBytes = this.droppedRecoveryBytes;
        const marker = formatDroppedOutputMarker(droppedRecoveryBytes);
        const markerBytes = Buffer.byteLength(marker, 'utf8');
        const canFitMarker = markerBytes <=
            (this.limits.maxOutputBytes ?? DESKTOP_BASH_MAX_OUTPUT_BYTES) - this.retainedBytes;
        const expectedContent = recoveryContent + (canFitMarker ? marker : '');
        const repaired = await this.repairSuffix(expectedContent);
        this.retainedBytes += canFitMarker ? markerBytes : 0;
        this.recoveryContent = this.recoveryContent.slice(recoveryContent.length);
        this.droppedRecoveryBytes = Math.max(0, this.droppedRecoveryBytes - droppedRecoveryBytes);
        this.lastOutputRef = repaired ?? this.lastOutputRef;
        this.recoveryOffset =
            repaired?.offset ?? this.recoveryOffset + Buffer.byteLength(expectedContent, 'utf8');
        this.persistenceIncomplete = this.recoveryContent.length > 0 || this.droppedRecoveryBytes > 0;
        this.retryDelayMs = INITIAL_RECOVERY_RETRY_MS;
        return this.lastOutputRef;
    }
    async repairSuffix(expectedContent) {
        const persisted = await readAllTaskOutput(this.host, this.taskId, this.recoveryOffset);
        let repaired = persisted.outputRef ?? this.lastOutputRef;
        if (!expectedContent.startsWith(persisted.content)) {
            throw new Error('persisted output is not a prefix of the pending bash output');
        }
        if (persisted.content !== expectedContent) {
            repaired = await this.tryAppend(expectedContent.slice(persisted.content.length), 'final_result');
            if (!repaired) {
                const afterRetry = await readAllTaskOutput(this.host, this.taskId, this.recoveryOffset);
                if (afterRetry.content !== expectedContent) {
                    throw new Error('pending bash output suffix could not be persisted');
                }
                repaired = afterRetry.outputRef ?? this.lastOutputRef;
            }
        }
        return repaired;
    }
    async appendTerminalOutput(originalContent) {
        const available = Math.max(0, (this.limits.maxOutputBytes ?? DESKTOP_BASH_MAX_OUTPUT_BYTES) - this.retainedBytes);
        if (Buffer.byteLength(originalContent, 'utf8') > available)
            return this.lastOutputRef;
        const content = utf8Prefix(originalContent, DESKTOP_BASH_MAX_PENDING_OUTPUT_BYTES);
        if (!content)
            return this.lastOutputRef;
        this.retainedBytes += Buffer.byteLength(content, 'utf8');
        const appended = await this.tryAppend(content, 'final_result');
        if (appended) {
            this.lastOutputRef = appended;
            return appended;
        }
        this.persistenceIncomplete = true;
        this.recoveryOffset = this.lastOutputRef?.offset ?? this.recoveryOffset;
        this.recoveryContent = content;
        this.droppedRecoveryBytes = 0;
        for (let attempt = 0; attempt < TERMINAL_REPAIR_ATTEMPTS; attempt += 1) {
            try {
                return await this.repairPendingOutput();
            }
            catch (error) {
                this.warn('repair terminal', error);
                if (attempt + 1 < TERMINAL_REPAIR_ATTEMPTS) {
                    await delay(TERMINAL_REPAIR_DELAY_MS * 2 ** attempt);
                }
            }
        }
        return this.lastOutputRef;
    }
    async tryAppend(content, stream) {
        try {
            const outputRef = await this.host.backgroundTaskService.appendOutput({
                taskId: this.taskId,
                stream,
                content,
                timestamp: this.host.nowMs(),
            }, { persistProgress: false });
            this.scheduleProgress(outputRef);
            return outputRef;
        }
        catch (error) {
            this.warn('persist', error);
            return undefined;
        }
    }
}
async function readAllTaskOutput(host, taskId, initialOffset = 0) {
    const chunks = [];
    let offset = initialOffset;
    let outputRef;
    for (;;) {
        const read = await host.backgroundTaskService.readOutput(taskId, {
            offset,
            limitBytes: OUTPUT_READ_CHUNK_BYTES,
        });
        chunks.push(read.content);
        outputRef = read.outputRef ?? outputRef;
        const nextOffset = read.nextOffset ?? offset + Buffer.byteLength(read.content, 'utf8');
        if (!read.truncated || nextOffset <= offset)
            return { content: chunks.join(''), outputRef };
        offset = nextOffset;
    }
}
function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}
function formatDroppedOutputMarker(droppedBytes) {
    return droppedBytes > 0
        ? `\n<bash_status>Output persistence was unavailable; omitted ${droppedBytes} bytes.</bash_status>\n`
        : '';
}
function isHighSurrogate(codeUnit) {
    return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}
function utf8Prefix(text, maxBytes) {
    if (Buffer.byteLength(text, 'utf8') <= maxBytes)
        return text;
    const bytes = Buffer.from(text, 'utf8');
    let end = Math.min(bytes.length, maxBytes);
    while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80)
        end--;
    return bytes.subarray(0, end).toString('utf8');
}
async function delay(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=bash-output-writer.js.map