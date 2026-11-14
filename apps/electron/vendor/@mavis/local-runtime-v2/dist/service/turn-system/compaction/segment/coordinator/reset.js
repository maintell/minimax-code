import { incrementMetric } from '@mavis/shared/local-runtime-logging/metric-registry';
import { HANDOFF_RESET_NO_SUMMARY, HANDOFF_RESET_UNREAD, handoffResetNote, } from '../../../../coordinator-text/index.js';
import { buildHeaderMessage, renderHandoffHeader } from '../algorithm/handoff-header.js';
import { previewBody } from '../algorithm/retention.js';
import { gatherHeaderMaterial } from '../rebuild-pipeline.js';
import { contextResetPayload, traceContextReset, } from '../trace.js';
/** Product metric of the context reset (context reset spec 7.3); labels are enums only. */
/** Characters of each end an unreplied message's preview keeps. */
const UNREPLIED_PREVIEW_CHARS = 60;
/**
 * The model the header's shares are measured against when no Turn of this
 * process handed one over: the reset makes no model request (4.5).
 */
const REFERENCE_ROUTE = {
    model: {
        id: 'reference',
        name: 'reference',
        api: 'openai-completions',
        provider: 'reference',
        baseUrl: '',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 32_000,
    },
};
/** Error codes of a file that could not be written: a full disk, no permission, a file in use. */
const WRITE_FAILURE_CODES = new Set([
    'ENOSPC',
    'EDQUOT',
    'EACCES',
    'EPERM',
    'EBUSY',
    'EROFS',
    'ETXTBSY',
    'EMFILE',
    'ENFILE',
    'EIO',
    'SQLITE_FULL',
    'SQLITE_READONLY',
    'SQLITE_CANTOPEN',
    'SQLITE_IOERR',
]);
/**
 * The user's context reset of a Bunny main conversation (context reset spec
 * 4 to 7): the active history becomes one handoff header with the reset note,
 * made without a model request; the conversation the user sees gets a
 * separator; the session identifier is replaced and pending background
 * results are voided. Runs under the compaction lease that holds the Session,
 * so no Turn and no other rebuild writes the history meanwhile.
 */
