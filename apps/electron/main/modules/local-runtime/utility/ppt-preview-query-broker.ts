import { randomUUID } from "node:crypto";
import { isSafeBrokerRequestId } from "./control";
export function isPptPreviewSessionId(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 512 &&
        value.trim() === value &&
        !value.includes('\0'));
}
/** Main binds every read to the exact Utility generation that accepted it. */
export class MainPptPreviewQueryClient {
    constructor() {
        this.pending = new Map();
        this.proposals = new Map();
    }
    proposeEdits(target, input, signal) {
        if (!isPptPreviewSessionId(input.sessionId) || JSON.stringify(input).length > 100000)
            return Promise.reject(new Error('invalid_request'));
        return new Promise((resolve, reject) => {
            const requestId = randomUUID();
            const timer = setTimeout(() => {
                this.proposals.delete(requestId);
                reject(new Error('proposal_failed'));
            }, 95000);
            const abort = () => {
                const pending = this.proposals.get(requestId);
                if (!pending)
                    return;
                this.proposals.delete(requestId);
                clearTimeout(timer);
                pending.cleanup();
                try {
                    target.postMessage({ type: 'ppt-edit-proposal-cancel', requestId });
                }
                catch {
                    /* Runtime closed. */
                }
                reject(new Error('cancelled'));
            };
            this.proposals.set(requestId, {
                target,
                timer,
                resolve,
                reject,
                cleanup: () => signal?.removeEventListener('abort', abort),
            });
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) {
                abort();
                return;
            }
            try {
                target.postMessage({ type: 'ppt-edit-proposal', requestId, input });
            }
            catch {
                clearTimeout(timer);
                this.proposals.delete(requestId);
                reject(new Error('proposal_failed'));
            }
        });
    }
    listArtifacts(target, sessionId) {
        if (!isPptPreviewSessionId(sessionId))
            return Promise.reject(new Error('Invalid PPT session'));
        return new Promise((resolve, reject) => {
            const requestId = randomUUID();
            const timer = setTimeout(() => this.fail(requestId, 'PPT preview query timed out'), 10000);
            this.pending.set(requestId, { target, sessionId, timer, resolve, reject });
            try {
                target.postMessage({ type: 'ppt-preview-query', requestId, sessionId });
            }
            catch {
                this.fail(requestId, 'PPT preview query connection closed');
            }
        });
    }
    handleMessage(target, raw) {
        if (raw &&
            typeof raw === 'object' &&
            'type' in raw &&
            raw.type === 'ppt-edit-proposal-result') {
            const result = raw;
            if (!isSafeBrokerRequestId(result.requestId))
                return true;
            const pending = this.proposals.get(result.requestId);
            if (!pending || pending.target !== target)
                return true;
            this.proposals.delete(result.requestId);
            clearTimeout(pending.timer);
            pending.cleanup();
            if (typeof result.text === 'string' && result.text.length <= 100000 && !result.error)
                pending.resolve(result.text);
            else
                pending.reject(new Error('proposal_failed'));
            return true;
        }
        if (!raw ||
            typeof raw !== 'object' ||
            !('type' in raw) ||
            raw.type !== 'ppt-preview-query-result')
            return false;
        const result = raw;
        if (!isSafeBrokerRequestId(result.requestId))
            return true;
        const pending = this.pending.get(result.requestId);
        if (!pending || pending.target !== target)
            return true;
        if (typeof result.error === 'string')
            this.fail(result.requestId, result.error);
        else if (!Array.isArray(result.artifacts) ||
            !result.artifacts.every((a) => a &&
                typeof a === 'object' &&
                a.sessionId === pending.sessionId &&
                typeof a.artifactId === 'string')) {
            this.fail(result.requestId, 'Invalid PPT preview query result');
        }
        else {
            this.pending.delete(result.requestId);
            clearTimeout(pending.timer);
            pending.resolve(result.artifacts);
        }
        return true;
    }
    releaseTarget(target) {
        for (const [id, pending] of this.proposals)
            if (pending.target === target) {
                clearTimeout(pending.timer);
                pending.cleanup();
                this.proposals.delete(id);
                pending.reject(new Error('proposal_failed'));
            }
        for (const [id, pending] of this.pending)
            if (pending.target === target)
                this.fail(id, 'PPT preview runtime stopped');
    }
    fail(id, message) {
        const pending = this.pending.get(id);
        if (!pending)
            return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new Error(message));
    }
}

/** Only a session list can cross this channel; there is no publication action payload. */
export class UtilityPptPreviewQueryServer {
    constructor(send) {
        this.send = send;
        this.proposals = new Map();
    }
    bind(reader) {
        this.reader = reader;
    }
    close() {
        for (const controller of this.proposals.values())
            controller.abort();
        this.proposals.clear();
        this.reader = undefined;
    }
    reply(message) {
        try {
            this.send(message);
        }
        catch {
            /* Parent channel already closed. */
        }
    }
    handleMessage(raw) {
        if (raw &&
            typeof raw === 'object' &&
            'type' in raw &&
            raw.type === 'ppt-edit-proposal-cancel') {
            const request = raw;
            if (isSafeBrokerRequestId(request.requestId))
                this.proposals.get(request.requestId)?.abort();
            return true;
        }
        if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'ppt-edit-proposal') {
            const request = raw;
            if (!isSafeBrokerRequestId(request.requestId))
                return true;
            const requestId = request.requestId;
            const reader = this.reader;
            const input = request.input;
            if (!reader?.proposeEdits ||
                !input ||
                !isPptPreviewSessionId(input.sessionId) ||
                typeof input.instruction !== 'string' ||
                input.instruction.length > 8192 ||
                !Array.isArray(input.targets) ||
                input.targets.length > 100 ||
                JSON.stringify(input).length > 100000) {
                this.reply({ type: 'ppt-edit-proposal-result', requestId, error: 'invalid_request' });
                return true;
            }
            const controller = new AbortController();
            this.proposals.set(requestId, controller);
            void reader
                .proposeEdits(input, controller.signal)
                .then((text) => {
                if (this.reader === reader)
                    this.reply({ type: 'ppt-edit-proposal-result', requestId, text });
            }, () => {
                if (this.reader === reader)
                    this.reply({ type: 'ppt-edit-proposal-result', requestId, error: 'proposal_failed' });
            })
                .finally(() => this.proposals.delete(requestId));
            return true;
        }
        if (!raw || typeof raw !== 'object' || !('type' in raw) || raw.type !== 'ppt-preview-query')
            return false;
        const request = raw;
        if (!isSafeBrokerRequestId(request.requestId))
            return true;
        const requestId = request.requestId;
        const reader = this.reader;
        if (!reader ||
            !isPptPreviewSessionId(request.sessionId) ||
            Object.keys(request).some((k) => !['type', 'requestId', 'sessionId'].includes(k))) {
            this.reply({
                type: 'ppt-preview-query-result',
                requestId,
                error: 'Invalid or unavailable PPT preview query',
            });
            return true;
        }
        void reader.listArtifacts(request.sessionId).then((artifacts) => {
            if (this.reader === reader)
                this.reply({ type: 'ppt-preview-query-result', requestId, artifacts });
        }, () => {
            if (this.reader === reader)
                this.reply({
                    type: 'ppt-preview-query-result',
                    requestId,
                    error: 'PPT preview query failed',
                });
        });
        return true;
    }
}

