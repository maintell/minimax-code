import { listRequestImages, replaceRequestImages, } from '@mavis/agent-core/pi-turn-runner';
import { checkpointImageText } from '@mavis/context-manager';
import { CheckpointCandidateMediaRejectedError, CheckpointCandidateTooLargeError, ContextCompactionError, } from '../contracts.js';
import { buildCheckpointMessage, validateCheckpointGeneration, } from './checkpoint-format.js';
import { buildAllToolResultsCandidate, buildAttachmentFreeCandidate, buildMiddleDeletionCandidate, buildMinimalGenuineQueryCandidate, buildProtectedSkeletonCandidate, buildToolTrimCandidate, } from './history-reduction.js';
import { evaluateToolResultCompactionAdmission, evaluateToolTrimAdmission, } from './tool-trim-admission.js';
export async function compactContext(input) {
    validateInput(input);
    input.signal?.throwIfAborted();
    const instructions = input.instructions?.trim() || undefined;
    const planning = await planCompaction(input, instructions);
    input.signal?.throwIfAborted();
    if (planning.decision)
        return planning.decision;
    const generated = await generateCheckpoint(input, planning.candidate, instructions);
    input.signal?.throwIfAborted();
    const validated = validateCheckpointGeneration(generated.generation, generated.maxOutputTokens);
    const subagents = await captureSubagents(input);
    input.signal?.throwIfAborted();
    const earlierFiles = await resolveEarlierFiles(input);
    input.signal?.throwIfAborted();
    const reminder = input.checkpointReminder?.(input.checkpoint.timestamp);
    let replacementMessages = buildCheckpointReplacement(input, validated.summary, {
        reminder,
        ...earlierFiles,
        ...(subagents ? { subagents } : {}),
    });
    let measurement = await input.measurePair({
        beforeMessages: input.history,
        afterMessages: replacementMessages,
    });
    input.signal?.throwIfAborted();
    assertValidMeasurement(measurement);
    if (subagents && !fitsFinalRequest(measurement, input.limits)) {
        replacementMessages = buildCheckpointReplacement(input, validated.summary, {
            reminder,
            ...earlierFiles,
        });
        measurement = await input.measurePair({
            beforeMessages: input.history,
            afterMessages: replacementMessages,
        });
        input.signal?.throwIfAborted();
        assertValidMeasurement(measurement);
    }
    if (!admitsFinalRequest(input, measurement)) {
        throw new ContextCompactionError('POST_ADMISSION_FAILED', 'post_admission', 'Generated checkpoint does not fit the next Provider request.', { diagnostics: postAdmissionDiagnostics(input, measurement) });
    }
    return {
        method: 'llm_checkpoint',
        replacementMessages,
        summary: validated.summary,
        schemaStatus: validated.schemaStatus,
        generationAttempts: generated.attempts,
        ...hmidRecoveryMetadata(generated.hmidOverflowRecovered),
        ...tokenUsageMetadata(generated.tokenUsage),
        measurement,
    };
}
function buildCheckpointReplacement(input, summary, { reminder, subagents, earlierFiles, }) {
    return [
        buildCheckpointMessage(input.history, summary, input.checkpoint.tokensBefore, {
            timestamp: input.checkpoint.timestamp,
            ...(subagents ? { subagents } : {}),
            ...(earlierFiles ? { earlierFiles } : {}),
        }),
        ...(reminder ? [reminder] : []),
    ];
}
/**
 * Tool-result admission may decide the compaction without a checkpoint, unless
 * the user gave instructions or the caller requires a checkpoint; the
 * candidate then only serves as smaller checkpoint input.
 */
