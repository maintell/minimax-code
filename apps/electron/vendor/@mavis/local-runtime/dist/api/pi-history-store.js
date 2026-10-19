import { setTimeout as delay } from 'node:timers/promises';
import { LocalSessionLedgerCommitUncertainError, } from '../sessions/ledger/index.js';
import { recordLocalTokenUsageFromPiMessages } from '../usage/api.js';
import { logger } from '../common/logger.js';
import { isTerminalAssistantPiError } from './terminal-assistant-error.js';
const MAX_CANONICAL_WRITE_ATTEMPTS = 3;
const CANONICAL_RETRY_DELAYS_MS = [25, 50];
export const LOCAL_PI_HISTORY_PERSISTENCE_FAILED = 'LOCAL_PI_HISTORY_PERSISTENCE_FAILED';
export class LocalPiHistoryPersistenceError extends Error {
    cause;
    constructor(operation, cause) {
        super(`${LOCAL_PI_HISTORY_PERSISTENCE_FAILED}: ${operation}`);
        this.name = 'LocalPiHistoryPersistenceError';
        this.cause = cause;
    }
}
/**
 * Pi-agent conversation history persistence, extracted from
 * `LocalRuntimeApiHost` to keep that file under the 2000-line source budget.
 * Pure behavioural move — the host retains thin public delegators with the same
 * signatures, so callers are unaffected.
 */
export class LocalPiHistoryStore {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async getPiHistory(sessionId) {
        await this.ensureLegacyMessagesMigrated(sessionId);
        const { ledgerStore, snapshotStore, messageStore, piHistory } = this.deps;
        if (ledgerStore && snapshotStore) {
            const resume = await snapshotStore.readResumeProjection(sessionId, ledgerStore);
            if (resume.piHistoryFacts || resume.projection.piHistory.length > 0) {
                return resume.projection.piHistory;
            }
            const projectedHistory = messageStore
                ? await messageStore.getPiHistory(sessionId)
                : undefined;
            if (projectedHistory && projectedHistory.length > 0)
                return projectedHistory;
            if (resume.source !== 'empty' || resume.projection.watermark)
                return resume.projection.piHistory;
        }
        return messageStore
            ? messageStore.getPiHistory(sessionId)
            : [...(piHistory.get(sessionId) ?? [])];
    }
    async ensureLegacyMessagesMigrated(sessionId) {
        await this.deps.legacyMigrator?.ensureMessagesMigrated(sessionId);
    }
    async appendPiHistory(sessionId, messages, usage) {
        const persistedMessages = messages.filter((message) => !isTerminalAssistantPiError(message));
        if (persistedMessages.length === 0)
            return;
        await this.ensurePiHistoryLedgerSeeded(sessionId);
        await this.persistCanonical(sessionId, 'append', () => this.deps.sessionWriter.appendPiHistory(sessionId, persistedMessages, async () => {
            const history = this.deps.piHistory.get(sessionId) ?? [];
            history.push(...persistedMessages);
            this.deps.piHistory.set(sessionId, history);
        }));
        if (usage) {
            try {
                await recordLocalTokenUsageFromPiMessages({
                    usageStore: this.deps.tokenUsageStore,
                    session: usage.session,
                    turnId: usage.turnId,
                    model: usage.model,
                    nowMs: this.deps.nowMs,
                    messages: persistedMessages,
                });
            }
            catch (error) {
                logger.warn({
                    session_id: sessionId,
                    turn_id: usage.turnId,
                    error_type: error instanceof Error ? error.name : typeof error,
                }, '[local-pi-history] token usage projection failed after canonical history commit');
            }
        }
    }
    async replacePiHistory(sessionId, messages) {
        await this.ensurePiHistoryLedgerSeeded(sessionId);
        await this.persistCanonical(sessionId, 'replace', () => this.deps.sessionWriter.rewindPiHistory(sessionId, messages, async () => {
            this.deps.piHistory.set(sessionId, [...messages]);
        }));
    }
    async ensurePiHistoryLedgerSeeded(sessionId) {
        const { ledgerStore, snapshotStore, messageStore, sessionWriter } = this.deps;
        if (!ledgerStore || !snapshotStore || !messageStore)
            return;
        await this.persistCanonical(sessionId, 'seed', async () => {
            const resume = await snapshotStore.readResumeProjection(sessionId, ledgerStore);
            if (resume.piHistoryFacts)
                return;
            const projectedHistory = await messageStore.getPiHistory(sessionId);
            if (projectedHistory.length === 0)
                return;
            await sessionWriter.importPiHistory(sessionId, projectedHistory);
        });
    }
    async persistCanonical(sessionId, operation, write, attempt = 1) {
        try {
            await write();
        }
        catch (error) {
            const retry = Boolean(this.deps.ledgerStore) &&
                !(error instanceof LocalSessionLedgerCommitUncertainError) &&
                attempt < MAX_CANONICAL_WRITE_ATTEMPTS;
            const fields = {
                session_id: sessionId,
                operation,
                attempt,
                max_attempts: this.deps.ledgerStore ? MAX_CANONICAL_WRITE_ATTEMPTS : 1,
                error_type: error instanceof Error ? error.name : typeof error,
            };
            if (!retry) {
                logger.error(fields, '[local-pi-history] canonical history persistence failed');
                throw new LocalPiHistoryPersistenceError(operation, error);
            }
            logger.warn(fields, '[local-pi-history] retrying canonical history persistence');
            await delay(CANONICAL_RETRY_DELAYS_MS[attempt - 1] ?? 0);
            await this.persistCanonical(sessionId, operation, write, attempt + 1);
        }
    }
}
//# sourceMappingURL=pi-history-store.js.map