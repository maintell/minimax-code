import { logger } from '@mavis/shared/local-runtime-logging';
import { parseAgentShellPreference, selectAgentShell, } from './contracts.js';
const PREFERENCE_KEY = 'agent-command-shell-preference';
const DISCOVERY_TTL_MS = 30_000;
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
/** Profile-local discovery and session bindings; never changes shell on command failure. */
export class AgentShellService {
    options;
    sessions;
    preferenceOperation = Promise.resolve();
    sessionOperation = Promise.resolve();
    discovery;
    warming;
    discovered;
    nowMs;
    constructor(options) {
        this.options = options;
        this.nowMs = options.nowMs ?? Date.now;
    }
    bindSessions(sessions) {
        this.sessions = sessions;
    }
    /** Only caches discovery; no background Session writes or preference mutations. */
    warmup() {
        if (this.options.platform !== 'win32' || this.warming)
            return;
        this.warming = this.warmupDiscovery();
    }
    async warmupDiscovery() {
        try {
            await this.discover();
        }
        catch {
            logger.warn({}, '[agent-shell] background discovery failed; Bash can retry');
        }
        finally {
            this.warming = undefined;
        }
    }
    async readPreference() {
        const raw = await this.options.preferences.get(PREFERENCE_KEY);
        return raw === undefined || raw === null ? 'auto' : parseAgentShellPreference(raw);
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
        let preference = await this.readPreference();
        if (this.options.platform !== 'win32')
            return { supported: false, preference, candidates: [] };
        const candidates = await this.discover(refresh);
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
            return {
                ...status,
                preference: resolvedPreference,
                effective: selectAgentShell(resolvedPreference, status.candidates),
            };
        });
    }
    /** Freeze selection intent at creation, even when discovery has not completed yet. */
    async captureNew(parentSessionId) {
        if (this.options.platform !== 'win32')
            return {};
        if (parentSessionId) {
            const agentShell = await this.resolveSession(parentSessionId);
            return {
                agentShellPreference: await this.readSessionPreference(parentSessionId),
                ...(agentShell ? { agentShell } : {}),
            };
        }
        this.warmup();
        // Do not queue behind status()/setPreference(), which may be waiting for a probe.
        // The committed preference at this read is the new Session's immutable intent.
        const agentShellPreference = await this.readPreference();
        const agentShell = this.capture(agentShellPreference, this.cachedCandidates() ?? []);
        return { agentShellPreference, ...(agentShell ? { agentShell } : {}) };
    }
    /** Chat/preparation never joins discovery or a Bash wait, including another Session's wait. */
    async resolveSession(sessionId) {
        if (this.options.platform !== 'win32')
            return undefined;
        const shell = await this.serializeSession(() => this.resolveStoredSession(sessionId));
        if (!shell)
            this.warmup();
        return shell;
    }
    /** Bash-only barrier, before permission parsing. Waiting happens outside the binding lock. */
    async ensureSession(sessionId) {
        if (this.options.platform !== 'win32')
            return undefined;
        const shell = await this.serializeSession(() => this.resolveStoredSession(sessionId));
        if (shell)
            return shell;
        let candidates;
        try {
            candidates = await this.discover();
        }
        catch (error) {
            if (error instanceof AgentShellDetectionError)
                return undefined;
            throw error;
        }
        // Re-read under the short lock: a sibling may already have bound the ancestor.
        return this.serializeSession(() => this.resolveStoredSession(sessionId, new Set(), candidates));
    }
    cachedCandidates() {
        return this.discovered && this.discovered.expiresAt > this.nowMs()
            ? this.discovered.candidates
            : undefined;
    }
    discover(refresh = false) {
        if (this.discovery)
            return this.discovery;
        const cached = this.cachedCandidates();
        if (!refresh && cached)
            return Promise.resolve(cached);
        this.discovery = this.runDiscovery();
        return this.discovery;
    }
    async runDiscovery() {
        // Publish the in-flight promise before invoking even a synchronously throwing detector.
        await Promise.resolve();
        try {
            const candidates = await this.options.detector.detect();
            this.discovered = {
                candidates,
                expiresAt: this.nowMs() + (candidates.some((item) => item.available) ? DISCOVERY_TTL_MS : 0),
            };
            return candidates;
        }
        catch (error) {
            this.discovered = undefined;
            throw new AgentShellDetectionError('AGENT_SHELL_DETECTION_FAILED', { cause: error });
        }
        finally {
            this.discovery = undefined;
        }
    }
    async serializeSession(operation) {
        const previous = this.sessionOperation;
        let release;
        this.sessionOperation = new Promise((resolve) => {
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
    /** Actual execution still validates the fixed binary; failure never selects another shell. */
    async resolveForExecution(sessionId) {
        if (this.options.platform !== 'win32')
            return undefined;
        const shell = await this.ensureSession(sessionId);
        if (!shell)
            throw new Error('AGENT_SHELL_UNAVAILABLE: install PowerShell or Git for Windows');
        let candidate;
        try {
            candidate = await this.options.detector.validate(shell);
        }
        catch {
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
    async requireSession(sessionId) {
        if (!this.sessions)
            throw new Error('AGENT_SHELL_UNAVAILABLE: session owner is not ready');
        const session = await this.sessions.get(sessionId);
        if (!session)
            throw new Error('AGENT_SHELL_SESSION_NOT_FOUND');
        return session;
    }
    async readSessionPreference(sessionId, ancestors = new Set()) {
        if (ancestors.has(sessionId) || ancestors.size >= 64)
            throw new Error('AGENT_SHELL_INVALID_SESSION_ANCESTRY');
        const session = await this.requireSession(sessionId);
        if (session.agentShell)
            return session.agentShell.requestedPreference;
        if (session.parentSessionId)
            return this.readSessionPreference(session.parentSessionId, new Set([...ancestors, sessionId]));
        return session.agentShellPreference ?? 'auto';
    }
    async resolveStoredSession(sessionId, ancestors = new Set(), candidates = this.cachedCandidates()) {
        if (ancestors.has(sessionId) || ancestors.size >= 64)
            throw new Error('AGENT_SHELL_INVALID_SESSION_ANCESTRY');
        const session = await this.requireSession(sessionId);
        if (session.agentShell)
            return session.agentShell;
        const shell = session.parentSessionId
            ? await this.resolveStoredSession(session.parentSessionId, new Set([...ancestors, sessionId]), candidates)
            : this.capture(session.agentShellPreference ?? 'auto', candidates ?? []);
        if (!shell)
            return undefined;
        await this.sessions.save(sessionId, shell);
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