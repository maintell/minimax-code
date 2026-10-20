import { readPromptWithBuiltinFallback } from '../../../agent/index.js';
import { archiveTitleSystemPrompt, archivedRootPrefix, ARCHIVE_TITLE_MAX_TOKENS, ARCHIVE_TITLE_PER_MESSAGE_CHAR_CAP, ARCHIVE_TITLE_RECENT_MESSAGE_LIMIT, ARCHIVE_TITLE_TIMEOUT_MS, ARCHIVE_TITLE_SYSTEM_PROMPT_EN_KEY, ARCHIVE_TITLE_SYSTEM_PROMPT_ZH_KEY, buildArchiveTitlePrompts, isArchiveTitleFallback, } from './archived-root-title.js';
import { RootArchiveTitleModelError, } from './root-archive-title-model.js';
export class RootArchiveTitleService {
    options;
    pending = new Map();
    constructor(options) {
        this.options = options;
    }
    generate(sessionId, input) {
        if (this.pending.has(sessionId))
            return;
        this.pending.set(sessionId, this.runGeneration(sessionId, input));
    }
    async runGeneration(sessionId, input) {
        try {
            await this.generateArchiveTitle(sessionId, input);
        }
        catch (error) {
            this.report('model', sessionId, error);
        }
        finally {
            this.pending.delete(sessionId);
        }
    }
    async generateArchiveTitle(sessionId, input) {
        const locale = this.options.locale?.() ?? 'en';
        const session = await this.readEligibleSession(sessionId, input.fallbackName, locale);
        if (!session)
            return;
        const transcript = await this.readTranscript(sessionId);
        if (!transcript)
            return;
        const summary = await this.summarize(sessionId, session, locale, transcript);
        if (!summary)
            return;
        const finalTitle = `${archivedRootPrefix(locale)}${summary}`;
        if (!(await this.commitTitle(sessionId, input.fallbackName, locale, finalTitle)))
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
    async summarize(sessionId, session, locale, transcript) {
        try {
            const systemPrompt = await readPromptWithBuiltinFallback({
                source: this.options.promptSnapshots,
                key: locale.split('-')[0]?.toLowerCase() === 'zh'
                    ? ARCHIVE_TITLE_SYSTEM_PROMPT_ZH_KEY
                    : ARCHIVE_TITLE_SYSTEM_PROMPT_EN_KEY,
                builtin: archiveTitleSystemPrompt(locale),
            });
            return await this.options.model.summarize({
                session,
                ...buildArchiveTitlePrompts(locale, transcript, systemPrompt),
                maxTokens: ARCHIVE_TITLE_MAX_TOKENS,
                timeoutMs: ARCHIVE_TITLE_TIMEOUT_MS,
            });
        }
        catch (error) {
            this.report(error instanceof RootArchiveTitleModelError ? error.stage : 'model', sessionId, error);
            return null;
        }
    }
    async commitTitle(sessionId, fallbackName, locale, title) {
        try {
            const fresh = await this.options.sessions.get(sessionId);
            if (!isEligibleArchiveSession(fresh, fallbackName, locale))
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