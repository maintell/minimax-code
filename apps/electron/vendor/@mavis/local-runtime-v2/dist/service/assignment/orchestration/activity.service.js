import path from 'node:path';
import { ToolCallStatus } from '@mavis/agent-core/protocol';
import { MsgType, RespDataType } from '@mavis/agent-core/protocol/agent-message';
import { STALL_NO_PROGRESS, stallHungWork, stallRepeatedError, } from '../../coordinator-text/index.js';
const IDLE_TIMEOUT_MS = 10 * 60_000;
const REPEATED_ERROR_LIMIT = 3;
/** Opt-in bound for a round with outstanding work that no longer reports progress. */
const HUNG_WORK_LIMIT_MS = 60 * 60_000;
/**
 * Whether a round whose own work never comes back is closed instead of running for ever.
 *
 * `MCODE_ASSIGNMENT_HUNG_WORK_CLOSE=1` turns it on. Unset, or set to anything else, leaves
 * today's contract exactly as it was: a tool call that has not returned, or a background
 * task still running, is work however long it stays quiet, and nothing closes.
 */
function hungWorkCloseEnabled() {
    return process.env.MCODE_ASSIGNMENT_HUNG_WORK_CLOSE === '1';
}
/**
 * The bound a quiet round's own work is measured against, from
 * `MCODE_ASSIGNMENT_HUNG_WORK_LIMIT_MS` in milliseconds. `undefined` while the close is
 * off, so no caller can apply a bound by accident.
 */