export class SegmentContextReset {
    core;
    background;
    commits;
    emergencies;
    /** The diagnostics record write of each Session's last reset. */
    records = new Map();
    constructor(core, background, commits, emergencies) {
        this.core = core;
        this.background = background;
        this.commits = commits;
        this.emergencies = emergencies;
    }
    async reset(port, input) {
        const { sessionId, turnId } = input;
        const nowMs = this.core.now();
        const current = await settle(() => this.core.ports.history.readSegment(sessionId));
        const records = current?.records ?? [];
        const from = current?.segmentId ?? null;
        const header = await this.composeHeader(port, sessionId, records, nowMs);
        const report = (fields) => this.report(port, input, { ...fields, unreadSections: header.unread });
        const fail = (fields) => ({
            status: 'failed',
            category: report(fields) ?? 'other',
            error: fields.error,
        });
        try {
            await this.emergencies.resetCommitting(sessionId, from);
        }
        catch (error) {
            return fail({ result: 'failed', error, step: 'state' });
        }
        let written;
        try {
            written = await port.resetHistory(sessionId, {
                resetId: resetIdOf(turnId),
                turnId,
                header: header.message,
            });
        }
        catch (error) {
            this.emergencies.resetAbandoned(sessionId);
            return fail({ result: 'failed', error, step: 'history' });
        }
        try {
            await port.writeSeparator(sessionId, { turnId, timestampMs: nowMs });
        }
        catch (error) {
            // The history goes back to the bytes it had: no reset without its separator (5.4).
            await settle(() => port.restoreHistory(sessionId, written.backupFile));
            this.emergencies.resetAbandoned(sessionId);
            return fail({
                result: 'failed',
                error,
                step: 'separator',
                backupFile: written.backupFile,
            });
        }
        await this.afterReset(port, sessionId, turnId);
        const segmentId = await settle(async () => this.commits.startSegment(sessionId, {
            headerLedgerIds: header.ledgerIds,
            prefixLength: 1,
            rebuildReason: 'user_reset',
        }));
        report({
            result: 'completed',
            backupFile: written.backupFile,
            previousSegmentId: from,
            ...(segmentId ? { segmentId } : {}),
        });
        return {
            status: 'completed',
            resetId: resetIdOf(turnId),
            messagesBefore: written.messagesBefore,
            tokensBefore: header.tokensBefore,
            tokensAfter: this.core.counter.countMessages([header.message]),
        };
    }
    /** What follows a committed reset (4.4): no pending result, a fresh baseline and identifier. */
    async afterReset(port, sessionId, turnId) {
        this.background.discardPending(sessionId, 'user_reset', turnId);
        await this.emergencies.resetCommitted(sessionId);
        try {
            port.segmentReset?.(sessionId);
        }
        catch {
            // The next Turn still sends its delta block; a stale baseline only shortens it.
        }
    }
    /**
     * The handoff header of the new segment (4.1, 4.2): the structured
     * sections as a compaction gathers them, no summary, the reset note; a
     * section whose material cannot be read says so (5.3).
     */
    async composeHeader(port, sessionId, records, nowMs) {
        const state = this.core.state(sessionId);
        const route = state.lastRoute ?? REFERENCE_ROUTE;
        const budget = this.core.budget(route, this.core.prefixes.get(sessionId));
        const formatTime = (ms) => this.core.formatTime(ms);
        const counter = this.core.counter;
        const material = await gatherHeaderMaterial(this.core.ports, sessionId, records, {
            nowMs,
            shares: budget.shares,
            counter,
            formatTime,
        });
        const unreplied = await settle(() => port.unrepliedMessages(sessionId));
        const rendered = renderHandoffHeader({
            checkpoint: { sections: [] },
            material,
            shares: budget.shares,
            counter,
            formatTime,
            noSummaryNote: HANDOFF_RESET_NO_SUMMARY,
            noteUnreadable: true,
            unreadText: HANDOFF_RESET_UNREAD,
            resetNote: handoffResetNote({
                resetAt: formatTime(nowMs),
                unreplied: unreplied?.map(unrepliedPreview),
            }),
        });
        const tokensBefore = counter.countMessages(records.map((record) => record.message));
        return {
            message: buildHeaderMessage(rendered.summary, tokensBefore, nowMs),
            ledgerIds: rendered.ledgerShownIds,
            tokensBefore,
            unread: [...(material.unread ?? []), ...(unreplied ? [] : ['unreplied'])],
        };
    }
    /** The trace, diagnostics record and metric of one reset (7.2 to 7.4); never throws. */
    report(port, input, fields) {
        const category = fields.result === 'failed' ? failureCategory(fields.error, fields.step) : undefined;
        const traced = {
            result: fields.result,
            hadRunningTurn: input.hadRunningTurn,
            forcedStop: input.forcedStop,
            affinityRotated: fields.result === 'completed',
            ...(fields.backupFile ? { backupFile: fields.backupFile } : {}),
            unreadSections: fields.unreadSections,
            ...(category ? { failureCategory: category } : {}),
            durationMs: Math.max(0, Math.round(this.core.now() - input.requestedAtMs)),
            ...(fields.result === 'completed'
                ? {
                    previousSegmentId: fields.previousSegmentId,
                    ...(fields.segmentId ? { segmentId: fields.segmentId } : {}),
                }
                : {}),
        };
        const payload = contextResetPayload(input.sessionId, input.turnId, traced);
        traceContextReset(this.core.ports.trace, input.sessionId, input.turnId, payload);
        // Written once; a record that cannot be written is dropped without another report (7.4).
        this.records.set(input.sessionId, appendRecordQuietly(port, input.sessionId, { recorded_at_ms: this.core.now(), ...payload }));
        // Metrics never change the reset: incrementMetric never throws.
        incrementMetric(this.core.ports.metrics, 'bunny_context_reset_total', 1, {
            result: fields.result,
            forced: input.forcedStop ? 'true' : 'false',
        });
        return category;
    }
}
async function appendRecordQuietly(port, sessionId, record) {
    try {
        await port.appendRecord(sessionId, record);
    }
    catch {
        // The trace already carries the same fields; a lost record is not reported again.
    }
}
/** The reset's ID: its snapshot names it, and so does the new segment's header. */
function resetIdOf(turnId) {
    return `reset-${turnId}`;
}
function unrepliedPreview(message) {
    const preview = previewBody(message.text, UNREPLIED_PREVIEW_CHARS).replaceAll(/\s+/gu, ' ');
    return { messageId: message.messageId, preview: preview || '（没有文字）' };
}
/**
 * Only a file that cannot be written, or the main database, fails a reset
 * (5.4). A failed separator is a database write; other errors stay `other`.
 */
function failureCategory(error, step) {
    const code = errorCode(error);
    if (code && WRITE_FAILURE_CODES.has(code))
        return 'write_failed';
    if (step === 'separator')
        return 'database';
    return 'other';
}
function errorCode(error) {
    let current = error;
    for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
        const code = Reflect.get(current, 'code');
        if (typeof code === 'string' && code.length > 0) {
            return code.startsWith('SQLITE_') ? sqliteFamily(code) : code;
        }
        current = Reflect.get(current, 'cause');
    }
    return undefined;
}
/** `SQLITE_IOERR_WRITE` and the like: the family names the failure. */
function sqliteFamily(code) {
    const family = /^SQLITE_[A-Z]+/u.exec(code)?.[0];
    return family ?? code;
}
async function settle(run) {
    try {
        return await run();
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=reset.js.map