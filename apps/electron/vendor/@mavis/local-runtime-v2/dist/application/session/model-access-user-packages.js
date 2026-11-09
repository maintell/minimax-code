import path from 'node:path';
import { AppError } from '../errors.js';
import { toModelAccessAppError } from './model-access-errors.js';
function invalid() {
    return new AppError(400, 'VALIDATION_ERROR', 'Invalid model access request');
}
function text(value, maximum = 256) {
    if (typeof value !== 'string' ||
        !value.trim() ||
        value.length > maximum ||
        /[\u0000-\u001f]/u.test(value))
        throw invalid();
    return value;
}
function flag(value) {
    if (typeof value !== 'boolean')
        throw invalid();
    return value;
}
async function run(operation) {
    try {
        return await operation();
    }
    catch (error) {
        throw toModelAccessAppError(error);
    }
}
/** `source_ref` wins; a bare `source` keeps its folder/zip-by-extension meaning. */
export function packageSourceInput(source, sourceRef) {
    if (sourceRef) {
        if (sourceRef.kind !== 'dir' && sourceRef.kind !== 'zip')
            throw invalid();
        return { kind: sourceRef.kind, path: text(sourceRef.path, 4096) };
    }
    return text(source, 4096);
}
/**
 * A user/dev package's own names and icons. Icons resolve inside the verified read-only snapshot,
 * so the UI only ever loads files the runtime has already checked.
 */
export function packagePresentation(manifest, snapshot) {
    const icon = (asset) => asset && snapshot ? path.join(snapshot, ...asset.slice(2).split('/')) : undefined;
    const entries = [];
    for (const kind of ['provider', 'source']) {
        const group = kind === 'provider' ? manifest.presentation?.providers : manifest.presentation?.sources;
        for (const [id, entry] of Object.entries(group ?? {})) {
            const iconPath = icon(entry.icon);
            const darkIconPath = icon(entry.darkIcon);
            entries.push({
                kind,
                id,
                ...(entry.displayName ? { displayName: { ...entry.displayName } } : {}),
                ...(iconPath ? { iconPath } : {}),
                ...(darkIconPath ? { darkIconPath } : {}),
            });
        }
    }
    return entries.length ? { presentation: entries } : {};
}
export function devSessionInfo(session) {
    return {
        sessionId: session.sessionId,
        path: session.path,
        installationId: session.installationId,
        name: session.name,
        digest: session.digest,
        startedAt: session.startedAt,
        ...(session.reloadedAt !== undefined ? { reloadedAt: session.reloadedAt } : {}),
    };
}
/**
 * Dev sessions, promotion, diagnostics and export for user packages. Consent is always an
 * explicit request field; the renderer or the agent tool cannot imply it.
 */
export class ModelAccessUserPackageOperations {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async startDev(req) {
        const directory = text(req.path, 4096);
        const trustNativeCode = flag(req.trustNativeCode);
        return run(async () => {
            const session = await this.user().startDev({ path: directory, trustNativeCode });
            return { session: devSessionInfo(session), snapshot: this.deps.project() };
        });
    }
    /**
     * The user approves an agent's request, bound to the digest they were shown: a run request
     * starts a dev session for its path, a keep request keeps that session as a user package.
     */
    async approveRequest(req) {
        const requestId = text(req.requestId);
        const expectedDigest = text(req.expectedDigest);
        const trustNativeCode = flag(req.trustNativeCode);
        return run(async () => {
            const user = this.user();
            const request = user.requestsList().find((item) => item.requestId === requestId);
            if (!request)
                throw new AppError(404, 'MODEL_ACCESS_DEV_REQUEST_MISSING', 'dev_request_missing');
            if (request.kind === 'keep') {
                const kept = await user.approveKeep({ requestId, expectedDigest, trustNativeCode });
                return { session: devSessionInfo(kept), snapshot: this.deps.project() };
            }
            const preview = await user.preview({ kind: 'dir', path: request.path });
            if (preview.digest !== expectedDigest)
                throw new AppError(409, 'MODEL_ACCESS_PACKAGE_CHANGED', 'package_changed');
            const session = await user.startDev({ path: request.path, trustNativeCode });
            return { session: devSessionInfo(session), snapshot: this.deps.project() };
        });
    }
    async dismissRequest(requestId) {
        const id = text(requestId);
        return this.deps.mutate(async () => this.user().dismissDevRequest(id));
    }
    async reloadDev(sessionId) {
        const id = text(sessionId);
        return run(async () => {
            const reloaded = await this.user().reload(id);
            return {
                session: {
                    ...devSessionInfo(reloaded),
                    ...(reloaded.installation.errorCode
                        ? { errorCode: reloaded.installation.errorCode }
                        : {}),
                },
                snapshot: this.deps.project(),
            };
        });
    }
    async stopDev(sessionId) {
        const id = text(sessionId);
        return this.deps.mutate(() => this.user().stopDev(id));
    }
    async promote(req) {
        const input = {
            sessionId: text(req.sessionId),
            expectedDigest: text(req.expectedDigest),
            trustNativeCode: flag(req.trustNativeCode),
        };
        return this.deps.mutate(() => this.user().promote(input));
    }
    /** Read-only diagnostics: no credential, token or extension log text crosses this boundary. */
    async status(installationId) {
        const id = text(installationId);
        return run(async () => {
            const snapshot = this.deps.project();
            const installation = snapshot.installations.find((item) => item.installationId === id);
            if (!installation)
                throw new AppError(404, 'MODEL_ACCESS_INSTALLATION_MISSING', 'installation_missing');
            const registration = this.deps.packages.registry.get(id);
            const methods = (registration?.manifest.sources ?? []).flatMap(loginMethodsOf);
            const providers = (registration?.manifest.providers ?? []).map((provider) => ({ providerId: provider.id, methods }));
            return { installation, providers, hostRunning: registration !== undefined };
        });
    }
    async exportPackage(req) {
        const id = text(req.installationId);
        const target = text(req.target, 4096);
        return run(() => this.user().exportPackage(id, target));
    }
    user() {
        const user = this.deps.packages.userPackages;
        if (!user)
            throw new AppError(404, 'MODEL_ACCESS_USER_PACKAGES_UNAVAILABLE', 'unavailable');
        return user;
    }
}
/** `<source>/<kind>` of every sign-in method a source declares. */
function loginMethodsOf(source) {
    return (source.capabilities.login?.methods ?? []).map((method) => `${source.id}/${method.kind}`);
}
//# sourceMappingURL=model-access-user-packages.js.map