import { and, eq, sql } from 'drizzle-orm';
import { KeyedOperationLane } from '@mavis/shared/keyed-operation-lane';
import { sessions } from '../../infra/db/schema/sessions.js';
import { miniAppCreations } from '../../infra/db/schema/miniapp-launchpad.js';
import { creationFromRow, readCreationCapacity, readCreationRecords, readCreationSummaries, readLinkedSessionIds, } from './launchpad-queries.js';
/** Shared Runtime database, partitioned by account and deployment like Plugin state. */
export class MiniAppLaunchpadStore {
    db;
    deployment;
    onChanged;
    lane = new KeyedOperationLane();
    snapshots = new WeakMap();
    constructor(db, deployment, onChanged = () => { }) {
        this.db = db;
        this.deployment = deployment;
        this.onChanged = onChanged;
    }
    /** The existing account lane prevents duplicate hosts on simultaneous opens. */
    ensureHostSession(accountId, create) {
        return this.lane.run(accountId, async () => {
            const purpose = `miniapp-host:${this.deployment}:${accountId}`;
            const existing = this.db
                .select({ id: sessions.sessionId })
                .from(sessions)
                .where(and(eq(sessions.purpose, purpose), sql `${sessions.columnarVersion} = 3 AND ${sessions.archived} = 0 AND ${sessions.visibility} = 'hidden'`))
                .limit(1)
                .get();
            return existing?.id ?? create(purpose);
        });
    }
    async transaction(accountId, selection, operation) {
        return this.lane.run(accountId, async () => operation(await this.read(accountId, selection)));
    }
    async read(accountId, selection) {
        return this.db.transaction((db) => {
            const rows = readCreationRecords(db, accountId, this.deployment, selection);
            const creations = rows.map(creationFromRow);
            const state = {
                creations,
                ...(selection.kind === 'create'
                    ? { capacity: readCreationCapacity(db, accountId, this.deployment) }
                    : {}),
            };
            this.snapshots.set(state, {
                accountId,
                records: new Map(creations.map((item) => [item.id, JSON.stringify(item)])),
            });
            return state;
        });
    }
    async write(accountId, state) {
        const snapshot = this.snapshots.get(state);
        if (!snapshot || snapshot.accountId !== accountId)
            throw new Error('invalid_state');
        const records = new Map((state.creations ?? []).map((item) => [item.id, item]));
        const serialized = new Map([...records].map(([id, item]) => [id, JSON.stringify(item)]));
        const old = snapshot.records;
        if (serialized.size === old.size && [...serialized].every(([id, json]) => old.get(id) === json))
            return;
        this.db.transaction((db) => {
            for (const [id] of old) {
                if (records.has(id))
                    continue;
                db.delete(miniAppCreations).where(this.recordScope(accountId, id)).run();
            }
            for (const [id, item] of records) {
                if (old.get(id) === serialized.get(id))
                    continue;
                const row = { ...creationColumns(item), accountId, deployment: this.deployment };
                db.insert(miniAppCreations)
                    .values(row)
                    .onConflictDoUpdate({
                    target: [miniAppCreations.accountId, miniAppCreations.deployment, miniAppCreations.id],
                    set: row,
                })
                    .run();
            }
        });
        this.snapshots.set(state, { accountId, records: serialized });
        try {
            this.onChanged(accountId);
        }
        catch {
            /* Reconnect/focus reads recover missed events. */
        }
    }
    summaries(accountId) {
        return this.db.transaction((db) => readCreationSummaries(db, accountId, this.deployment));
    }
    linkedSessionIds(accountId, candidates) {
        return readLinkedSessionIds(this.db, accountId, this.deployment, candidates);
    }
    recordScope(accountId, id) {
        return and(eq(miniAppCreations.accountId, accountId), eq(miniAppCreations.deployment, this.deployment), eq(miniAppCreations.id, id));
    }
}
function creationColumns(item) {
    return {
        ...item,
        sessionId: item.sessionId ?? null,
        sourceSessionId: item.sourceSessionId ?? null,
        recommendationId: item.recommendationId ?? null,
        sourceSummary: item.sourceSummary ?? null,
        sourceTitle: item.sourceTitle ?? null,
        sourceCapturedAt: item.sourceCapturedAt ?? null,
        workspaceDir: item.workspaceDir ?? null,
        error: item.error ?? null,
    };
}
//# sourceMappingURL=launchpad-store.service.js.map