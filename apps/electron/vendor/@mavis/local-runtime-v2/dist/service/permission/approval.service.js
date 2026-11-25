import { logger } from '../../infra/logging/logger.js';
import { localPermissionRuleToolName } from './host-rules.js';
import { serializePermissionRequest } from './request-contracts.js';
import { makeId } from '../../infra/transport/host-http.js';
import { emitAskReplyMetric, emitAskShownMetric, emitAskWaitMetric, } from './approval/permission-metrics.js';
import { findPendingLocalPermissionRequest, } from './approval/permission-request-helpers.js';
export class LocalPermissionApprovalService {
    deps;
    pendingPermissionRequests = new Map();
    requestStates = new Map();
    origins = new Map();
    /**
     * Metrics-only Session kind per pending request, supplied by the caller at
     * begin. The shown, reply and wait metrics all read this one entry, so one
     * card never carries two kinds; an ask without it reports `unknown`.
     */
    sessionKinds = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    begin(input, signal) {
        const existing = findPendingLocalPermissionRequest(this.pendingPermissionRequests, input);
        if (existing) {
            logger.info({
                request_id: existing.requestId,
                session_id: input.sessionId,
                lifecycle: 'deduped',
                pending_count: this.pendingPermissionRequests.size,
            }, 'permission.lifecycle');
            return { requestId: existing.requestId, promise: this.attachWaiter(existing, signal) };
        }
        const requestId = makeId('perm');
        const record = {
            requestId,
            ...askFields(input),
            sessionId: input.sessionId,
            turnId: input.turnId,
            agentName: input.agentName || this.deps.agentName,
            toolName: input.toolName,
            ruleContents: [...input.ruleContents],
            toolDescription: input.toolDescription ?? input.toolName,
            ...ptcRequestFields(input),
            reason: input.reason,
            createdAt: this.deps.nowMs(),
            waiters: new Set(),
            resolve: (decision) => {
                if (this.claim(record))
                    this.settle(record, decision);
            },
            cleanup: () => {
                for (const waiter of [...record.waiters])
                    waiter.detach();
            },
        };
        this.pendingPermissionRequests.set(requestId, record);
        this.requestStates.set(requestId, 'pending');
        this.origins.set(requestId, input.origin);
        if (input.sessionKind)
            this.sessionKinds.set(requestId, input.sessionKind);
        const promise = this.attachWaiter(record, signal);
        // An already-aborted signal removes the record before this point.
        if (this.pendingPermissionRequests.has(requestId)) {
            this.announce(record, input.permissionMode);
        }
        logger.info({
            request_id: requestId,
            session_id: record.sessionId,
            lifecycle: 'created',
            pending_count: this.pendingPermissionRequests.size,
            waiter_count: record.waiters.size,
            origin: input.origin?.platform ?? 'local',
        }, 'permission.lifecycle');
        return { requestId, promise };
    }
    listPending() {
        return [...this.pendingPermissionRequests.values()].map((record) => serializePermissionRequest(record));
    }
    async reply(requestIds, decision) {
        const processed = [];
        const skipped = [];
        for (const requestId of requestIds) {
            const record = this.pendingPermissionRequests.get(requestId);
            if (!record || !this.claim(record)) {
                skipped.push(requestId);
                logger.info({
                    request_id: requestId,
                    session_id: record?.sessionId ?? 'unknown',
                    decision,
                    result: 'skipped',
                }, 'permission.skipped');
                continue;
            }
            try {
                await this.persistReplyRules(record, decision);
                emitAskReplyMetric(this.deps.metricsClient, decision, this.sessionKinds.get(requestId));
                if (record.announced)
                    this.emitWait(record, 'replied');
                this.settle(record, decision);
                processed.push(requestId);
                logger.info({
                    request_id: requestId,
                    session_id: record.sessionId,
                    tool_name: record.toolName,
                    decision,
                    decision_source: 'user_reply',
                    result: 'processed',
                }, 'permission.processed');
            }
            catch (error) {
                logger.error({
                    request_id: requestId,
                    session_id: record.sessionId,
                    lifecycle: 'persistence_failed',
                    error: error instanceof Error ? error.message : String(error),
                }, 'permission.lifecycle');
                this.settle(record, 'deny');
            }
        }
        return { processed, skipped };
    }
    async persistReplyRules(record, decision) {
        let ruleContents = record.ruleContents;
        if (ruleContents.length === 0 && record.persistWholeToolRuleOnReply)
            ruleContents = ['*'];
        if (ruleContents.length === 0)
            return;
        const global = decision === 'allowAlways';
        const persistenceSource = global ? 'global' : 'session';
        const fields = {
            request_id: record.requestId,
            session_id: record.sessionId,
            source: persistenceSource,
            rule_count: ruleContents.length,
        };
        logger.info({ ...fields, lifecycle: 'rule_persist_start' }, 'permission.lifecycle');
        await this.deps.permissionRules.applyUpdate({
            type: 'addRules',
            source: persistenceSource,
            destination: global ? 'global' : record.sessionId,
            behavior: decision === 'deny' ? 'deny' : 'allow',
            rules: ruleContents.map((ruleContent, index) => ({
                tool_name: decision === 'deny' ? record.toolName : localPermissionRuleToolName(record.toolName),
                ...(record.ruleMatchers?.[index]
                    ? { matcher: record.ruleMatchers[index] }
                    : { rule_content: ruleContent }),
            })),
        });
        logger.info({ ...fields, lifecycle: 'rule_persisted' }, 'permission.lifecycle');
    }
    dismiss(requestId) {
        const record = this.pendingPermissionRequests.get(requestId);
        if (!record || !this.claim(record)) {
            logger.info({ request_id: requestId, lifecycle: 'dismiss_skipped' }, 'permission.lifecycle');
            return false;
        }
        record.cleanup();
        if (record.announced)
            this.emitWait(record, 'abandoned');
        logger.info({ request_id: requestId, session_id: record.sessionId, lifecycle: 'dismissed' }, 'permission.lifecycle');
        this.settle(record, 'deny');
        return true;
    }
    abortSession(sessionId) {
        let abortedCount = 0;
        for (const record of [...this.pendingPermissionRequests.values()]) {
            if (record.sessionId !== sessionId || !this.claim(record))
                continue;
            abortedCount += 1;
            record.cleanup();
            if (record.announced)
                this.emitWait(record, 'abandoned');
            this.settle(record, 'deny');
        }
        logger.info({ session_id: sessionId, lifecycle: 'session_aborted', aborted_count: abortedCount }, 'permission.lifecycle');
    }
    emitWait(record, outcome) {
        emitAskWaitMetric(this.deps.metricsClient, {
            waitMs: this.deps.nowMs() - record.createdAt,
            toolName: record.toolName,
            outcome,
            sessionKind: this.sessionKinds.get(record.requestId),
        });
    }
    announce(record, permissionMode) {
        record.announced = true;
        const mode = permissionMode ?? this.deps.permissionModeGetter?.() ?? 'default';
        logger.info({
            request_id: record.requestId,
            session_id: record.sessionId,
            tool_name: record.toolName,
            decision: 'ask',
            rule_count: record.ruleContents.length,
        }, 'permission.ask');
        this.deps.publishGlobalEvent({
            type: 'permission.ask',
            payload: serializePermissionRequest(record),
        });
        emitAskShownMetric(this.deps.metricsClient, {
            mode,
            toolName: record.toolName,
            sessionKind: this.sessionKinds.get(record.requestId),
        });
        const outbound = this.deps.channelPermissionOutbound;
        const origin = this.origins.get(record.requestId);
        if (outbound) {
            logger.info({
                request_id: record.requestId,
                session_id: record.sessionId,
                lifecycle: 'channel_dispatch',
            }, 'permission.lifecycle');
            // Fire-and-forget so the ask never waits on IM delivery, but a rejected
            // dispatch must still be observed: otherwise it surfaces as an unhandled
            // rejection and the missing IM card leaves no trace in this lifecycle.
            const dispatch = async () => {
                await this.dispatchPermissionAsk(record, origin, outbound);
            };
            queueMicrotask(dispatch);
        }
    }
    async dispatchPermissionAsk(record, origin, outbound) {
        try {
            await outbound.onPermissionAsk({
                requestId: record.requestId,
                sessionId: record.sessionId,
                agentName: record.agentName,
                ...(origin ? { origin } : {}),
                request: {
                    requestId: record.requestId,
                    sessionId: record.sessionId,
                    agentName: record.agentName,
                    toolName: record.toolName,
                    ...channelToolDescription(record),
                    ...(record.toolInput ? { toolInput: record.toolInput } : {}),
                    reason: record.parentToolCallId ? `来自 PTC：${record.reason}` : record.reason,
                    ruleContents: record.ruleContents,
                    createdAt: record.createdAt,
                },
            });
        }
        catch (error) {
            logger.warn({
                request_id: record.requestId,
                session_id: record.sessionId,
                lifecycle: 'channel_dispatch_failed',
                error: error instanceof Error ? error.message : String(error),
            }, 'permission.lifecycle');
        }
    }
    claim(record) {
        if (this.requestStates.get(record.requestId) !== 'pending')
            return false;
        this.requestStates.set(record.requestId, 'settling');
        return true;
    }
    settle(record, decision) {
        if (this.requestStates.get(record.requestId) !== 'settling')
            return;
        this.requestStates.delete(record.requestId);
        this.pendingPermissionRequests.delete(record.requestId);
        this.origins.delete(record.requestId);
        this.sessionKinds.delete(record.requestId);
        for (const waiter of [...record.waiters])
            waiter.settle(decision);
        logger.info({ request_id: record.requestId, session_id: record.sessionId, decision }, 'permission.resolved');
        this.deps.publishGlobalEvent({
            type: 'permission.resolved',
            payload: { requestId: record.requestId, sessionId: record.sessionId, decision },
        });
    }
    attachWaiter(record, signal) {
        return new Promise((resolve) => {
            let settled = false;
            const detach = () => signal?.removeEventListener('abort', onAbort);
            const waiter = {
                settle: (decision) => {
                    if (settled)
                        return;
                    settled = true;
                    detach();
                    record.waiters.delete(waiter);
                    resolve(decision);
                },
                detach,
            };
            const onAbort = () => {
                waiter.settle('deny');
                if (record.waiters.size === 0 && this.pendingPermissionRequests.has(record.requestId)) {
                    if (record.announced)
                        this.emitWait(record, 'abandoned');
                    record.resolve('deny');
                }
            };
            record.waiters.add(waiter);
            if (signal?.aborted)
                onAbort();
            else
                signal?.addEventListener('abort', onAbort, { once: true });
        });
    }
}
function cloneRuleMatcher(matcher) {
    return {
        ...matcher,
        ...(matcher.kind === 'path' && matcher.actions ? { actions: [...matcher.actions] } : {}),
    };
}
/** Optional fields of an ask, present only when the caller supplied them. */
function askFields(input) {
    return {
        ...(input.requester !== undefined ? { requester: input.requester } : {}),
        ...(input.ruleMatchers ? { ruleMatchers: input.ruleMatchers.map(cloneRuleMatcher) } : {}),
        ...(input.persistWholeToolRuleOnReply
            ? { persistWholeToolRuleOnReply: input.persistWholeToolRuleOnReply }
            : {}),
        ...(input.toolInput ? { toolInput: input.toolInput } : {}),
    };
}
/** Fields present only when the ask comes from a trusted PTC child call. */
function ptcRequestFields(input) {
    return {
        ...(input.parentToolCallId ? { parentToolCallId: input.parentToolCallId } : {}),
        ...(input.parentToolDescription ? { parentToolDescription: input.parentToolDescription } : {}),
        ...(input.stopPtcOnDeny ? { stopPtcOnDeny: true } : {}),
    };
}
/** A PTC child ask names its run_code program on the channel card. */
function channelToolDescription(record) {
    if (record.parentToolDescription) {
        return { toolDescription: `PTC: ${record.parentToolDescription}` };
    }
    return record.toolDescription ? { toolDescription: record.toolDescription } : {};
}
//# sourceMappingURL=approval.service.js.map