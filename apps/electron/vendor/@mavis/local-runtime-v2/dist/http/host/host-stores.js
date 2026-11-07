import { SqliteQuestionnaireRequestStore } from '../../infra/legacy-db/questionnaire-request-store.js';
import { SqliteLocalCommunicationMessageStore, SqliteLocalTokenUsageStore, SqliteLocalTurnDiffStore, } from '../../infra/legacy-db/sqlite-persistence.js';
import { SqliteLocalCronStore } from '../../service/cron/index.js';
/**
 * Host-owned persistence stores: an injected store wins, otherwise each falls back to its SQLite
 * implementation under the current profile dataDir. Constructors are lazy and open no database.
 */
export function resolveHostStores(options, configGetter, nowMs) {
    const dataDir = configGetter().dataDir;
    return {
        communicationMessageStore: options.communicationMessageStore ?? new SqliteLocalCommunicationMessageStore(dataDir),
        tokenUsageStore: options.tokenUsageStore ?? new SqliteLocalTokenUsageStore(dataDir),
        turnDiffStore: options.turnDiffStore ?? new SqliteLocalTurnDiffStore(dataDir),
        cronStore: options.cronStore ?? new SqliteLocalCronStore(dataDir, nowMs),
        questionnaireStore: options.questionnaireStore ??
            new SqliteQuestionnaireRequestStore(() => configGetter().dataDir),
    };
}
//# sourceMappingURL=host-stores.js.map