async function planCompaction(input, instructions) {
    const directAllowed = !instructions && input.checkpointRequired !== true;
    if (input.allowLegacyToolTrim === false) {
        return directAllowed
            ? await planDirectToolResultCompaction(input, input.toolResultCompactionCandidate)
            : { candidate: input.toolResultCompactionCandidate };
    }
    return directAllowed
        ? await planDirectTrim(input)
        : { candidate: captureToolTrimCandidate(input.history) };
}
async function captureSubagents(input) {
    if (!input.captureSubagents)
        return undefined;
    try {
        const snapshot = await input.captureSubagents();
        return snapshot && snapshot.total > 0 ? snapshot : undefined;
    }
    catch {
        try {
            input.onSubagentCaptureFailure?.();
        }
        catch {
            // Diagnostics are best effort and cannot change compaction.
        }
        return undefined;
    }
}
async function resolveEarlierFiles(input) {
    try {
        const earlierFiles = await input.resolveEarlierFiles?.();
        return earlierFiles ? { earlierFiles } : {};
    }
    catch {
        return {};
    }
}
async function planDirectToolResultCompaction(input, candidate) {
    if (!candidate)
        return {};
    const admission = await evaluateToolResultCompactionAdmission({
        h0: input.history,
        candidate,
        limits: input.limits,
        measurePair: input.measurePair,
    });
    if (!admission.admitted)
        return { candidate };
    if ('archivedResultCount' in candidate) {
        return {
            candidate,
            decision: {
                method: 'tool_archive',
                replacementMessages: candidate.messages,
                archivedResultCount: candidate.archivedResultCount,
                measurement: admission.measurement,
            },
        };
    }
    return {
        candidate,
        decision: {
            method: 'tool_trim',
            replacementMessages: candidate.messages,
            trimmedResultCount: candidate.trimmedResultCount,
            measurement: admission.measurement,
        },
    };
}
async function planDirectTrim(input) {
    const candidate = captureToolTrimCandidate(input.history);
    const admission = await evaluateToolTrimAdmission({
        h0: input.history,
        candidate,
        limits: input.limits,
        measurePair: input.measurePair,
    });
    if (!admission.admitted)
        return { candidate };
    return {
        candidate,
        decision: {
            method: 'tool_trim',
            replacementMessages: candidate.messages,
            trimmedResultCount: candidate.trimmedResultCount,
            measurement: admission.measurement,
        },
    };
}
/**
 * Provider-level checkpoint failures (`stopReason === "error"`) get exactly one
 * bounded in-place retry of the same candidate, keeping the invocation's
 * incremental attempt numbering and never re-sending earlier candidates that
 * already overflowed. A second failure surfaces as CHECKPOINT_PROVIDER_FAILED
 * so callers can attribute the failure to the Provider instead of the
 * checkpoint content. A typed overflow thrown by the retry propagates to the
 * caller's normal candidate progression.
 */