function hungWorkLimitMs() {
    if (!hungWorkCloseEnabled())
        return undefined;
    const parsed = Number(process.env.MCODE_ASSIGNMENT_HUNG_WORK_LIMIT_MS);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : HUNG_WORK_LIMIT_MS;
}
export class AssignmentActivityService {
    options;
    mark;
    closeHung;
    activities = new Map();
    runs = new Map();
    /** Stall event writes run in order; close() waits for the chain so none is lost on shutdown. */
    eventWrites = Promise.resolve();
    unsubscribe;
    /**
     * A stall is shown, never reported: it is marked on the task, written to its
     * history and cleared by the next progress (R5.5). Waiting for an approval
     * or an answer is not a stall.
     */
    constructor(options, mark, 
    /**
     * Closes a task whose round went quiet with work of its own still hanging. Absent,
     * such a round is only labelled, never closed.
     */
    closeHung) {
        this.options = options;
        this.mark = mark;
        this.closeHung = closeHung;
        this.unsubscribe = options.events.subscribe({
            next: (event) => {
                if (event.type === 'session.start') {
                    // Reserve before awaiting session facts so the first live chunks are retained.
                    const reservation = options.stream.reserve(event.payload.sessionId);
                    this.stop(event.payload.sessionId);
                    const run = {
                        reservation,
                        text: '',
                        lastPublished: -Infinity,
                        turnId: event.payload.turnId ?? '',
                        lastProgressAt: options.nowMs(),
                        progress: 0,
                        calls: new Map(),
                    };
                    this.runs.set(event.payload.sessionId, run);
                    run.work = this.consume(event.payload.sessionId, run);
                }
                else if (event.type === 'session.finish' ||
                    event.type === 'session.error' ||
                    event.type === 'session.abort') {
                    this.stop(event.payload.sessionId);
                }
            },
        });
    }
    /** Why the task's running round is stalled; undefined while it makes progress. */
    stallReason(id) {
        return this.runs.get(id)?.stallReason;
    }
    async current(id) {
        const current = this.activities.get(id);
        if (current)
            return current;
        const [message] = await this.options.messages.listRecent(id, { role: 'assistant', limit: 1 });
        return message ? activityFromMessage(message, this.options.nowMs()) : undefined;
    }
    async close() {
        this.unsubscribe();
        const work = [...this.runs.values()].flatMap((run) => [run.work, run.idleWork, run.hungWork]);
        for (const id of this.runs.keys())
            this.stop(id);
        await Promise.all([...work, this.eventWrites]);
    }
    stop(id) {
        const run = this.runs.get(id);
        if (run?.timer)
            clearTimeout(run.timer);
        if (run?.idleTimer)
            clearTimeout(run.idleTimer);
        run?.reservation.close();
        this.runs.delete(id);
        this.activities.delete(id);
    }
    async consume(id, run) {
        try {
            const session = await this.options.sessions.get(id);
            // A new turn reopens closed work concurrently, so closure is not a reason to skip it.
            if (!session ||
                session.archived ||
                !(await this.options.tasks.get(id)) ||
                this.runs.get(id) !== run)
                return;
            this.watchIdle(id, run);
            for await (const frame of run.reservation.source) {
                if (this.runs.get(id) !== run)
                    return;
                this.consumeFrame(id, run, frame);
            }
        }
        catch (error) {
            this.options.logger.warn({ error, sessionId: id }, 'Assignment activity observation failed');
        }
        finally {
            run.reservation.close();
            if (this.runs.get(id) === run)
                this.stop(id);
        }
    }
    consumeFrame(id, run, frame) {
        if (frame.kind !== 'runtime-event')
            return;
        const response = streamResponse(frame.data);
        // Todo events are committed to history before reaching this stream. Invalidate
        // assignment readers even if the current activity text has not changed.
        if (response?.type === RespDataType.AgentMessage && isTodoEvent(response.agent_message)) {
            this.progress(id, run);
            this.schedule(id, run);
            return;
        }
        const chunk = response?.type === RespDataType.AgentMessageChunk
            ? object(response.agent_message_chunk)
            : undefined;
        if (!chunk)
            return;
        this.observeProgress(id, run, chunk);
        this.update(id, run, chunk);
    }
    progress(id, run) {
        run.lastProgressAt = this.options.nowMs();
        run.progress++;
        if (run.stallReason !== undefined) {
            run.stallReason = undefined;
            this.mark(id);
        }
        this.watchIdle(id, run);
    }
    observeProgress(id, run, chunk) {
        if (typeof chunk.msg_content === 'string' && chunk.msg_content.length)
            this.progress(id, run);
        if (!Array.isArray(chunk.tool_calls))
            return;
        for (const value of chunk.tool_calls)
            this.observeTool(id, run, value);
    }
    observeTool(id, run, value) {
        const call = object(value);
        if (!call || typeof call.tool_call_id !== 'string' || typeof call.tool_name !== 'string')
            return;
        const status = call.tool_call_status;
        if (typeof status !== 'number' || run.calls.get(call.tool_call_id) === status)
            return;
        run.calls.set(call.tool_call_id, status);
        if (status === ToolCallStatus.Start || status === ToolCallStatus.Finished)
            this.progress(id, run);
        if (status === ToolCallStatus.Finished)
            run.recentError = undefined;
        if (status === ToolCallStatus.Failed)
            this.observeError(id, run, call);
    }
    observeError(id, run, call) {
        const text = errorText(call.tool_call_result_data);
        const tool = call.tool_name;
        const previous = run.recentError;
        const count = previous?.tool === tool && previous.text === text ? previous.count + 1 : 1;
        run.recentError = { tool, text, count };
        if (count >= REPEATED_ERROR_LIMIT)
            this.stall(id, run, 'repeated_error', stallRepeatedError(text.split(/\r?\n/, 1)[0]));
    }
    watchIdle(id, run, delay = IDLE_TIMEOUT_MS - (this.options.nowMs() - run.lastProgressAt)) {
        if (run.idleTimer)
            clearTimeout(run.idleTimer);
        run.idleTimer = setTimeout(() => {
            run.idleTimer = undefined;
            run.idleWork = this.observeIdle(id, run);
        }, Math.max(1, delay));
        run.idleTimer.unref?.();
    }
    async observeIdle(id, run) {
        try {
            await this.checkIdle(id, run);
        }
        catch (error) {
            this.options.logger.warn({ error, sessionId: id }, 'Assignment stall observation failed');
        }
    }
    async checkIdle(id, run) {
        const session = await this.options.sessions.get(id);
        if (!session || session.archived || (await this.options.tasks.get(id))?.completion)
            return;
        const [status, working] = await Promise.all([
            this.options.facts.status(session),
            this.working(id, run),
        ]);
        if (this.runs.get(id) !== run || run.stallReason !== undefined)
            return;
        const quiet = this.options.nowMs() - run.lastProgressAt;
        if (quiet < IDLE_TIMEOUT_MS)
            return;
        this.observeQuietRound(id, run, { status, working, quiet });
    }
    /**
     * The round has been quiet for at least the idle timeout. Work of its own stops counting
     * once the round has been quiet past the bound: a call that has not returned for that long
     * is not coming back on its own, so the round reads as stalled instead of working for ever.
     * No bound while the close is off, so nothing changes.
     */
    observeQuietRound(id, run, observation) {
        const { status, working, quiet } = observation;
        const limit = hungWorkLimitMs();
        const hung = working && limit !== undefined && quiet >= limit;
        if (!idleStalled(status, working && !hung)) {
            this.watchIdle(id, run, IDLE_TIMEOUT_MS);
            return;
        }
        if (limit !== undefined && hung)
            this.stall(id, run, 'hung_work', stallHungWork(Math.max(1, Math.round(limit / 60_000))));
        else
            this.stall(id, run, 'no_progress', STALL_NO_PROGRESS);
    }
    /**
     * Whether the round still has work running: a tool call dispatched and not returned, or a
     * background task of the task's own. A call that returns meanwhile is progress itself.
     */
    async working(id, run) {
        if (runningCall(run))
            return true;
        return (await this.options.facts.hasRunningBackgroundTask?.(id)) === true;
    }
    stall(id, run, kind, reason) {
        if (run.stallReason !== undefined)
            return;
        run.stallReason = reason;
        this.mark(id);
        const key = `${id}:${run.turnId}:stalled:${run.progress}`;
        this.eventWrites = this.recordStall(this.eventWrites, id, kind, key);
        // The round's own work never came back. A label alone would leave the task running for
        // ever and holding one of the user's slots, so it closes as done, keeping what it delivered.
        if (kind === 'hung_work')
            run.hungWork = this.closeHungRound(id, reason);
    }
    async closeHungRound(id, detail) {
        try {
            await this.closeHung?.({ sessionId: id, detail });
        }
        catch (error) {
            this.options.logger.warn({ error, sessionId: id }, 'Assignment hung round close failed');
        }
    }
    async recordStall(previous, id, kind, dedupeKey) {
        await previous;
        try {
            // The stored event is news for readers of task history (the space timeline).
            if (await this.options.tasks.appendEvent(id, {
                type: 'task.stalled',
                payload: { kind },
                dedupeKey,
            }))
                this.mark(id);
        }
        catch (error) {
            this.options.logger.warn({ error, sessionId: id }, 'Assignment stall event failed');
        }
    }
    update(id, run, chunk) {
        if (typeof chunk.msg_id === 'string' && run.messageId !== chunk.msg_id) {
            run.messageId = chunk.msg_id;
            run.text = '';
        }
        if (typeof chunk.msg_content === 'string')
            run.text += chunk.msg_content;
        const activity = activityFromMessage({ ...chunk, msg_content: run.text }, this.options.nowMs());
        if (!activity)
            return;
        const previous = this.activities.get(id);
        if (previous?.kind === activity.kind && previous.target === activity.target)
            return;
        this.activities.set(id, activity);
        this.schedule(id, run);
    }
    schedule(id, run) {
        if (run.timer)
            return;
        const delay = Math.max(0, 2000 - (this.options.nowMs() - run.lastPublished));
        if (!delay) {
            run.lastPublished = this.options.nowMs();
            this.mark(id);
            return;
        }
        run.timer = setTimeout(() => {
            run.timer = undefined;
            run.lastPublished = this.options.nowMs();
            this.mark(id);
        }, delay);
        run.timer.unref?.();
    }
}
/**
 * A quiet running round is stalled only when nothing of it still runs. Approval and
 * questionnaire waits are not stalled work, nor a running turn's open question; a tool call
 * that has not returned or a running background task is work however long it stays quiet —
 * until {@link hungWorkLimitMs} bounds it, past which point such work no longer counts and
 * the round closes ({@link StallKind} `hung_work`).
 */
