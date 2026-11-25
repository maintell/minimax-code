import { isExtensionErrorCode, createExtensionDiagnostic, } from '../sdk/diagnostics.js';
/**
 * Keeps the ExtensionHost's per-session activations equal to the session's entry records: the
 * installed records every session sees, replaced by that session's preview of the same name.
 * A session is synced when its records are first listed and again whenever they change. Host
 * activations are keyed by the full `ActivationIdentity`: identical content switching between
 * installed and preview retires the old activation, since the tier decides which store and MCP
 * servers its calls reach.
 */
export class HostActivationSync {
    host;
    activations;
    dispose;
    withdrawn;
    synced = new Map();
    /** Plugins each session had a record of when last applied. */
    listed = new Map();
    nextEpoch = 0;
    constructor(host, activations, 
    /** Releases timers and subscriptions of a retired activation. */
    dispose, 
    /**
     * The session has no record of the plugin any more. A record replaced by another revision of
     * it, even one that is not compiled, is not this.
     */
    withdrawn) {
        this.host = host;
        this.activations = activations;
        this.dispose = dispose;
        this.withdrawn = withdrawn;
    }
    /**
     * Loads a record's revision and runs its `register` before the record may replace the live
     * one; returns why it could not, as the diagnostic a failed compile would give.
     */
    async prepare(record) {
        if (!record.compiled)
            return undefined;
        const prepared = await this.host.prepare(toActivationInput(record.sessionId ?? '', record));
        if (prepared.ok)
            return undefined;
        if (isExtensionErrorCode(prepared.code)) {
            return { ...createExtensionDiagnostic(prepared.code), message: prepared.message };
        }
        // A load that timed out or lost its Worker: still a revision whose `register` did not finish.
        return createExtensionDiagnostic('EXTENSION_REGISTER_FAILED', {
            detail: `${prepared.code}: ${prepared.message}`,
        });
    }
    list(sessionId) {
        const records = this.activations.list(sessionId);
        this.apply(sessionId, records);
        return records;
    }
    epoch(sessionId, pluginId) {
        return this.synced.get(sessionId)?.get(pluginId)?.epoch;
    }
    /** Re-syncs the sessions the host already serves, or only `sessionId`. */
    refresh(sessionId) {
        const sessions = sessionId === undefined ? [...this.synced.keys()] : [sessionId];
        for (const id of sessions)
            this.apply(id, this.activations.list(id));
    }
    deleteSession(sessionId) {
        for (const identity of this.synced.get(sessionId)?.values() ?? []) {
            this.dispose(sessionId, identity);
        }
        this.synced.delete(sessionId);
        this.listed.delete(sessionId);
        this.host.deleteSession(sessionId);
    }
    apply(sessionId, records) {
        const current = this.synced.get(sessionId) ?? new Map();
        this.retireChanged(sessionId, current, records);
        for (const record of records) {
            const live = current.get(record.pluginId);
            if ((live && sameActivation(live, record)) || !record.compiled)
                continue;
            this.host.activate(toActivationInput(sessionId, record));
            current.set(record.pluginId, { ...identityOf(record), epoch: ++this.nextEpoch });
        }
        this.synced.set(sessionId, current);
        this.noteWithdrawn(sessionId, records);
    }
    noteWithdrawn(sessionId, records) {
        const listed = new Set(records.map((record) => record.pluginId));
        for (const pluginId of this.listed.get(sessionId) ?? []) {
            if (!listed.has(pluginId))
                this.withdrawn(sessionId, pluginId);
        }
        this.listed.set(sessionId, listed);
    }
    /** Deactivates the live activations no record matches any more. */
    retireChanged(sessionId, current, records) {
        const next = new Map(records.map((record) => [record.pluginId, record]));
        for (const [pluginId, identity] of current) {
            const record = next.get(pluginId);
            if (record && sameActivation(identity, record))
                continue;
            this.host.deactivate(sessionId, pluginId);
            this.dispose(sessionId, identity);
            current.delete(pluginId);
        }
    }
}
function identityOf(record) {
    const { pluginId, tier, source, artifactDigest } = record;
    return { pluginId, tier, source, artifactDigest };
}
function sameActivation(left, right) {
    return (left.pluginId === right.pluginId &&
        left.tier === right.tier &&
        left.source === right.source &&
        left.artifactDigest === right.artifactDigest);
}
function toActivationInput(sessionId, record) {
    return {
        sessionId,
        pluginId: record.pluginId,
        source: record.source,
        tier: record.tier,
        artifact: {
            digest: record.artifactDigest,
            code: record.compiled?.code ?? '',
            hooks: record.scan.hooks.map((hook) => ({
                slot: hook.slot,
                ...(hook.matcher ? { matcher: hook.matcher } : {}),
            })),
            calls: record.scan.calls.map((call) => ({
                domain: call.domain,
                method: call.method,
                ...(call.server ? { server: call.server } : {}),
            })),
        },
    };
}
//# sourceMappingURL=host-sync.js.map