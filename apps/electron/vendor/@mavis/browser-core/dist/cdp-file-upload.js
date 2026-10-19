export async function uploadFilesByBackendNodeId(host, backendNodeId, files, options = {}) {
    if (options.signal?.aborted)
        throw new Error('ABORTED: file upload was cancelled');
    if (files.length === 0)
        throw new Error('FILE_NOT_AUTHORIZED: no files were provided');
    const target = await host.callFunctionOnBackendNode(backendNodeId, `function() {
      return {
        tagName: String(this.tagName || '').toLowerCase(),
        inputType: this instanceof HTMLInputElement ? String(this.type || '').toLowerCase() : ''
      };
    }`);
    if (target.tagName === 'input' && target.inputType === 'file') {
        await host.sendCommand('DOM.setFileInputFiles', { backendNodeId, files });
        const filesAttached = await readAttachedFileCount(host, backendNodeId);
        if (filesAttached !== files.length) {
            throw new Error('FILE_UPLOAD_NOT_OBSERVED: selected file count did not match');
        }
        return { filesAttached, chooserOpened: false };
    }
    await host.ensureAttached();
    const timeoutMs = Math.max(1, options.timeoutMs ?? 30_000);
    let timer = null;
    let settled = false;
    let chooserBackendNodeId;
    let resolveChooser;
    let rejectChooser;
    const chooser = new Promise((resolve, reject) => {
        resolveChooser = resolve;
        rejectChooser = reject;
    });
    // The click command itself can abort before control reaches `await chooser`.
    // Observe the chooser rejection immediately while preserving it for the
    // awaited workflow below.
    void chooser.catch(() => undefined);
    const removeListener = host.onEvent(({ method, params }) => {
        const payload = params;
        if (settled || method !== 'Page.fileChooserOpened' || !payload?.backendNodeId)
            return;
        settled = true;
        chooserBackendNodeId = payload.backendNodeId;
        resolveChooser?.();
    });
    const abortHandler = () => {
        if (settled)
            return;
        settled = true;
        rejectChooser?.(new Error('ABORTED: file upload was cancelled'));
    };
    options.signal?.addEventListener('abort', abortHandler, { once: true });
    try {
        await host.sendCommand('Page.enable');
        await host.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
        timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            rejectChooser?.(new Error(`FILE_CHOOSER_TIMEOUT: no file chooser opened within ${timeoutMs}ms`));
        }, timeoutMs);
        await host.clickByBackendNodeId(backendNodeId);
        await chooser;
        if (!chooserBackendNodeId)
            throw new Error('FILE_CHOOSER_UNAVAILABLE: missing chooser target');
        await host.sendCommand('DOM.setFileInputFiles', {
            backendNodeId: chooserBackendNodeId,
            files,
        });
        const filesAttached = await readAttachedFileCount(host, chooserBackendNodeId);
        if (filesAttached !== files.length) {
            throw new Error('FILE_UPLOAD_NOT_OBSERVED: selected file count did not match');
        }
        return { filesAttached, chooserOpened: true };
    }
    catch (error) {
        if (options.signal?.aborted) {
            throw new Error('ABORTED: file upload was cancelled');
        }
        throw error;
    }
    finally {
        if (timer)
            clearTimeout(timer);
        options.signal?.removeEventListener('abort', abortHandler);
        removeListener();
        await (host.sendCleanupCommand ?? host.sendCommand)
            .call(host, 'Page.setInterceptFileChooserDialog', { enabled: false })
            .catch(() => undefined);
    }
}
async function readAttachedFileCount(host, backendNodeId) {
    const result = await host.callFunctionOnBackendNode(backendNodeId, `function() {
      return { filesAttached: this instanceof HTMLInputElement && this.files ? this.files.length : 0 };
    }`);
    return Number.isFinite(result.filesAttached) ? result.filesAttached : 0;
}
//# sourceMappingURL=cdp-file-upload.js.map