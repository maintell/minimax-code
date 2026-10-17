import { domainMatchesHost } from "./chrome-cookie";
import { BrowserProfileImportFailure } from "./errors";
const SECURE_COOKIE_OVERWRITE_EXCLUSION = 'EXCLUDE_OVERWRITE_SECURE';
function emptyResult(requestId, errorCode) {
    return {
        success: false,
        requestId,
        errorCode,
        importedCount: 0,
        failedCount: 0,
        skippedCount: 0,
        unsupportedCount: 0,
    };
}
function isAbortError(error, signal) {
    return signal.aborted || (error instanceof Error && error.name === 'AbortError');
}
function validRequestId(value) {
    return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function validHost(value) {
    if (!value || value.length > 253 || value.includes('/') || value.includes(':'))
        return false;
    return /^[A-Za-z0-9.-]+$/.test(value);
}
function cookieMatchesHost(cookie, currentHost) {
    if (cookie.domain)
        return domainMatchesHost(cookie.domain, currentHost);
    try {
        return new URL(cookie.url).hostname.toLowerCase() === currentHost.toLowerCase();
    }
    catch {
        return false;
    }
}
function isSecureCookieConflict(error) {
    return String(error).includes(SECURE_COOKIE_OVERWRITE_EXCLUSION);
}
function reportDiagnostic(reporter, event) {
    try {
        reporter?.(event);
    }
    catch {
        // Diagnostics must never interrupt the import or leave activeImport locked.
    }
}
export class BrowserProfileImportService {
    constructor(dependencies) {
        this.dependencies = dependencies;
        this.activeImport = null;
    }
    async listImportableProfiles(source = 'unknown') {
        const platformAvailable = this.dependencies.platform === 'darwin' || this.dependencies.platform === 'win32';
        if (!platformAvailable) {
            return {
                success: true,
                capability: {
                    available: false,
                    browser: 'chrome',
                    cookieImport: false,
                    passwordImport: false,
                    platform: this.dependencies.platform,
                    unavailableReason: 'unsupported_platform',
                },
                profiles: [],
            };
        }
        try {
            // Automatic NUX only detects the application; data access requires a user action.
            const installed = source === 'automatic' ? await this.dependencies.isChromeInstalled() : false;
            const profiles = source === 'automatic' ? [] : await this.dependencies.discoverProfiles({ source });
            const available = source === 'automatic' ? installed : profiles.length > 0;
            return {
                success: true,
                capability: {
                    available,
                    browser: 'chrome',
                    cookieImport: true,
                    passwordImport: false,
                    platform: this.dependencies.platform,
                    ...(!available ? { unavailableReason: 'chrome_not_found' } : {}),
                },
                profiles: profiles.map((profile) => profile.publicMetadata),
            };
        }
        catch (error) {
            return {
                success: false,
                capability: {
                    available: false,
                    browser: 'chrome',
                    cookieImport: true,
                    passwordImport: false,
                    platform: this.dependencies.platform,
                },
                profiles: [],
                errorCode: error instanceof BrowserProfileImportFailure ? error.code : 'chrome_profile_unavailable',
            };
        }
    }
    cancelImport(requestId) {
        if (this.activeImport?.requestId !== requestId)
            return { success: false };
        this.activeImport.controller.abort(new DOMException('Import cancelled', 'AbortError'));
        return { success: true };
    }
    async importCookies(request) {
        if (!validRequestId(request.requestId) ||
            !request.profileId.startsWith('chrome_') ||
            (request.scope !== 'all' && request.scope !== 'current-site')) {
            return emptyResult(request.requestId || 'invalid', 'invalid_request');
        }
        const currentHost = request.scope === 'current-site' && validHost(request.currentHost)
            ? request.currentHost
            : undefined;
        if (request.scope === 'current-site' && !currentHost) {
            return emptyResult(request.requestId, 'invalid_current_site');
        }
        if (this.dependencies.platform !== 'darwin' && this.dependencies.platform !== 'win32') {
            return emptyResult(request.requestId, 'unsupported_platform');
        }
        if (this.activeImport)
            return emptyResult(request.requestId, 'import_in_progress');
        const controller = new AbortController();
        this.activeImport = { requestId: request.requestId, controller };
        const progress = (phase, completed, total) => this.dependencies.onProgress?.({ requestId: request.requestId, phase, completed, total });
        let importedCount = 0;
        let failedCount = 0;
        let skippedCount = 0;
        let unsupportedCount = 0;
        let secureConflictCount = 0;
        let cookiesFlushed = false;
        const startedAt = Date.now();
        const finish = (result) => {
            reportDiagnostic(this.dependencies.onDiagnostic, {
                event: 'import_completed',
                requestId: request.requestId,
                success: result.success,
                ...(result.errorCode ? { errorCode: result.errorCode } : {}),
                importedCount: result.importedCount,
                failedCount: result.failedCount,
                skippedCount: result.skippedCount,
                unsupportedCount: result.unsupportedCount,
                secureConflictCount: result.secureConflictCount ?? 0,
                durationMs: Date.now() - startedAt,
            });
            return result;
        };
        reportDiagnostic(this.dependencies.onDiagnostic, {
            event: 'import_started',
            requestId: request.requestId,
            platform: this.dependencies.platform,
            scope: request.scope,
        });
        try {
            progress('discovering', 0, 0);
            const profiles = await this.dependencies.discoverProfiles({
                source: 'import',
                requestId: request.requestId,
            });
            reportDiagnostic(this.dependencies.onDiagnostic, {
                event: 'profiles_discovered',
                requestId: request.requestId,
                count: profiles.length,
            });
            const profile = profiles.find((candidate) => candidate.id === request.profileId);
            if (!profile)
                return finish(emptyResult(request.requestId, 'profile_not_found'));
            controller.signal.throwIfAborted();
            progress('reading', 0, 0);
            const readResult = await this.dependencies.readCookies(profile, controller.signal, {
                ...(currentHost ? { currentHost } : {}),
                requestId: request.requestId,
                onAuthorizationRequired: () => progress('authorizing', 0, 0),
                onAuthorizationCompleted: () => progress('reading', 0, 0),
            });
            controller.signal.throwIfAborted();
            const cookies = Array.isArray(readResult) ? readResult : readResult.cookies;
            skippedCount = Array.isArray(readResult) ? 0 : readResult.skippedCount;
            unsupportedCount = Array.isArray(readResult) ? 0 : readResult.unsupportedCount;
            const selected = cookies.filter((cookie) => {
                if (request.scope === 'all')
                    return true;
                if (!currentHost)
                    return false;
                const matches = cookieMatchesHost(cookie, currentHost);
                if (!matches)
                    skippedCount += 1;
                return matches;
            });
            for (let index = 0; index < selected.length; index += 1) {
                controller.signal.throwIfAborted();
                progress('writing', index, selected.length);
                try {
                    await this.dependencies.setCookie(selected[index]);
                    importedCount += 1;
                }
                catch (error) {
                    if (isSecureCookieConflict(error)) {
                        skippedCount += 1;
                        secureConflictCount += 1;
                    }
                    else {
                        failedCount += 1;
                    }
                }
            }
            reportDiagnostic(this.dependencies.onDiagnostic, {
                event: 'cookie_write_completed',
                requestId: request.requestId,
                selectedCount: selected.length,
                importedCount,
                failedCount,
                secureConflictCount,
            });
            controller.signal.throwIfAborted();
            progress('flushing', selected.length, selected.length);
            await this.dependencies.flushCookies();
            cookiesFlushed = true;
            reportDiagnostic(this.dependencies.onDiagnostic, {
                event: 'cookie_flush_completed',
                requestId: request.requestId,
            });
            controller.signal.throwIfAborted();
            progress('completed', selected.length, selected.length);
            return finish({
                success: true,
                requestId: request.requestId,
                importedCount,
                failedCount,
                skippedCount,
                unsupportedCount,
                ...(secureConflictCount > 0 ? { secureConflictCount } : {}),
            });
        }
        catch (error) {
            if (isAbortError(error, controller.signal)) {
                if (importedCount > 0 && !cookiesFlushed) {
                    try {
                        await this.dependencies.flushCookies();
                    }
                    catch {
                        // The Cookie setters already succeeded. Preserve the truthful partial result even
                        // when the explicit disk flush cannot be completed during cancellation.
                    }
                }
                return finish({
                    success: false,
                    requestId: request.requestId,
                    errorCode: 'cancelled',
                    importedCount,
                    failedCount,
                    skippedCount,
                    unsupportedCount,
                    ...(secureConflictCount > 0 ? { secureConflictCount } : {}),
                });
            }
            if (error instanceof BrowserProfileImportFailure) {
                return finish(emptyResult(request.requestId, error.code));
            }
            return finish({
                success: false,
                requestId: request.requestId,
                errorCode: 'unexpected_error',
                importedCount,
                failedCount,
                skippedCount,
                unsupportedCount,
                ...(secureConflictCount > 0 ? { secureConflictCount } : {}),
            });
        }
        finally {
            if (this.activeImport?.requestId === request.requestId)
                this.activeImport = null;
        }
    }
}

