import { resolveAnnotationTarget, resolveDeletedFileTarget } from '../review/annotation-target.js';
import { ReviewPreferencesService } from '../review/preferences.js';
export class DesktopReviewService {
    deps;
    preferences;
    constructor(deps) {
        this.deps = deps;
        this.preferences = new ReviewPreferencesService(deps.dataDir);
    }
    async getReviewPreferences(_ctx, _req) {
        return { preferences: { rules: await this.preferences.get() } };
    }
    async updateReviewPreferences(_ctx, req) {
        return { preferences: { rules: await this.preferences.update(req.rules ?? '') } };
    }
    async resolveAnnotationTarget(_ctx, req) {
        const targetPath = req.lineRange?.path ?? req.deletedFile?.path;
        const session = await this.deps.getSessionById(req.sessionId);
        if (!session) {
            return {
                status: 'invalid',
                ...(targetPath ? { path: targetPath } : {}),
                message: 'Review session does not exist',
            };
        }
        if (Number(req.lineRange !== undefined) + Number(req.deletedFile !== undefined) !== 1) {
            return {
                status: 'invalid',
                ...(targetPath ? { path: targetPath } : {}),
                message: 'Exactly one review annotation target is required',
            };
        }
        if (req.deletedFile) {
            if (!isGitBlobRevision(req.deletedFile.blobRevision)) {
                return {
                    status: 'invalid',
                    targetType: 'file',
                    path: req.deletedFile.path,
                    message: 'Invalid deleted file review target',
                };
            }
            return resolveDeletedFileTarget({
                workspace: session.workspaceDir,
                path: req.deletedFile.path,
                expectedBlobRevision: req.deletedFile.blobRevision,
            });
        }
        const target = req.lineRange;
        if (!target) {
            return {
                status: 'invalid',
                message: 'Exactly one review annotation target is required',
            };
        }
        if (target.expectedRevision !== undefined && !isSha256Revision(target.expectedRevision)) {
            return {
                status: 'invalid',
                path: target.path,
                message: 'Invalid review anchor revision',
            };
        }
        if (!isReviewSide(target.side)) {
            return {
                status: 'invalid',
                targetType: 'line-range',
                path: target.path,
                message: 'Invalid review target side',
            };
        }
        const resolution = await resolveAnnotationTarget({
            workspace: session.workspaceDir,
            path: target.path,
            startLine: target.startLine,
            endLine: target.endLine,
            side: target.side,
            ...(target.expectedRevision ? { expectedRevision: target.expectedRevision } : {}),
            ...(target.contextBefore !== undefined ? { contextBefore: target.contextBefore } : {}),
            ...(target.contextAfter !== undefined ? { contextAfter: target.contextAfter } : {}),
        });
        if (!canValidateRelatedChange(resolution))
            return resolution;
        const related = parseRelatedChange(target.relatedChange);
        if (related === null) {
            return {
                status: 'invalid',
                targetType: 'line-range',
                path: target.path,
                side: target.side,
                message: 'Invalid related review change',
            };
        }
        // relatedChange ties a finding back to the workspace diff that introduced it. That diff is
        // ephemeral: committing the reviewed changes removes it even when the primary target remains
        // byte-for-byte current. Keep validating the protocol shape above, but let the primary anchor
        // alone decide whether the persisted comment can still be displayed.
        return resolution;
    }
}
function isSha256Revision(value) {
    return value === undefined ? false : /^sha256:[a-f0-9]{64}$/u.test(value);
}
function isGitBlobRevision(value) {
    return value === undefined ? false : /^git-blob:[a-f0-9]{40,64}$/u.test(value);
}
function isReviewSide(value) {
    return value === 'old' || value === 'new';
}
function canValidateRelatedChange(resolution) {
    return (resolution.status === 'current' ||
        resolution.status === 'relocated' ||
        resolution.status === 'unverified');
}
function parseRelatedChange(related) {
    if (!related)
        return undefined;
    if (!related.path ||
        !isReviewSide(related.side) ||
        !Number.isSafeInteger(related.startLine) ||
        !Number.isSafeInteger(related.endLine) ||
        related.startLine < 1 ||
        related.endLine < related.startLine ||
        !isSha256Revision(related.revision)) {
        return null;
    }
    return {
        path: related.path,
        side: related.side,
        startLine: related.startLine,
        endLine: related.endLine,
        expectedRevision: related.revision,
    };
}
//# sourceMappingURL=desktop-review-service.js.map