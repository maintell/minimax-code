/**
 * Small registry deliberately kept free of Electron/IPC concerns.  Task 11 can
 * add lifecycle ownership without changing the backend contract.
 */
export class DocumentPreviewBackendRegistry {
    constructor(backends = []) {
        this.backends = new Map();
        for (const backend of backends)
            this.register(backend);
    }
    register(backend) {
        if (!backend || !backend.descriptor)
            throw new TypeError('invalid preview backend');
        // QuickLook is an adapter owned by the renderer and is not a transform
        // backend in this registry. A caller that needs it models it in the UI
        // planner, but it must not acquire a native artifact slot.
        if (this.backends.has(backend.descriptor.id)) {
            throw new Error(`duplicate preview backend: ${backend.descriptor.id}`);
        }
        if (backend.descriptor.id === 'quicklook-raster' ||
            backend.descriptor.id === 'quicklook-html') {
            throw new Error('QuickLook adapters are not transform backends');
        }
        this.backends.set(backend.descriptor.id, backend);
    }
    registerBackend(backend) {
        this.register(backend);
    }
    unregister(id) {
        return this.backends.delete(id);
    }
    get(id) {
        return this.backends.get(id);
    }
    getBackend(id) {
        return this.get(id);
    }
    list() {
        return [...this.backends.values()];
    }
}

/**
 * Pure candidate ordering.  It never probes a process, reads a file, or
 * consults renderer-controlled platform/architecture values.  Native
 * LibreOffice is intentionally opt-in via `high-fidelity` intent.
 */
export class DocumentPreviewBackendPlanner {
    constructor(registryOrOptions = new DocumentPreviewBackendRegistry()) {
        this.registry =
            registryOrOptions instanceof DocumentPreviewBackendRegistry
                ? registryOrOptions
                : (registryOrOptions.registry ?? new DocumentPreviewBackendRegistry());
    }
    plan(request, options = {}) {
        if (!request)
            return [];
        const sourceOptions = options;
        const sourceMimeType = sourceOptions.sourceMimeType ?? options.mimeType;
        if (sourceOptions.cancelled)
            return [];
        const candidates = this.registry
            .list()
            .filter((backend) => {
            const descriptor = backend.descriptor;
            if (sourceMimeType && !descriptor.inputMimeTypes.includes(sourceMimeType))
                return false;
            // Keep the complete fallback chain even when a candidate does not
            // produce the preferred artifact kind.  A native PDF failure must not
            // erase the HTML/DOM fallback that can still show the source.
            // Required capabilities are a preference for the first suitable
            // backend, not a reason to erase the fallback chain.  The
            // orchestrator records a capability miss in fallbackTrace and may
            // still use a lower-fidelity renderer when the user asks to view a
            // document.  This is particularly important for high-fidelity
            // requests: native can fail closed while the DOM renderer remains useful.
            if (descriptor.id === 'libreoffice-native' && request.intent !== 'high-fidelity') {
                return false;
            }
            return true;
        })
            .map((backend) => backend.descriptor.id);
        if (request.intent === 'high-fidelity' && candidates.includes('libreoffice-native')) {
            return [
                'libreoffice-native',
                ...candidates.filter((candidate) => candidate !== 'libreoffice-native'),
            ];
        }
        return candidates;
    }
    getBackend(id) {
        return this.registry.get(id);
    }
    get registrySnapshot() {
        return this.registry.list();
    }
}

export function planDocumentPreviewBackends(request, registry, options = {}) {
    return new DocumentPreviewBackendPlanner(registry).plan(request, options);
}
export function createDocumentPreviewBackendRegistry(backends = []) {
    return new DocumentPreviewBackendRegistry(backends);
}
