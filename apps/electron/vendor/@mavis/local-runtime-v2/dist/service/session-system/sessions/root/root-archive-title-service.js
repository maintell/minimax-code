import { readPromptWithBuiltinFallback } from '../../../agent/index.js';
import { TitleGenerationBudget } from '../title/title-generation-budget.js';
import { archiveTitleSystemPrompt, archivedRootPrefix, ARCHIVE_TITLE_MAX_TOKENS, ARCHIVE_TITLE_PER_MESSAGE_CHAR_CAP, ARCHIVE_TITLE_RECENT_MESSAGE_LIMIT, ARCHIVE_TITLE_TIMEOUT_MS, ARCHIVE_TITLE_SYSTEM_PROMPT_EN_KEY, ARCHIVE_TITLE_SYSTEM_PROMPT_ZH_KEY, buildArchiveTitlePrompts, isArchiveTitleFallback, } from './archived-root-title.js';
import { RootArchiveTitleModelError, } from './root-archive-title-model.js';
export class RootArchiveTitleService {
    options;
    pending = new Map();
    shutdown = new AbortController();
    closePromise;
    constructor(options) {
        this.options = options;
    }
    generate(sessionId, input) {
        const operation = this.startGeneration(sessionId, input);
        if (operation)
            this.pending.set(sessionId, operation);
    }
    async generateArchiveTitle(sessionId, input) {
        const operation = this.startGeneration(sessionId, input);
        if (!operation)
            return;
        this.pending.set(sessionId, operation);
        await operation;
    }
    close() {
        if (this.closePromise)
            return this.closePromise;
        this.shutdown.abort(new DOMException('Archive title service closed', 'AbortError'));
        this.closePromise = this.drain();
        return this.closePromise;
    }
    async drain() {
        await Promise.allSettled([...this.pending.values()]);
    }
    startGeneration(sessionId, input) {
        if (this.shutdown.signal.aborted || input.signal?.aborted)
            return;
        const existing = this.pending.get(sessionId);
        if (existing)
            return existing;
        const budget = new TitleGenerationBudget(ARCHIVE_TITLE_TIMEOUT_MS, [
            this.shutdown.signal,
            ...(input.signal ? [input.signal] : []),
        ]);
        return this.runGeneration(sessionId, input, budget);
    }
    async runGeneration(sessionId, input, budget) {
        try {
            // Admit into pending before any injected code can synchronously fail or re-enter close().
            await Promise.resolve();
            budget.assertActive();
            await this.generateCandidate(sessionId, input, budget);
        }
        catch (error) {
            this.report('model', sessionId, error);
        }
        finally {
            budget.dispose();
            this.pending.delete(sessionId);
        }
    }
    async generateCandidate(sessionId, input, budget) {
        const locale = this.options.locale?.() ?? 'en';
        const session = await this.readEligibleSession(sessionId, input.fallbackName, locale);
        if (!session || budget.remainingMs === 0)
            return;
        const transcript = await this.readTranscript(sessionId);
        if (!transcript || budget.remainingMs === 0)
            return;
        const summary = await this.summarize(session, locale, transcript, budget);
        if (!summary || budget.remainingMs === 0)
            return;
        const finalTitle = `${archivedRootPrefix(locale)}${summary}`;
        if (!(await this.commitTitle(sessionId, { fallbackName: input.fallbackName, locale, title: finalTitle }, budget)))
            return;
        await this.observeFact(sessionId, input.agentName, finalTitle);
    }
    async readEligibleSession(sessionId, fallbackName, locale) {
        try {
            const session = await this.options.sessions.get(sessionId);
            return isEligibleArchiveSession(session, fallbackName, locale) ? session : undefined;
        }
        catch (error) {
            this.report('read', sessionId, error);
            return undefined;
        }
    }
    async readTranscript(sessionId) {
        try {
            const recent = await this.options.messages.listRecent(sessionId, {
                limit: ARCHIVE_TITLE_RECENT_MESSAGE_LIMIT,
            });
            const transcript = buildTranscript(recent);
            return transcript && recent.some(({ role }) => role === 'user') ? transcript : undefined;
        }
        catch (error) {
            this.report('read', sessionId, error);
            return undefined;
        }
    }
    async summarize(session, locale, transcript, budget) {
        try {
            const systemPrompt = await readPromptWithBuiltinFallback({
                source: this.options.promptSnapshots,
                key: locale.split('-')[0]?.toLowerCase() === 'zh'
                    ? ARCHIVE_TITLE_SYSTEM_PROMPT_ZH_KEY
                    : ARCHIVE_TITLE_SYSTEM_PROMPT_EN_KEY,
                builtin: archiveTitleSystemPrompt(locale),
            });
            budget.assertActive();
            return await this.options.model.summarize({
                session,
                ...buildArchiveTitlePrompts(locale, transcript, systemPrompt),
                maxTokens: ARCHIVE_TITLE_MAX_TOKENS,
                timeoutMs: budget.remainingMs,
                deadlineAt: budget.deadlineAt,
                signal: budget.signal,
            });
        }
        catch (error) {
            this.report(error instanceof RootArchiveTitleModelError ? error.stage : 'model', session.sessionId, error);
            return null;
        }
    }
    async commitTitle(sessionId, input, budget) {
        const { fallbackName, locale, title } = input;
        try {
            const fresh = await this.options.sessions.get(sessionId);
            if (budget.remainingMs === 0 || !isEligibleArchiveSession(fresh, fallbackName, locale))
                return false;
            await this.options.sessions.update(sessionId, { title, titleSource: 'auto' });
            return true;
        }
        catch (error) {
            this.report('write', sessionId, error);
            return false;
        }
    }
    async observeFact(sessionId, agentName, title) {
        try {
            await this.options.facts?.observe({ sessionId, agentName, title });
        }
        catch (error) {
            this.report('fact-observer', sessionId, error);
        }
    }
    report(stage, sessionId, error) {
        try {
            this.options.onFailure?.({ stage, sessionId, error });
        }
        catch {
            // Observability remains best effort.
        }
    }
}
function isEligibleArchiveSession(session, fallbackName, locale) {
    return Boolean(session &&
        session.sessionType === 'branch' &&
        session.archived &&
        isArchiveTitleFallback({ title: session.title, fallbackName, locale }));
}
function buildTranscript(messages) {
    return messages
        .filter(({ role }) => role === 'user' || role === 'assistant')
        .map(({ role, content }) => {
        const body = typeof content === 'string'
            ? content.trim().slice(0, ARCHIVE_TITLE_PER_MESSAGE_CHAR_CAP)
            : '';
        return body ? `${role === 'user' ? 'User' : 'Assistant'}: ${body}` : '';
    })
        .filter(Boolean)
        .join('\n\n');
}
//# sourceMappingURL=root-archive-title-service.js.map