async function generateCandidateWithProviderRetry({ input, session, candidate, counter, messages, instructions, }) {
    counter.value += 1;
    const first = await generateCheckpointAttempt({
        input,
        session,
        candidate,
        attemptNumber: counter.value,
        messages,
        instructions,
    });
    if (first.stopReason !== 'error')
        return { generation: first, attemptNumber: counter.value };
    input.signal?.throwIfAborted();
    counter.value += 1;
    const second = await generateCheckpointAttempt({
        input,
        session,
        candidate,
        attemptNumber: counter.value,
        messages,
        instructions,
    });
    if (second.stopReason !== 'error')
        return { generation: second, attemptNumber: counter.value };
    throw new ContextCompactionError('CHECKPOINT_PROVIDER_FAILED', 'llm_checkpoint', 'Checkpoint Provider request failed after one retry.');
}
async function generateCheckpoint(input, candidate, instructions) {
    const session = await input.checkpoint.open();
    validateNonNegativeSafeInteger(session.maxOutputTokens, 'maxOutputTokens');
    const describeImages = checkpointImageDescriber(input);
    const history = await describeImages(input.history);
    const described = candidate
        ? { ...candidate, messages: await describeImages(candidate.messages) }
        : undefined;
    const { checkpointCandidates, hall } = buildCheckpointCandidates(history, described);
    const counter = { value: 0 };
    let overflow;
    for (const checkpointCandidate of checkpointCandidates) {
        input.signal?.throwIfAborted();
        if (!session.fits(checkpointRequest(input, checkpointCandidate.messages, instructions))) {
            continue;
        }
        try {
            const settled = await generateCandidateWithProviderRetry({
                input,
                session,
                candidate: checkpointCandidate.candidate,
                counter,
                messages: checkpointCandidate.messages,
                instructions,
            });
            return {
                generation: settled.generation,
                attempts: settled.attemptNumber,
                maxOutputTokens: session.maxOutputTokens,
                ...tokenUsageMetadata(input.checkpoint.getTokenUsage?.()),
            };
        }
        catch (cause) {
            if (cause instanceof CheckpointCandidateMediaRejectedError) {
                return recoverAfterMediaRejection({
                    input,
                    session,
                    rejectedMessages: checkpointCandidate.messages,
                    hallMessages: hall.messages,
                    // Hall differs from the rejected candidate only when it cleared tool
                    // results and was not itself the rejected candidate.
                    hallIsDistinct: hall.trimmedResultCount > 0 && checkpointCandidate.messages !== hall.messages,
                    instructions,
                    counter,
                    priorOverflow: overflow,
                    cause,
                });
            }
            if (!(cause instanceof CheckpointCandidateTooLargeError))
                throw cause;
            overflow = cause;
        }
    }
    return recoverAfterHall({
        input,
        session,
        hallMessages: hall.messages,
        instructions,
        counter,
        priorOverflow: overflow,
    });
}
/**
 * The summary request carries every image as a line naming its file, saving
 * the ones history names no file for; an image's file is saved once even when
 * several candidates carry it.
 */
function checkpointImageDescriber(input) {
    const files = new Map();
    const fileOf = (messages, image) => {
        if (image.path || !input.writeImageFile)
            return Promise.resolve(image.path);
        const block = messages[image.messageIndex].content?.[image.blockIndex];
        const data = block?.data;
        let file = files.get(data);
        if (!file) {
            file = input.writeImageFile(messages, image);
            files.set(data, file);
        }
        return file;
    };
    return async (messages) => {
        const images = listRequestImages(messages).filter((image) => !image.mimeType?.toLowerCase().startsWith('video/'));
        if (images.length === 0)
            return messages;
        const texts = new Map();
        for (const image of images) {
            texts.set(image.key, checkpointImageText(await fileOf(messages, image)));
        }
        return replaceRequestImages(messages, (image) => texts.get(image.key));
    };
}
function buildCheckpointCandidates(history, candidate) {
    const checkpointCandidates = [{ candidate: 'h0', messages: history }];
    if (candidate && toolResultReplacementCount(candidate) > 0) {
        checkpointCandidates.push({ candidate: 'htrim', messages: candidate.messages });
    }
    const hall = buildAllToolResultsCandidate(checkpointCandidates.at(-1)?.messages ?? history);
    if (hall.trimmedResultCount > 0) {
        checkpointCandidates.push({ candidate: 'hall', messages: hall.messages });
    }
    return { checkpointCandidates, hall };
}
/**
 * The Provider refused a candidate for the images it carries. Every candidate
 * before the attachment-free one keeps those images, so skip straight to the
 * same history with media replaced by text; if that still overflows, continue
 * down the regular attachment-free ladder (Hvideo, Hmid, Hmin) from Hall.
 * Without this, /compact on a session over the provider's image limit failed
 * with the same rejection the session itself was stuck on (#425).
 */
