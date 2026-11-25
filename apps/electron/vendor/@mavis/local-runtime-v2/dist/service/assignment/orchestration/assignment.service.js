import { assignmentEntryName, validateCreateInput, taskInstruction, assignmentLink, closureReason, } from '../task-input.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBunnyAssignmentPurpose } from '@mavis/shared/bunny-assignment-purpose';
import { AssignmentQueue } from './assignment-queue.js';
import { taskAttachmentPaths } from '../../../infra/conversation/dispatch-attachments.js';
import { assertAcceptableConclusion, assertBunnyAssigner, coded, refuseSend, requireReadableAttachments, } from '../state/assignment-refusals.js';
import { claimDirectory, claimFile, containingProject, defaultProjectOf, executionLocationLabel, isDirectory, mergeClaims, normalizeProjectDir, projectByName, projectDirectoryOf, projectStart, releaseExecutionLocation, } from './execution-location.js';
import { assertTaskLimit, assignerSessionOf, listAssignmentPage, listDispatchedTasks, sortTasksByDispatchOrder, } from '../dispatched-tasks.js';
import { readReviewTarget } from '../review-target-reader.js';
import { BUNNY_AGENT_NAME } from '../../bunny/index.js';
import { ASSIGNMENT_ERROR, assignmentModelUnavailable, assignmentSpaceNotFound, assignmentSpaceRequired, worktreeSubPathMissing, } from '../../coordinator-text/index.js';
import { ASSIGNMENT_SEND_REASONS, isAssignedByBunny, originChannelColumn, SPACE_ARTIFACTS_DIR, } from '../../session-system/index.js';
import { deliveredArtifacts, spaceLinkOf, } from '../contracts.js';
import { endedOpenRound, reviewFailed, stalled } from '../state/assignment-status-facts.js';
import { followUpOrigin } from '../state/origin-routing.js';
import { verdictStatus } from '../verdict/verdict-gate.js';
import { prepareConclusion, } from '../state/conclusion-facts.js';
import { AssignmentVerdictWiring } from '../verdict/verdict-wiring.js';
/** A fresh dispatch's answer: where it could not run as asked, and which files the task got. */
function acceptedWith(accepted, locationHint, attachments) {
    return {
        ...accepted,
        ...(locationHint ? { locationHint } : {}),
        ...(attachments.length ? { attachments } : {}),
    };
}
export class AssignmentService {
    options;
    mark;
    activity;
    reports;
    creates = new Map();
    operation = Promise.resolve();
    /** Only used inside `serialize()`; see {@link AssignmentQueue}. */
    queue;
    constructor(options, mark = () => { }, activity, reports) {
        this.options = options;
        this.mark = mark;
        this.activity = activity;
        this.reports = reports;
        this.queue = new AssignmentQueue(options, {
            require: (id) => this.require(id),
            origin: (caller) => this.origin(caller, 'create'),
            mark: (id) => this.mark(id),
            reportFailed: (signal) => this.reports?.failed(signal),
        });
        this.verdictWiring = new AssignmentVerdictWiring({
            options: this.options,
            serialize: (run) => this.serialize(run),
            require: (id) => this.require(id),
            requireSummaryAssignment: (task, caller) => this.requireSummaryAssignment(task, caller),
            mark: (id) => this.mark(id),
            verdictRecorded: (id, verdict) => this.reports?.verdictRecorded(id, verdict),
        });
    }
    async serialize(run) {
        const previous = this.operation;
        let release;
        this.operation = new Promise((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await run();
        }
        finally {
            release();
        }
    }
    /** Every verdict write and every conclusion write; see verdict/verdict-wiring.ts. */
    verdictWiring;
    /** @see AssignmentVerdictWiring.startVerdictReview */
    startVerdictReview(input) {
        return this.verdictWiring.startVerdictReview(input);
    }
    /** @see AssignmentVerdictWiring.recordVerdict */
    recordVerdict(input) {
        return this.verdictWiring.recordVerdict(input);
    }
    /** @see AssignmentVerdictWiring.recordReviewerVerdict */
    recordReviewerVerdict(input) {
        return this.verdictWiring.recordReviewerVerdict(input);
    }
    /** @see AssignmentVerdictWiring.abandonVerdictReview */
    abandonVerdictReview(input) {
        return this.verdictWiring.abandonVerdictReview(input);
    }
    /** @see AssignmentVerdictWiring.claimVerdict */
    claimVerdict(input) {
        return this.verdictWiring.claimVerdict(input);
    }
    /** Explicit user-facing conclusions; reading a report or sending rework never calls this. */
    async summarize(input) {
        const caller = await this.require(input.callerSessionId);
        if (caller.agentName !== BUNNY_AGENT_NAME)
            throw new Error('Only Bunny can summarize tasks');
        if (!input.items.length)
            throw new Error('At least one task conclusion is required');
        const ports = {
            requireTask: (sessionId) => this.require(sessionId),
            requireAssignment: (task) => this.requireSummaryAssignment(task, caller),
            conclusionBlock: (assignment) => this.verdictWiring.conclusionBlock(assignment),
            facts: this.options.facts,
        };
        const ids = new Set();
        const prepared = [];
        const gateOn = this.verdictWiring.verdictGateOn();
        for (const item of input.items) {
            assertAcceptableConclusion(item, ids);
            ids.add(item.sessionId);
            prepared.push(await prepareConclusion(ports, item, gateOn));
        }
        // Every item is validated first, so a rejected batch changes nothing.
        const running = prepared
            .filter((entry) => entry.backgroundRunning)
            .map((entry) => entry.result.sessionId);
        if (running.length > 0)
            throw coded(`These tasks still have background work running: ${running.join(', ')}. ` +
                'Wait for it to finish, then conclude them.', 'ASSIGNMENT_BACKGROUND_RUNNING');
        await this.verdictWiring.recordConclusions(prepared.map((entry) => entry.result), new Set(prepared.filter((entry) => entry.gated).map((entry) => entry.result.sessionId)), caller.sessionId);
        // No session messages or delivery receipts are mutated here.
        return { items: prepared.map((entry) => entry.summaryItem) };
    }
    async requireSummaryAssignment(task, caller) {
        const assignment = await this.options.tasks.get(task.sessionId);
        if (!isAssignedByBunny(assignment) ||
            (assignment.assignerSessionId !== caller.sessionId &&
                (!assignment.assignerWasRoot ||
                    caller.sessionId !== (await this.options.agents.currentRoot(BUNNY_AGENT_NAME)))))
            throw new Error('Only the assigner or its current root can summarize this task');
        return assignment;
    }
    async setCompletion(input) {
        return this.serialize(async () => {
            const target = await this.require(input.sessionId);
            const assignment = await this.closable(target.sessionId, input);
            // A queued start never ran; anything else must really stop before it is closed.
            if (input.state === 'cancelled' && !assignment.pendingStart)
                await this.stopForCancel(target.sessionId);
            const closed = await this.options.tasks.close(target.sessionId, {
                state: input.state,
                by: input.by,
                at: this.options.nowMs(),
                reason: closureReason(input),
                ...(input.summary !== undefined ? { summary: input.summary } : {}),
                // A task closed as done keeps what it delivered; a cancelled one is not a result.
                ...(input.state === 'completed'
                    ? await deliveredArtifacts(this.options.assets, target.sessionId)
                    : {}),
            });
            const updated = closed && (await this.options.sessions.get(target.sessionId));
            if (!closed || !updated)
                throw new Error('Assignment target was deleted');
            this.queue.closed(target.sessionId);
            this.mark(target.sessionId);
            await this.queue.startPending();
            return this.status(updated, closed);
        });
    }
    /** Closes a task whose round went quiet with work still hanging (`reason: 'stalled'`), freeing its slot. */
    closeHung(input) {
        return this.serialize(async () => {
            const assignment = await this.options.tasks.get(input.sessionId);
            if (!assignment || assignment.completion)
                return;
            // Best effort: stop the hung round so it cannot keep working after its slot is reused.
            // A stop that itself hangs or fails must not keep the slot, so the close goes ahead.
            try {
                await this.options.conversation.ingress.interruptTurn({
                    sessionId: input.sessionId,
                    reason: 'user_stop',
                });
            }
            catch {
                // A failed stop must not keep the slot; the close goes ahead.
            }
            const closed = await this.options.tasks.close(input.sessionId, {
                state: 'completed',
                by: 'assigner',
                at: this.options.nowMs(),
                reason: 'stalled',
                summary: input.detail,
                ...(await deliveredArtifacts(this.options.assets, input.sessionId)),
            });
            if (!closed)
                return;
            this.queue.closed(input.sessionId);
            this.mark(input.sessionId);
            await this.queue.startPending();
        });
    }
    async closable(sessionId, input) {
        const assignment = await this.options.tasks.get(sessionId);
        if (!assignment)
            throw new Error('Session has no assignment');
        if (input.by === 'assigner' &&
            input.callerSessionId !== assignment.assignerSessionId &&
            input.callerSessionId !==
                (await this.options.agents.currentRoot(assignment.assignerAgentName)))
            throw new Error('Only the assigner or its current root can close this assignment');
        return assignment;
    }
    /** Drops waiting messages and stops the running turn before a cancellation closes the task. */
    async stopForCancel(sessionId, pending = {
        message: ASSIGNMENT_ERROR.cancelPending,
        code: 'ASSIGNMENT_CANCEL_PENDING',
    }) {
        const ingress = this.options.conversation.ingress;
        await this.dropQueued(sessionId);
        const stopped = await ingress.interruptTurn({ sessionId, reason: 'user_stop' });
        if (stopped.status === 'abort-timeout')
            throw coded(pending.message, pending.code);
        // Messages queued while the turn was stopping.
        await this.dropQueued(sessionId);
    }
    /**
     * The task a new one takes over (R5.4): one of Bunny's tasks that is still
     * open. Checked before anything is stopped or created.
     */
    async takeoverOriginal(sessionId) {
        if (sessionId === undefined)
            return undefined;
        const session = await this.options.sessions.get(sessionId);
        const assignment = session && !session.archived ? await this.options.tasks.get(sessionId) : undefined;
        if (!isAssignedByBunny(assignment))
            throw coded(ASSIGNMENT_ERROR.takeoverNotOwned, 'ASSIGNMENT_TAKEOVER_NOT_OWNED');
        if (assignment.completion)
            throw coded(ASSIGNMENT_ERROR.takeoverClosed, 'ASSIGNMENT_TAKEOVER_CLOSED');
        return { sessionId, assignment };
    }
    /** A successor stays in its original's space unless Bunny names another. */
    successorSpace(named, original) {
        if (named !== undefined || !original)
            return named;
        return this.options.worklines.sessionSpace(original.sessionId);
    }
    /**
     * Stops the original so the two tasks never run at once; a queued one never
     * ran. When it cannot stop yet, nothing is created and the claimed location
     * is given back.
     */
    async stopTakenOver(original, claim) {
        if (!original)
            return;
        try {
            if (!original.assignment.pendingStart)
                await this.stopForCancel(original.sessionId, {
                    message: ASSIGNMENT_ERROR.takeoverPending,
                    code: 'ASSIGNMENT_TAKEOVER_PENDING',
                });
        }
        catch (error) {
            await releaseExecutionLocation(claim, this.options.logger);
            throw error;
        }
        this.queue.closed(original.sessionId);
    }
    async closeTakenOver(original, successorSessionId) {
        if (!original)
            return;
        const closed = await this.options.tasks.close(original.sessionId, {
            state: 'taken_over',
            by: 'assigner',
            at: this.options.nowMs(),
            reason: 'taken_over',
            successorSessionId,
        });
        if (!closed)
            throw new Error(`Assignment target was deleted: ${original.sessionId}`);
        this.mark(original.sessionId);
    }
    /** Stops the running round of a Bunny task (R5.6); the task stays open and keeps its queue. */
    stop(input) {
        return this.serialize(async () => {
            await this.requireAssigner(input.callerSessionId);
            const target = await this.require(input.sessionId);
            const assignment = await this.options.tasks.get(target.sessionId);
            if (!isAssignedByBunny(assignment))
                throw coded(ASSIGNMENT_ERROR.stopNotOwned, 'ASSIGNMENT_NOT_OWNED');
            if (assignment.completion)
                throw coded(ASSIGNMENT_ERROR.stopClosed, 'ASSIGNMENT_CLOSED');
            if (assignment.pendingStart)
                throw coded(ASSIGNMENT_ERROR.stopQueued, 'ASSIGNMENT_QUEUED');
            const stopped = await this.options.conversation.ingress.interruptTurn({
                sessionId: target.sessionId,
                reason: 'user_stop',
            });
            if (stopped.status === 'not-running' || stopped.status === 'turn-mismatch')
                throw coded(ASSIGNMENT_ERROR.stopNotRunning, 'ASSIGNMENT_NOT_RUNNING');
            this.mark(target.sessionId);
            return this.status((await this.options.sessions.get(target.sessionId)) ?? target);
        });
    }
    async dropQueued(sessionId) {
        const ingress = this.options.conversation.ingress;
        for (const item of await ingress.listQueued(sessionId))
            if (item.status === 'queued')
                await ingress.cancelQueued(sessionId, item.itemId);
    }
    /**
     * The only automatic way back to open work: a real turn started in the task,
     * by the assigner, a queued message or the user typing in it. The task runs
     * again and shows so; a review in progress is superseded by the new round.
     * A closure recorded after this turn started is a later decision and is
     * kept, and a cancelled task stays closed.
     */
    started(sessionId, startedAt = this.options.nowMs(), turnId) {
        return this.serialize(async () => {
            // Inside the lock so a release queued for the previous turn cannot mark
            // the running turn terminal again.
            this.queue.turnStarted(sessionId);
            const target = await this.options.sessions.get(sessionId);
            if (!target || target.archived)
                return;
            if (await this.options.tasks.reopen(sessionId, startedAt, turnId))
                this.mark(sessionId);
        });
    }
    /**
     * The terminal event reaches subscribers before the Turn's end is committed,
     * so a state read for it can still see the admitted Turn; read again once
     * the Turn has settled. A coordinator that just settled takes its held reports.
     */
    turnSettled(sessionId) {
        this.mark(sessionId);
        this.reports?.settled(sessionId);
    }
    release(sessionId) {
        return this.serialize(async () => {
            if (!(await this.options.sessions.get(sessionId)) ||
                !(await this.options.tasks.get(sessionId)))
                return;
            this.queue.ended(sessionId);
            await this.queue.startPending();
        });
    }
    /**
     * The task now waits for the user's approval or answer and gives up its
     * slot. Its turn resumes after the reply without passing admission again.
     */
    waiting(sessionId) {
        return this.serialize(async () => {
            if (!(await this.options.tasks.get(sessionId)))
                return;
            await this.queue.startPending();
        });
    }
    ready() {
        return this.serialize(() => this.queue.startPending());
    }
    async close() {
        await this.operation;
    }
    /**
     * A create from `assignment_create`. The tool names no model: the task runs on the
     * assigner's task model rule (Bunny's saved task model). A model a stale caller still
     * sends is dropped here, never forwarded.
     */
    createFromTool(input) {
        const rest = { ...input };
        delete rest.model;
        return this.create(rest);
    }
    /** The project an assignment tool dispatches into, by its own name and arguments. */
    async resolveAssignmentProject(callerSessionId, toolName, args) {
        if (toolName === 'assignment_create') {
            const project = Reflect.get(args, 'project');
            if (project !== undefined && typeof project !== 'string')
                throw new Error('Invalid project');
            return (await this.executionProject(project))?.projectDir ?? 'default';
        }
        return toolName === 'assignment_send' ? this.sendProject(callerSessionId, args) : undefined;
    }
    async sendProject(callerSessionId, args) {
        const id = Reflect.get(args, 'session_id');
        if (id === 'me' || id === callerSessionId)
            return undefined;
        if (typeof id !== 'string')
            throw new Error('session_id is required');
        const target = await this.require(id);
        if (target.isDefaultWorkspace)
            return 'default';
        if (target.projectWorkspaceDir)
            return target.projectWorkspaceDir;
        const dir = target.runLocation?.parentRepoDir ?? target.workspaceDir;
        // The same scope its create was approved under: the project containing the task.
        return (await containingProject(await this.candidateProjectDirs(), dir))?.projectDir ?? dir;
    }
    async prepareSend(input) {
        const target = await this.require(input.sessionId);
        await this.requireAssigner(input.callerSessionId);
        if (!isAssignedByBunny(await this.options.tasks.get(target.sessionId)))
            throw new Error('Bunny can only send to its own assignments');
        if (input.reason !== undefined && !ASSIGNMENT_SEND_REASONS.includes(input.reason))
            throw new Error('reason must be one of rework, supplement, decision');
        const { assignment, origin, previous } = await this.assign(input.callerSessionId, input.sessionId, {
            reportBack: true,
            reason: input.reason,
            ...(input.callerTurnId ? { callerTurnId: input.callerTurnId } : {}),
            ...(input.originChannel ? { originChannel: input.originChannel } : {}),
        });
        return {
            origin,
            reportBack: true,
            title: target.title ?? '',
            projectName: target.isDefaultWorkspace
                ? 'default'
                : path.basename(projectDirectoryOf(target)),
            /** Undo this send's assignment when its message was never admitted. */
            rollback: () => this.restoreAssignment(input.sessionId, previous, assignment),
        };
    }
    /**
     * The assignment is written before delivery so a fast start and finish
     * already report to the new assigner. When delivery is then rejected, the
     * previous assignment comes back (with any report it was still owed),
     * unless something newer replaced this one in between. A closure recorded
     * meanwhile is kept.
     */
    restoreAssignment(sessionId, previous, applied) {
        return this.serialize(async () => {
            if (await this.options.tasks.restore(sessionId, applied, previous))
                this.mark(sessionId);
        });
    }
    async create(input) {
        validateCreateInput(input);
        const key = input.requestId
            ? JSON.stringify([input.callerSessionId, input.requestId])
            : undefined;
        const current = key ? this.creates.get(key) : undefined;
        if (current)
            return { ...(await current), reused: true };
        const operation = this.serialize(() => this.createSession(input));
        if (key)
            this.creates.set(key, operation);
        try {
            return await operation;
        }
        finally {
            if (key)
                this.creates.delete(key);
        }
    }
    async projects() {
        const projects = [];
        let cursor;
        do {
            const page = await this.options.projects.listPage({
                includeHiddenProjects: true,
                // A project the user registered before opening any conversation in it is still theirs.
                includeEmptyProjects: true,
                limit: 200,
                ...(cursor ? { cursor } : {}),
            });
            projects.push(...page.projects.filter((item) => item.projectKind === 'workspace' && item.workspaceDir));
            cursor = page.hasMore ? page.nextCursor : undefined;
            if (page.hasMore && !cursor)
                throw new Error('Project pagination is missing its continuation cursor');
        } while (cursor);
        return projects;
    }
    /**
     * Registered workspace projects plus the projects linked to spaces. A space's
     * linked project is a project the user chose, even before any session opened it.
     */
    async candidateProjectDirs() {
        const registered = (await this.projects()).flatMap((item) => item.workspaceDir ? [normalizeProjectDir(item.workspaceDir)] : []);
        const linked = (await this.options.worklines.list())
            .flatMap((item) => item.projects ?? [])
            .filter((dir) => path.isAbsolute(dir))
            .map((dir) => normalizeProjectDir(dir));
        return [...new Set([...registered, ...linked])];
    }
    async project(project) {
        const dirs = await this.candidateProjectDirs();
        const target = path.isAbsolute(project)
            ? await containingProject(dirs, project)
            : projectByName(dirs, project);
        if (!target) {
            throw Object.assign(new Error(path.isAbsolute(project)
                ? ASSIGNMENT_ERROR.projectPathNotFound
                : ASSIGNMENT_ERROR.projectNotMatched), {
                code: 'ASSIGNMENT_PROJECT_NOT_FOUND',
                candidates: dirs.map((dir) => ({ name: path.basename(dir), path: dir })),
            });
        }
        return target;
    }
    /** A follow-up round for one of Bunny's tasks, written before its message is delivered. */
    async assign(callerSessionId, targetId, send) {
        return this.serialize(async () => {
            const caller = await this.requireAssigner(callerSessionId);
            await this.require(targetId);
            const current = await this.options.tasks.get(targetId);
            refuseSend(current);
            // Follow-up sends bypass admission. Preparing a send does not resume work:
            // keep its closure until the message is consumed and session.start is published.
            const assignment = {
                ...this.makeAssignment(caller, { via: 'send', reportBack: send.reportBack }),
                ...(current?.goal ? { goal: current.goal } : {}),
                ...(current?.doneWhen ? { doneWhen: current.doneWhen } : {}),
                ...(current?.userWords ? { userWords: current.userWords } : {}),
                ...followUpOrigin(send.originChannel, current),
                // What a task reviews is part of what it is: a follow-up round keeps it.
                ...(current?.reviewOf ? { reviewOf: { ...current.reviewOf } } : {}),
                ...(current?.completion ? { completion: current.completion } : {}),
                ...(current?.requestId
                    ? {
                        requestId: current.requestId,
                        requestAssignerSessionId: current.requestAssignerSessionId,
                    }
                    : {}),
            };
            if (!(await this.options.tasks.reassign(targetId, assignment, {
                ...(send.reason ? { reason: send.reason } : {}),
                ...(send.callerTurnId ? { dispatchTurnId: send.callerTurnId } : {}),
            })))
                throw new Error('Assignment target was deleted');
            this.mark(targetId);
            return { assignment, origin: await this.origin(caller, 'send'), previous: current };
        });
    }
    /**
     * Open tasks come first, newest assigned first, then closed tasks by the same order, so a
     * bounded list never drops an open task for a newer closed one.
     */
    async list(agentName, limit = 50) {
        assertTaskLimit(limit);
        const assigned = sortTasksByDispatchOrder(await this.options.tasks.list({ archived: false, assignerAgentName: agentName })).slice(0, limit);
        const statuses = await Promise.all(assigned.map(async ({ sessionId, assignment }) => {
            const session = await this.options.sessions.get(sessionId);
            return session && !session.archived ? this.status(session, assignment) : undefined;
        }));
        return statuses.filter((status) => status !== undefined);
    }
    page(agentName, input) {
        return listAssignmentPage(this.options, agentName, input, (session, assignment) => this.status(session, assignment));
    }
    /**
     * Review counts for `turnId`: total tasks reviewed (live `assignment.review` plus
     * `review.finished` history cleared by `closeReviewed`), and still-open reviews that
     * `finishReview` would close if this Turn finished now.
     */
    async reviewRoundCounts(sessionId, turnId) {
        const reviewed = new Set();
        let openReviewCount = 0;
        for (const task of await this.options.tasks.list({ reviewSessionId: sessionId })) {
            if (task.assignment.review?.turnId !== turnId)
                continue;
            reviewed.add(task.sessionId);
            if (task.assignment.completion)
                continue;
            if (await this.closesOnTurnEnd(task.sessionId))
                openReviewCount += 1;
        }
        for (const id of await this.options.tasks.reviewedTaskIds(turnId))
            reviewed.add(id);
        return { reviewedTaskCount: reviewed.size, openReviewCount };
    }
    /**
     * Whether `finishReview` would close this task's review when its reviewer's Turn ends.
     * It declines a task whose own round no longer reads as completed, and a Session that is
     * gone from the main database closes nothing.
     */
    async closesOnTurnEnd(taskSessionId) {
        const session = await this.options.sessions.get(taskSessionId);
        if (!session)
            return false;
        return (await this.options.facts.status(session)).state === 'completed';
    }
    async reviewedTaskCount(sessionId, turnId) {
        return (await this.reviewRoundCounts(sessionId, turnId)).reviewedTaskCount;
    }
    /** Tasks linked by the authoritative assignment graph, including parentless Sessions. */
    async assignerSessionOf(sessionId) {
        return assignerSessionOf(this.options.tasks, sessionId);
    }
    /** @see listDispatchedTasks — the read itself lives beside the other pure graph reads. */
    async listDispatched(assignerSessionIds, limit = 200) {
        return listDispatchedTasks(this.options, assignerSessionIds, limit);
    }
    /** Pass `assignment` when the caller already read it from the task graph. */
    async status(session, known) {
        const assignment = known === undefined ? await this.options.tasks.get(session.sessionId) : (known ?? undefined);
        const status = await this.options.facts.status(session);
        return {
            ...status,
            session,
            ...(assignment ? { assignment } : {}),
            worklineId: this.options.worklines.sessionSpace(session.sessionId),
            artifactCount: (await this.options.assets(session.sessionId)).length,
            projectName: executionLocationLabel(session),
            ...(assignment?.pendingStart ? { state: 'queued' } : {}),
            ...reviewFailed(status.state, assignment),
            ...this.reportPending(session.sessionId, status.state, assignment),
            ...this.reviewing(session.sessionId, status.state, assignment),
            ...verdictStatus(assignment),
            ...(!assignment?.pendingStart && status.state === 'running'
                ? {
                    activity: await this.activity?.current(session.sessionId),
                    // A question waiting for the user is never a stall.
                    ...(status.pendingQuestionCount
                        ? {}
                        : stalled(this.activity?.stallReason(session.sessionId))),
                }
                : {}),
        };
    }
    /** The round is over but its report has not reached the assigner yet. */
    reportPending(sessionId, state, assignment) {
        if (assignment?.completion || state !== 'completed')
            return {};
        return this.reports?.awaiting(sessionId) ? { reportPending: true } : {};
    }
    /**
     * Bunny is still checking the round that finished or failed (the status
     * table's 核对中): its report is on the way, a review of the finished round is
     * open, or Bunny's Turn handles the failed round's error. Never once the task
     * is closed, queued, or its review gave up.
     */
    reviewing(sessionId, state, assignment) {
        if (!endedOpenRound(state, assignment))
            return {};
        // A finished round's review is on the task; one that gave up reads as review_failed.
        if (state === 'completed' && (assignment.review || assignment.reviewError))
            return assignment.review ? { reviewing: true } : {};
        return this.reports?.reviewing(sessionId) ? { reviewing: true } : {};
    }
    assignmentModel(input, caller) {
        return this.options.taskModel
            ? this.options.taskModel(caller.agentName, input.model)
            : input.model;
    }
    /**
     * The task model, checked before any directory or session exists: a model the
     * Runtime cannot resolve fails the create instead of a task that fails on its
     * first turn. Resolution only; no model request is sent.
     */
    async checkedModel(input, caller) {
        const model = await this.assignmentModel(input, caller);
        if (!model || !this.options.checkModel)
            return model;
        try {
            await this.options.checkModel(model);
        }
        catch (error) {
            const key = `${model.providerId ?? '?'}/${model.modelId ?? '?'}`;
            const reason = error instanceof Error ? error.message : String(error);
            throw Object.assign(new Error(assignmentModelUnavailable(key, reason)), {
                code: 'ASSIGNMENT_MODEL_INVALID',
            });
        }
        return model;
    }
    /**
     * The gate link this dispatch would install, with every check that can refuse it already
     * run, or nothing when the gate is off or this is not a review dispatch.
     *
     * Called before the create touches the disk: a refusal after `stopTakenOver` would leave the
     * task a `takes_over` dispatch named stopped and closed, with nothing to show for it.
     */
    async verdictLinkOf(input, caller, gateOn) {
        if (!input.reviewOf || !gateOn)
            return undefined;
        return {
            reviewOf: input.reviewOf,
            reportKey: await this.verdictWiring.checkVerdictReview(caller, input.reviewOf),
        };
    }
    async createSession(input) {
        // Checked before any session or workspace side effect.
        const caller = await this.requireAssigner(input.callerSessionId);
        await requireReadableAttachments(input.attachments, input.callerTurnId, (turnId) => this.options.facts.messages(input.callerSessionId, turnId));
        const existing = await this.replay(input);
        if (existing)
            return this.accepted(existing.session, existing.assignment, true);
        const original = await this.takeoverOriginal(input.takesOver);
        const sessionId = `mvs_${randomUUID().replaceAll('-', '')}`;
        const spaceId = await this.routeSpace(this.successorSpace(input.space, original));
        const model = await this.checkedModel(input, caller);
        // A dispatched review that the gate would refuse is refused here, with the other checks:
        // by this point a `takes_over` dispatch has not stopped anything yet, so a checked task
        // with no finished round fails the create instead of leaving the user with a failed
        // dispatch and a task that is no longer running.
        // Read once: the gate link and the first message's contract must agree across the awaits.
        const verdictGate = this.verdictWiring.verdictGateOn();
        const verdictLink = await this.verdictLinkOf(input, caller, verdictGate);
        const attachments = await taskAttachmentPaths(input.attachments, input.callerTurnId, (turnId) => this.options.facts.messages(input.callerSessionId, turnId));
        // Every check that can refuse the create has run: only now touch the disk.
        const location = await this.executionLocation(input, spaceId, sessionId);
        await this.stopTakenOver(original, location.claim);
        const queued = await this.queue.isFull();
        // Read before the task record exists: a review dispatch carries what the checked task
        // recorded about itself into this task's first message.
        const reviewTarget = input.reviewOf
            ? await readReviewTarget(this.options, {
                reviewOf: input.reviewOf,
                callerSessionId: input.callerSessionId,
                ...(input.callerTurnId ? { callerTurnId: input.callerTurnId } : {}),
            })
            : undefined;
        const instruction = taskInstruction(input, reviewTarget, verdictGate);
        const assignment = this.createdAssignment(caller, input, queued, { attachments, instruction });
        const created = await this.recordSession(input, sessionId, location, model);
        let session = created;
        let locationHint;
        try {
            ({ session, hint: locationHint } = await this.enterSubPath(created, location.subPath));
            const queuePosition = queued ? await this.queue.position() : undefined;
            const link = spaceLinkOf(input, spaceId, Boolean(location.project), queuePosition);
            // Task and space link commit together: no task is ever left without its space.
            await this.options.tasks.openInSpace(session.sessionId, assignment, spaceId, link);
            // A dispatched review gates the task it checks, before anything can conclude it. Every
            // check that could refuse it ran above, before the disk was touched.
            if (verdictLink)
                await this.verdictWiring.linkVerdictReview(verdictLink.reviewOf, session.sessionId, verdictLink.reportKey);
            // The original closes before its successor starts, so the two never run at once.
            await this.closeTakenOver(original, session.sessionId);
            // A queued task starts from `pendingStart`, which keeps these files for it.
            if (!queued)
                await this.queue.submit(session, instruction, caller, attachments);
        }
        catch (error) {
            // An unadmitted fresh conversation must not become a successful request-id replay.
            try {
                await this.options.conversation.lifecycle.deleteSession(session.sessionId);
            }
            finally {
                await releaseExecutionLocation(location.claim, this.options.logger);
            }
            throw error;
        }
        this.mark(session.sessionId);
        return acceptedWith(await this.accepted(session, assignment, false), locationHint, attachments);
    }
    createdAssignment(caller, input, queued, start) {
        const { attachments, instruction } = start;
        return {
            ...this.makeAssignment(caller, {
                via: 'create',
                reportBack: input.reportBack !== false,
                requestId: input.requestId,
            }),
            goal: input.content,
            doneWhen: input.doneWhen,
            userWords: input.userWords,
            ...(input.originChannel ? { originChannel: originChannelColumn(input.originChannel) } : {}),
            ...(input.reviewOf ? { reviewOf: { ...input.reviewOf } } : {}),
            ...(queued
                ? {
                    pendingStart: {
                        content: instruction,
                        queuedAt: this.options.nowMs(),
                        ...(attachments.length ? { attachments: [...attachments] } : {}),
                    },
                }
                : {}),
        };
    }
    /** Creates the task conversation; a failed create gives back what this call put on disk. */
    async recordSession(input, sessionId, location, model) {
        const { project, workspaceDir, runLocation } = location;
        try {
            return await this.options.records.createSession({
                sessionId,
                agentName: input.agent ?? 'mavis',
                workspaceDir,
                // The space directory is allocated here, not by the caller: keep its identity.
                isDefaultWorkspace: !project,
                preserveDefaultWorkspaceIdentity: true,
                // The task may run in a directory inside the Project: record the Project itself so
                // that directory is never registered as a Project of its own.
                ...(project ? { projectWorkspaceDir: project.projectDir } : {}),
                ...(runLocation ? { runLocation, appMode: 'coding' } : {}),
                title: input.title,
                sessionKind: 'conversation',
                parentSessionId: null,
                // The task graph owns the assigner link; a Session-only reader (the TUI's
                // delegation view) has no other way back to the coordinator that owns this
                // task, so the dispatch records it on the Session record too.
                purpose: createBunnyAssignmentPurpose(input.callerSessionId),
                visibility: project ? 'visible' : 'hidden',
                ...(model ? { model } : {}),
            });
        }
        catch (error) {
            await releaseExecutionLocation(location.claim, this.options.logger);
            throw error;
        }
    }
    /**
     * Every task names its space (id or exact name), which must exist; a successor that names none
     * keeps its original's. The space the user has open never decides it (R3.6).
     */
    async routeSpace(named) {
        const spaces = await this.options.worklines.list();
        const wanted = named?.trim();
        if (!wanted)
            throw Object.assign(new Error(assignmentSpaceRequired(spaces)), {
                code: 'ASSIGNMENT_SPACE_REQUIRED',
            });
        const match = spaces.find((item) => item.id === wanted) ?? spaces.find((item) => item.name === wanted);
        if (!match)
            throw Object.assign(new Error(assignmentSpaceNotFound(wanted, spaces)), {
                code: 'ASSIGNMENT_INVALID_SPACE',
            });
        return match.id;
    }
    /**
     * Where a new task runs. A task that names a project works in the project and leaves
     * `artifacts/<sid8>-<slug>.link.json` pointing at it; a task that names none works in the
     * directory this Runtime was started in, and only a Runtime without a working directory of
     * its own falls back to `artifacts/<sid8>-<slug>/` of its space. The claim lists what this
     * call created, for a failed create to give back.
     */
    async executionLocation(input, spaceId, sessionId) {
        const project = await this.executionProject(input.project);
        if (!project && input.worktree === true)
            throw new Error('A worktree requires a Git project');
        const taskEntry = path.join(this.options.worklines.directory(spaceId), SPACE_ARTIFACTS_DIR, assignmentEntryName(sessionId, input.title));
        if (!project) {
            const claim = { createdDirs: await claimDirectory(taskEntry) };
            return {
                project,
                workspaceDir: taskEntry,
                runLocation: undefined,
                subPath: undefined,
                claim,
            };
        }
        const start = await projectStart(project.directory, input.worktree === true, this.options.nowMs());
        const link = await claimFile(`${taskEntry}.link.json`, assignmentLink({
            sessionId,
            title: input.title,
            path: project.directory,
            runLocation: start.runLocation?.mode ?? 'current',
            createdAtMs: this.options.nowMs(),
        }));
        return { project, ...start, claim: mergeClaims(start.claim, link) };
    }
    executionProject(reference) {
        const normalized = reference?.trim();
        if (normalized === 'default')
            return Promise.resolve(undefined);
        return normalized === undefined ? this.defaultProject() : this.project(normalized);
    }
    defaultProject() {
        return defaultProjectOf(this.options.workingDirectory?.(), this.options.internalDirectories?.());
    }
    /**
     * A worktree is made at the repository root; a task asked to run in a directory
     * inside the repository then starts at the same directory inside its worktree.
     * The project and the worktree stay recorded under the repository root. The
     * worktree checks out HEAD, so a directory that exists only in uncommitted work
     * is absent there: the task then starts at the worktree root and is told why.
     */
    async enterSubPath(session, subPath) {
        if (!subPath)
            return { session };
        const dir = path.join(session.workspaceDir, subPath);
        if (!(await isDirectory(dir)))
            return {
                session,
                hint: worktreeSubPathMissing(subPath),
            };
        const updated = await this.options.sessions.update(session.sessionId, { workspaceDir: dir });
        if (!updated)
            throw new Error('Assignment target was deleted');
        return { session: updated };
    }
    async replay(input) {
        if (!input.requestId)
            return undefined;
        const [task] = await this.options.tasks.list({
            request: { assignerSessionId: input.callerSessionId, requestId: input.requestId },
        });
        const session = task && (await this.options.sessions.get(task.sessionId));
        return session ? { session, assignment: task.assignment } : undefined;
    }
    async accepted(session, assignment, reused) {
        const id = this.options.worklines.sessionSpace(session.sessionId);
        const space = id && (await this.options.worklines.list()).find((item) => item.id === id);
        const label = executionLocationLabel(session);
        return {
            // A task whose space was deleted since it was dispatched belongs to none.
            ...(id ? { space: { id, name: space ? space.name : id } } : {}),
            executionLocation: { directory: session.workspaceDir, label },
            sessionId: session.sessionId,
            title: session.title ?? '',
            projectDir: projectDirectoryOf(session),
            projectName: session.isDefaultWorkspace
                ? 'default'
                : path.basename(projectDirectoryOf(session)),
            worklineId: this.options.worklines.sessionSpace(session.sessionId),
            ...(assignment.pendingStart ? { queued: true } : {}),
            agentName: session.agentName,
            status: 'accepted',
            reused,
            reportBack: assignment.reportBack === true,
        };
    }
    /**
     * Only Bunny's own conversations assign tasks; every task row is written for
     * one of them. Bunny's task tree has two levels: a task, even one run by the
     * Bunny agent, never assigns further work; its own sub-agents stay available.
     */
    async requireAssigner(callerSessionId) {
        const caller = await this.require(callerSessionId);
        const isTask = (await this.options.tasks.get(caller.sessionId)) !== undefined;
        assertBunnyAssigner(caller, isTask, BUNNY_AGENT_NAME);
        return caller;
    }
    /** The assigner facts of a new round; the caller is a checked Bunny conversation. */
    makeAssignment(caller, input) {
        const { via, reportBack, requestId } = input;
        return {
            assignerSessionId: caller.sessionId,
            assignerAgentName: caller.agentName,
            assignerWasRoot: caller.sessionType === 'root',
            reportBack,
            assignedAt: this.options.nowMs(),
            via,
            depth: 1,
            ...(requestId ? { requestId, requestAssignerSessionId: caller.sessionId } : {}),
        };
    }
    async origin(caller, via) {
        return {
            assignment: {
                assignerSessionId: caller.sessionId,
                assignerAgentName: caller.agentName,
                assignerDisplayName: await this.options.agents.displayName(caller.agentName),
                via,
            },
        };
    }
    async require(id) {
        const session = await this.options.sessions.get(id);
        if (!session || session.archived)
            throw new Error(`Session is missing or archived: ${id}`);
        return session;
    }
}
//# sourceMappingURL=assignment.service.js.map