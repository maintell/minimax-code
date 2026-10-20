import { isManifestPolicyCompliant, resolveWorkspaceCollectionPolicy, } from './collection-policy.js';
import { readWorkspaceCaptureManifest } from './workspace-artifact-store.js';
/** Verified-chain memo bound; eviction only costs one manifest re-read. */
const MAX_VERIFIED_POLICY_ENTRIES = 512;
/**
 * Raised when a capture — or an ancestor it would be applied on top of —
 * contains a path the live policy now excludes. It is a recoverable
 * configuration state, never a transport failure, so it is handled apart from
 * the retry ladder.
 */
export class WorkspacePolicyHoldError extends Error {
    code = 'workspace_policy_blocked';
    constructor() {
        super('workspace_policy_blocked');
        this.name = 'WorkspacePolicyHoldError';
    }
}
/**
 * Decides whether a Revision may still be pushed outward under the live
 * collection policy, and remembers the answer per policy version so a long
 * capture chain is not re-read on every stage of every attempt.
 */
export class WorkspaceRevisionPolicyGate {
    store;
    getCollectionPolicy;
    readManifest;
    /** revisionId → policy `workspaceVersion` that last verified it as compliant. */
    verifiedPolicyVersions = new Map();
    constructor(options) {
        this.store = options.store;
        this.getCollectionPolicy = options.getCollectionPolicy;
        this.readManifest = options.readManifest ?? readWorkspaceCaptureManifest;
    }
    /**
     * Verifies this Revision and every ancestor it will be applied on top of
     * against the live collection policy.
     *
     * The chain matters because an incremental capture only makes sense layered
     * over its base: extending a chain whose ancestor holds now-prohibited paths
     * would keep that content addressable remotely. Old manifests are never
     * rewritten — doing so would break the `baseRootHash` chain — so a
     * non-compliant chain is paused instead, and resumes untouched once the
     * policy allows it again.
     */
    async assertCompliant(record, signal) {
        signal.throwIfAborted();
        const binding = resolveWorkspaceCollectionPolicy(this.getCollectionPolicy);
        const visited = new Set();
        let current = record;
        while (current && !visited.has(current.revisionId)) {
            visited.add(current.revisionId);
            if (this.verifiedPolicyVersions.get(current.revisionId) !== binding.workspaceVersion) {
                const manifest = await this.readManifest(current.manifestPath);
                signal.throwIfAborted();
                // An unreadable manifest is a defect, not a policy state: it can never
                // become compliant, so it takes the retry ladder to a terminal failure
                // instead of parking forever on the policy re-check.
                if (!manifest || !Array.isArray(manifest.entries)) {
                    throw Object.assign(new Error('workspace_manifest_malformed'), {
                        code: 'workspace_manifest_malformed',
                    });
                }
                if (!isManifestPolicyCompliant(manifest, binding))
                    throw new WorkspacePolicyHoldError();
                this.verifiedPolicyVersions.delete(current.revisionId);
                this.verifiedPolicyVersions.set(current.revisionId, binding.workspaceVersion);
                while (this.verifiedPolicyVersions.size > MAX_VERIFIED_POLICY_ENTRIES) {
                    const oldest = this.verifiedPolicyVersions.keys().next().value;
                    if (oldest === undefined)
                        break;
                    this.verifiedPolicyVersions.delete(oldest);
                }
            }
            current = current.baseRevisionId
                ? await this.store.getRevision(current.baseRevisionId)
                : undefined;
            signal.throwIfAborted();
        }
    }
}
//# sourceMappingURL=revision-policy-gate.js.map