async function recoverAfterMediaRejection({ input, session, rejectedMessages, hallMessages, hallIsDistinct, instructions, counter, priorOverflow, cause, }) {
    input.signal?.throwIfAborted();
    const attachmentFree = buildAttachmentFreeCandidate(rejectedMessages);
    if (attachmentFree.replacedBlockCount === 0)
        throw mediaRejectedProviderFailure(cause);
    let overflow = priorOverflow;
    let attachmentFreeAttempted = false;
    try {
        if (session.fits(checkpointRequest(input, attachmentFree.messages, instructions))) {
            attachmentFreeAttempted = true;
            const attempt = await tryAttachmentFreeCheckpoint({
                input,
                session,
                messages: attachmentFree.messages,
                instructions,
                counter,
            });
            if ('generation' in attempt)
                return attempt;
            overflow = attempt.overflow;
        }
        return await recoverAfterHall({
            input,
            session,
            hallMessages,
            instructions,
            counter,
            priorOverflow: overflow,
            // Do not send the same attachment-free history twice.
            skipHvideo: attachmentFreeAttempted && !hallIsDistinct,
        });
    }
    catch (next) {
        if (next instanceof CheckpointCandidateMediaRejectedError) {
            throw mediaRejectedProviderFailure(next);
        }
        throw next;
    }
}
async function tryAttachmentFreeCheckpoint({ input, session, messages, instructions, counter, }) {
    try {
        const settled = await generateCandidateWithProviderRetry({
            input,
            session,
            candidate: 'hvideo',
            counter,
            messages,
            instructions,
        });
        return {
            generation: settled.generation,
            attempts: settled.attemptNumber,
            maxOutputTokens: session.maxOutputTokens,
            ...tokenUsageMetadata(input.checkpoint.getTokenUsage?.()),
        };
    }
    catch (next) {
        if (!(next instanceof CheckpointCandidateTooLargeError))
            throw next;
        return { overflow: next };
    }
}
function mediaRejectedProviderFailure(cause) {
    return new ContextCompactionError('CHECKPOINT_PROVIDER_FAILED', 'llm_checkpoint', 'Checkpoint Provider rejected the request for carrying too many images.', { cause });
}
function toolResultReplacementCount(candidate) {
    return 'archivedResultCount' in candidate
        ? candidate.archivedResultCount
        : candidate.trimmedResultCount;
}
async function recoverAfterHall({ input, session, hallMessages, instructions, counter, priorOverflow, skipHvideo = false, }) {
    input.signal?.throwIfAborted();
    const hvideo = buildAttachmentFreeCandidate(hallMessages);
    let overflow = priorOverflow;
    if (!skipHvideo &&
        hvideo.replacedBlockCount > 0 &&
        session.fits(checkpointRequest(input, hvideo.messages, instructions))) {
        input.signal?.throwIfAborted();
        try {
            const settled = await generateCandidateWithProviderRetry({
                input,
                session,
                candidate: 'hvideo',
                counter,
                messages: hvideo.messages,
                instructions,
            });
            return {
                generation: settled.generation,
                attempts: settled.attemptNumber,
                maxOutputTokens: session.maxOutputTokens,
                ...tokenUsageMetadata(input.checkpoint.getTokenUsage?.()),
            };
        }
        catch (cause) {
            if (!(cause instanceof CheckpointCandidateTooLargeError))
                throw cause;
            overflow = cause;
        }
    }
    const hmid = buildMiddleDeletionCandidate(hvideo.messages, (messages) => session.fits(checkpointRequest(input, messages, instructions)));
    if (!hmid) {
        // No middle-deletion combination fits locally, including the protected
        // skeleton. Hmin stays the last resort instead of failing closed here.
        return generateHminCheckpoint({
            input,
            session,
            attachmentFreeMessages: hvideo.messages,
            instructions,
            counter,
            overflow,
        });
    }
    input.signal?.throwIfAborted();
    try {
        const settled = await generateCandidateWithProviderRetry({
            input,
            session,
            candidate: 'hmid',
            counter,
            messages: hmid,
            instructions,
        });
        return {
            generation: settled.generation,
            attempts: settled.attemptNumber,
            maxOutputTokens: session.maxOutputTokens,
            ...tokenUsageMetadata(input.checkpoint.getTokenUsage?.()),
        };
    }
    catch (cause) {
        if (!(cause instanceof CheckpointCandidateTooLargeError))
            throw cause;
        overflow = cause;
    }
    return generateHminCheckpoint({
        input,
        session,
        attachmentFreeMessages: hvideo.messages,
        instructions,
        counter,
        overflow,
    });
}
async function generateHminCheckpoint({ input, session, attachmentFreeMessages, instructions, counter, overflow, }) {
    input.signal?.throwIfAborted();
    const hmin = buildMinimalGenuineQueryCandidate(attachmentFreeMessages);
    if (!hmin || !session.fits(checkpointRequest(input, hmin, instructions))) {
        throw inputTooLarge(overflow, captureSizeDiagnosticsBestEffort({
            input,
            session,
            attachmentFreeMessages,
            instructions,
            hminAvailable: hmin !== undefined,
        }));
    }
    input.signal?.throwIfAborted();
    try {
        const settled = await generateCandidateWithProviderRetry({
            input,
            session,
            candidate: 'hmin',
            counter,
            messages: hmin,
            instructions,
        });
        return {
            generation: settled.generation,
            attempts: settled.attemptNumber,
            maxOutputTokens: session.maxOutputTokens,
            ...(overflow ? { hmidOverflowRecovered: true } : {}),
            ...tokenUsageMetadata(input.checkpoint.getTokenUsage?.()),
        };
    }
    catch (cause) {
        if (cause instanceof CheckpointCandidateTooLargeError) {
            throw inputTooLarge(cause, captureSizeDiagnosticsBestEffort({
                input,
                session,
                attachmentFreeMessages,
                instructions,
                hminAvailable: true,
            }));
        }
        throw cause;
    }
}
function hmidRecoveryMetadata(recovered) {
    return recovered ? { hmidOverflowRecovered: true } : {};
}
function tokenUsageMetadata(tokenUsage) {
    return tokenUsage === undefined ? {} : { tokenUsage };
}
async function generateCheckpointAttempt({ input, session, candidate, attemptNumber, messages, instructions, }) {
    const startedAt = performance.now();
    try {
        const generation = await session.generate(checkpointRequest(input, messages, instructions));
        reportCheckpointAttempt(input, {
            candidate,
            attemptNumber,
            outcome: checkpointAttemptOutcome(generation.stopReason),
            durationMs: Math.max(0, performance.now() - startedAt),
            inputMessageCount: messages.length,
        });
        return generation;
    }
    catch (cause) {
        let outcome = 'failed';
        if (cause instanceof CheckpointCandidateTooLargeError) {
            outcome = cause.reason === 'output_exhausted' ? 'output_exhausted' : 'input_too_large';
        }
        else if (input.signal?.aborted)
            outcome = 'aborted';
        reportCheckpointAttempt(input, {
            candidate,
            attemptNumber,
            outcome,
            durationMs: Math.max(0, performance.now() - startedAt),
            inputMessageCount: messages.length,
        });
        throw cause;
    }
}
function checkpointAttemptOutcome(stopReason) {
    if (stopReason === 'aborted')
        return 'aborted';
    if (stopReason === 'error')
        return 'failed';
    return 'generated';
}
function reportCheckpointAttempt(input, metadata) {
    try {
        input.checkpoint.onAttemptSettled?.(metadata);
    }
    catch {
        // Diagnostics cannot change compaction behavior.
    }
}
function checkpointRequest(input, messages, instructions) {
    return {
        messages,
        ...(instructions ? { instructions } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
    };
}
function captureToolTrimCandidate(history) {
    try {
        return buildToolTrimCandidate(history);
    }
    catch (cause) {
        throw invalidHistory(cause);
    }
}
function validateInput(input) {
    validatePositiveSafeInteger(input.limits.providerInputLimit, 'providerInputLimit');
    if (input.limits.maxSerializedInputBytes !== undefined) {
        validatePositiveSafeInteger(input.limits.maxSerializedInputBytes, 'maxSerializedInputBytes');
    }
    validateNonNegativeSafeInteger(input.checkpoint.tokensBefore, 'tokensBefore');
    if (!Number.isFinite(input.checkpoint.timestamp)) {
        throw new TypeError('Context compaction checkpoint timestamp must be finite.');
    }
}
function assertValidMeasurement(measurement) {
    validateFootprint(measurement.before, 'before');
    validateFootprint(measurement.after, 'after');
}
function validateFootprint(footprint, side) {
    validateNonNegativeSafeInteger(footprint.inputTokens, `${side}.inputTokens`);
    validateNonNegativeSafeInteger(footprint.serializedBytes, `${side}.serializedBytes`);
}
function validateNonNegativeSafeInteger(value, field) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`Context compaction ${field} must be a non-negative safe integer.`);
    }
}
function validatePositiveSafeInteger(value, field) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`Context compaction ${field} must be a positive safe integer.`);
    }
}
function fitsFinalRequest(measurement, limits) {
    return (measurement.after.inputTokens <= limits.providerInputLimit &&
        measurement.after.serializedBytes <=
            (limits.maxSerializedInputBytes ?? measurement.before.serializedBytes));
}
/** The manual caller bypasses the final gate; automatic callers enforce it. */
function admitsFinalRequest(input, measurement) {
    return input.finalAdmission === 'bypass' || fitsFinalRequest(measurement, input.limits);
}
/** Content-free sizing facts for the POST_ADMISSION_FAILED failure log. */
function postAdmissionDiagnostics(input, measurement) {
    return {
        historyMessageCount: input.history.length,
        providerInputLimit: input.limits.providerInputLimit,
        ...(input.limits.maxSerializedInputBytes === undefined
            ? {}
            : { maxSerializedInputBytes: input.limits.maxSerializedInputBytes }),
        beforeInputTokens: measurement.before.inputTokens,
        beforeSerializedBytes: measurement.before.serializedBytes,
        afterInputTokens: measurement.after.inputTokens,
        afterSerializedBytes: measurement.after.serializedBytes,
    };
}
function invalidHistory(cause) {
    return new ContextCompactionError('INVALID_HISTORY', 'tool_trim', 'Context compaction requires a settled canonical ToolRound sequence.', { cause });
}
function inputTooLarge(cause, diagnostics) {
    return new ContextCompactionError('COMPACTION_INPUT_TOO_LARGE', 'llm_checkpoint', 'Context is too large for bounded checkpoint generation.', { cause, ...(diagnostics === undefined ? {} : { diagnostics }) });
}
/**
 * Content-free sizing facts for the COMPACTION_INPUT_TOO_LARGE failure log.
 * Best effort: sizing must never mask or change the original failure.
 */
function captureSizeDiagnosticsBestEffort({ input, session, attachmentFreeMessages, instructions, hminAvailable, }) {
    try {
        const skeleton = buildProtectedSkeletonCandidate(attachmentFreeMessages);
        const measured = session.measure?.(checkpointRequest(input, skeleton, instructions));
        return {
            historyMessageCount: input.history.length,
            protectedMessageCount: skeleton.length,
            ...(measured === undefined
                ? {}
                : {
                    protectedInputTokens: measured.inputTokens,
                    protectedSerializedBytes: measured.serializedBytes,
                }),
            providerInputLimit: input.limits.providerInputLimit,
            ...(input.limits.maxSerializedInputBytes === undefined
                ? {}
                : { maxSerializedInputBytes: input.limits.maxSerializedInputBytes }),
            hminAvailable,
        };
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=compact-context.js.map