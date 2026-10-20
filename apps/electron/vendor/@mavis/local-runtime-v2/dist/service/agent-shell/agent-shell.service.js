import { logger } from '@mavis/shared/local-runtime-logging';
import { parseAgentShellPreference, selectAgentShell, } from './contracts.js';
const PREFERENCE_KEY = 'agent-command-shell-preference';
/** Expose only bounded reason codes, never probe output or private executable paths. */
function executionFailureReason(candidate) {
    if (candidate?.available)
        return candidate.version ? 'binding-mismatch' : 'unexpected-shell-version';
    switch (candidate?.reason) {
        case 'not-installed':
        case 'not-git-for-windows':
        case 'unexpected-shell-version':
        case 'probe-timed-out':
        case 'probe-access-denied':
            return candidate.reason;
        default:
            return 'probe-failed';
    }
}
/** Only detector failures are recoverable; preference and Session storage errors must propagate. */
class AgentShellDetectionError extends Error {
}
/** Profile-local preference and session bindings; never changes shell on command failure. */
export class AgentShellService {
    options;
    sessions;
    preferenceOperation = Promise.resolve();
    sessionOperation = Promise.resolve();
    discovery;
    pending = new Map();
    nowMs;
    constructor(options) {
        this.options = options;
        this.nowMs = options.nowMs ?? Date.now;
    }
    bindSessions(sessions) {
        this.sessions = sessions;
    }
    async serializePreference(operation) {
        const previous = this.preferenceOperation;
        let release;
        this.preferenceOperation = new Promise((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await operation();
        }
        finally {
            release();
        }
    }
    status(refresh = false) {
        return this.serializePreference(() => this.readStatus(refresh));
    }
    async readStatus(refresh = false) {
        const raw = await this.options.preferences.get(PREFERENCE_KEY);
        let preference = raw === undefined || raw === null ? 'auto' : parseAgentShellPreference(raw);
        if (this.options.platform !== 'win32')
            return { supported: false, preference, candidates: [] };
        if (refresh)
            this.discovery = undefined;
        const candidates = await (this.discovery ??= this.discover());
        if (preference !== 'auto' && !selectAgentShell(preference, candidates)) {
            await this.options.preferences.set(PREFERENCE_KEY, 'auto');
            preference = 'auto';
        }
        const effective = selectAgentShell(preference, candidates);
        return { supported: true, preference, candidates, ...(effective ? { effective } : {}) };
    }
    setPreference(value) {
        return this.serializePreference(async () => {
            if (this.options.platform !== 'win32')
                throw new Error('AGENT_SHELL_UNSUPPORTED_PLATFORM');
            const preference = parseAgentShellPreference(value);
            const status = await this.readStatus(true);
            const resolvedPreference = selectAgentShell(preference, status.candidates)
                ? preference
                : 'auto';
            await this.options.preferences.set(PREFERENCE_KEY, resolvedPreference);
            return this.readStatus();
        });
    }
    async captureNew(parentSessionId) {
        if (this.options.platform !== 'win32')
            return undefined;
        if (parentSessionId)
            return this.resolveSession(parentSessionId);
        return this.captureAvailable();
    }
    /** Read the trusted binding without requiring a running Shell for chat or other tools. */
    resolveSession(sessionId) {
        if (this.options.platform !== 'win32')
            return Promise.resolve(undefined);
        const existing = this.pending.get(sessionId);
        if (existing)
            return existing;
        // Legacy descendants can initialize the same ancestor. Serialize the entire
        // lineage so no concurrent resolver overwrites an already captured snapshot.
        const operation = this.resolveOnce(sessionId);
        this.pending.set(sessionId, operation);
        return operation;
    }
    async discover() {
        try {
            return await this.options.detector.detect();
        }
        catch (error) {
            this.discovery = undefined;
            throw new AgentShellDetectionError('AGENT_SHELL_DETECTION_FAILED', { cause: error });
        }
    }
    async captureAvailable(preference) {
        try {
            const status = await this.status(true);
            return this.capture(preference ?? status.preference, status.candidates);
        }
        catch (error) {
            if (error instanceof AgentShellDetectionError)
                return undefined;
            throw error;
        }
    }
    async resolveOnce(sessionId) {
        const previous = this.sessionOperation;
        let release;
        this.sessionOperation = new Promise((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await this.resolveStoredSession(sessionId);
        }
        finally {
            this.pending.delete(sessionId);
            release();
        }
    }
    /** Probe only at execution. Upgrades are supported; changing family/path is not a fallback. */
    async resolveForExecution(sessionId) {
        if (this.options.platform !== 'win32')
            return undefined;
        const shell = await this.resolveSession(sessionId);
        if (!shell)
            throw new Error('AGENT_SHELL_UNAVAILABLE: install PowerShell or Git for Windows');
        let candidate;
        try {
            candidate = await this.options.detector.validate(shell);
        }
        catch {
            // Probe failures are command-local, just like an unavailable executable.
            candidate = undefined;
        }
        if (!candidate?.available ||
            !candidate.version ||
            candidate.family !== shell.family ||
            candidate.executablePath !== shell.executablePath) {
            const reason = executionFailureReason(candidate);
            logger.warn({ sessionId, family: shell.family, reason }, '[agent-shell] execution shell validation failed');
            throw new Error(`AGENT_SHELL_UNAVAILABLE: ${shell.family} (${reason}); restore the session shell to run commands; conversation and other tools remain available`);
        }
        return { ...shell, version: candidate.version };
    }
    async resolveStoredSession(sessionId, ancestors = new Set()) {
        if (ancestors.has(sessionId) || ancestors.size >= 64)
            throw new Error('AGENT_SHELL_INVALID_SESSION_ANCESTRY');
        const lineage = new Set([...ancestors, sessionId]);
        const sessions = this.sessions;
        if (!sessions)
            throw new Error('AGENT_SHELL_UNAVAILABLE: session owner is not ready');
        const session = await sessions.get(sessionId);
        if (!session)
            throw new Error('AGENT_SHELL_SESSION_NOT_FOUND');
        if (session.agentShell)
            return session.agentShell;
        // Sessions without metadata predate this feature. Preserve the legacy Windows
        // preference rather than applying a newly selected preference on resume.
        const shell = session.parentSessionId
            ? await this.resolveStoredSession(session.parentSessionId, lineage)
            : await this.captureAvailable('auto');
        // Absence is retryable. Never persist a failed probe as a binding or break chat.
        if (!shell)
            return undefined;
        await sessions.save(sessionId, shell);
        return shell;
    }
    capture(preference, candidates) {
        const shell = selectAgentShell(preference, candidates);
        if (!shell?.executablePath || !shell.version)
            return undefined;
        return {
            schemaVersion: 1,
            requestedPreference: preference,
            family: shell.family,
            executablePath: shell.executablePath,
            version: shell.version,
            resolvedAt: this.nowMs(),
        };
    }
}
//# sourceMappingURL=agent-shell.service.js.map