function idleStalled(status, working) {
    return status.state === 'running' && !status.pendingQuestionCount && !working;
}
/** Whether a tool call of this round was dispatched and has not returned yet. */
function runningCall(run) {
    for (const status of run.calls.values())
        if (status === ToolCallStatus.Start)
            return true;
    return false;
}
/** @internal Exported only for focused tests. */
export function activityFromMessage(value, at) {
    const message = object(value);
    if (!message)
        return undefined;
    const calls = message.tool_calls;
    const call = Array.isArray(calls) ? object(calls.at(-1)) : undefined;
    if (call && typeof call.tool_name === 'string')
        return toolActivity(call.tool_name, toolArguments(call), at);
    if (typeof message.msg_content !== 'string')
        return undefined;
    const text = message.msg_content
        .trim()
        .split(/[。？！.!?\n]/, 1)[0]
        ?.slice(0, 60);
    return text ? { kind: 'text', target: text, at } : undefined;
}
/** Live assistant output reaches the Session stream as a serialized stream response. */
function streamResponse(data) {
    if (typeof data !== 'string')
        return undefined;
    try {
        return object(JSON.parse(data));
    }
    catch {
        return undefined;
    }
}
function isTodoEvent(value) {
    const message = object(value);
    if (message?.msg_type !== MsgType.SystemEvent || typeof message.msg_content !== 'string')
        return false;
    try {
        return JSON.parse(message.msg_content).eventType === 'todo_updated';
    }
    catch {
        return false; // Other system messages need no progress refresh.
    }
}
function errorText(value) {
    if (typeof value !== 'string')
        return '';
    try {
        const result = JSON.parse(value);
        if (typeof result === 'string')
            return result;
        if (typeof result?.error === 'string')
            return result.error;
        if (Array.isArray(result?.content))
            return result.content
                .filter((block) => block.type === 'text' && typeof block.text === 'string')
                .map((block) => block.text)
                .join('\n');
    }
    catch {
        /* The wire result can be plain error text. */
    }
    return value;
}
function toolArguments(call) {
    if (typeof call.tool_call_args !== 'string')
        return {};
    try {
        return object(JSON.parse(call.tool_call_args)) ?? {};
    }
    catch {
        return {};
    } // Tool arguments may still be streaming partial JSON.
}
function toolActivity(name, args, at) {
    if (['read', 'read_file', 'edit', 'write', 'apply_patch'].includes(name))
        return {
            kind: ['read', 'read_file'].includes(name) ? 'read' : 'edit',
            target: fileTarget(args),
            at,
        };
    if (name === 'bash') {
        // Leading `cd <dir> &&` only says where; the progress line shows what runs.
        const command = string(args, 'command').replace(/^(?:\s*cd\s+[^&;|]+(?:&&|;)\s*)+/, '');
        return {
            kind: /\b(test|vitest|jest|pytest)\b/.test(command) ? 'test' : 'command',
            target: command.slice(0, 60),
            at,
        };
    }
    if (['grep', 'glob'].includes(name))
        return { kind: 'search', target: string(args, 'pattern'), at };
    if (['web_search', 'web_fetch'].includes(name) || /browser/i.test(name))
        return { kind: 'web', at };
    return { kind: 'tool', target: name, at };
}
function fileTarget(args) {
    const patch = string(args, 'patch') || string(args, 'input');
    const header = /\*\*\* (?:Update|Add|Delete) File: ([^\r\n]+)/.exec(patch)?.[1] ?? '';
    const file = string(args, 'path') || string(args, 'file_path') || string(args, 'file') || header;
    return path.win32.basename(path.basename(file));
}
function string(args, key) {
    return typeof args[key] === 'string' ? args[key] : '';
}
function object(value) {
    return typeof value === 'object' && value !== null
        ? value
        : undefined;
}
//# sourceMappingURL=activity.service.js.map