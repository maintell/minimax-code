import { BUNNY_AGENT_NAME } from '../../bunny/index.js';
import { settleInBackground } from '../../../infra/async/settle.js';
import { executionLocationLabel } from '../orchestration/execution-location.js';
/** Spec 9.6 / 18.1: Turn assembly waits at most this long for the view. */
const ASSIGNMENT_STATE_READ_CAP_MS = 200;
/**
 * The Session-record inputs `options.status` derives a task's status from: the round's own
 * state (`stateFor`, `terminalState` and `errorOf` in orchestration/status.service.ts, through
 * `stoppedByRestart`) and the project label itself, so whatever `executionLocationLabel` reads
 * enters the fingerprint with it rather than through a copy of its inputs. Every other field of
 * the record rides along in `status.session`, which each read refreshes. A Session field
 * added to the status derivation belongs here too.
 */
function sessionStateFingerprint(session) {
    return JSON.stringify([
        session.status,
        session.errorSource ?? null,
        session.errorMessage ?? null,
        session.agentName,
        executionLocationLabel(session),
    ]);
}
/**
 * The materialized task state Bunny's delta blocks and handoff headers read
 * (spec 9.6). Each task's status is kept from the `assignment.updated`
 * projections, rebuilt from the task graph at startup, for any task the view has
 * not seen yet, and for any task whose Session record moved since its status was
 * derived — a round the app's restart cut off changes the record without
 * publishing a projection. Turn assembly waits at most 200 ms; a slower read returns
 * the previous view and keeps catching up in the background. Before the first
 * full load there is no previous view: the read returns the published tasks
 * marked `partial`, never waiting past the cap.
 */
export class AssignmentStateView {
    options;
    statuses = new Map();
    refreshing;
    last;
    constructor(options) {
        this.options = options;
    }
    /** An `assignment.updated` projection: the task's status as published. */
    observe(status) {
        this.statuses.set(status.session.sessionId, {
            status,
            fingerprint: sessionStateFingerprint(status.session),
        });
    }
    /** Startup: builds every task's status from the task graph in the background. */
    rebuild() {
        settleInBackground(this.settledRefresh());
    }
    /**
     * The current view within the read cap; never throws for a slow or failed
     * refresh. `asOfMs` is the cutoff a handoff header states (spec 9.5).
     */
    async read() {
        const refresh = this.settledRefresh();
        let timer;
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => resolve(undefined), this.options.readCapMs ?? ASSIGNMENT_STATE_READ_CAP_MS);
        });
        try {
            const current = await Promise.race([refresh, timeout]);
            if (current)
                return current;
            return { ...(this.last ?? this.cached()), stale: true };
        }
        finally {
            clearTimeout(timer);
        }
    }
    /** The running refresh, or a new one; resolves undefined when it fails. */
    async settledRefresh() {
        this.refreshing ??= this.loadOnce();
        try {
            return await this.refreshing;
        }
        catch {
            return undefined;
        }
    }
    async loadOnce() {
        try {
            return await this.load();
        }
        finally {
            this.refreshing = undefined;
        }
    }
    async load() {
        const asOfMs = this.options.nowMs();
        const tasks = await this.options.tasks.list({
            assignerAgentName: BUNNY_AGENT_NAME,
            archived: false,
        });
        const records = await Promise.all(tasks.map((task) => this.options.sessions.get(task.sessionId)));
        const live = new Set();
        const statuses = await Promise.all(tasks.map(async ({ assignment }, index) => {
            const session = records[index];
            if (!session || session.archived)
                return undefined;
            live.add(session.sessionId);
            const fingerprint = sessionStateFingerprint(session);
            const known = this.statuses.get(session.sessionId);
            // The task graph owns closure and assignment; the projection owns the live state,
            // but only while the Session record it was derived from still stands. `state` is
            // derived from that record, so one that moved is read again rather than reused.
            if (known && known.fingerprint === fingerprint)
                return { ...known.status, session, assignment };
            // A projection derived from a record newer than the one this read got wins: the
            // record moved on after `sessions.get` resolved, so re-deriving here would compute
            // the status from the older inputs and then overwrite the newer projection with it.
            // The next read sees the current record and settles the difference.
            if (known && known.status.session.updatedAtMs > session.updatedAtMs)
                return { ...known.status, assignment };
            const status = await this.options.status(session, assignment);
            // A projection published while this one was read is newer; the entry this read
            // started from is the one it just found stale, and never wins over the re-read.
            const published = this.statuses.get(session.sessionId);
            if (published && published !== known)
                return published.status;
            this.statuses.set(session.sessionId, { status, fingerprint });
            return status;
        }));
        for (const id of this.statuses.keys())
            if (!live.has(id))
                this.statuses.delete(id);
        const read = {
            tasks: statuses
                .filter((item) => item !== undefined)
                .sort((a, b) => b.session.updatedAtMs - a.session.updatedAtMs),
            stale: false,
            asOfMs,
        };
        this.last = read;
        return read;
    }
    cached() {
        return {
            tasks: [...this.statuses.values()].map((entry) => entry.status),
            stale: true,
            partial: true,
            asOfMs: 0,
        };
    }
}
//# sourceMappingURL=assignment-state-view.js.map