import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { clipboard } from "electron";
import { BROWSER_TIMEOUTS, BrowserCore, sanitizeConsoleDiagnosticUrl } from "@mavis/browser-core";
import { ElectronBrowserPageContext } from "./electron-browser-page-context";
import { ELECTRON_BROWSER_CORE_ACTIONS } from "./electron-browser-route-policy";
import { ElectronCdpTransport } from "./electron-cdp-transport";
import { asString, AGENT_BROWSER_ACTIONS, OFFSCREEN_BOUNDS, asNumber, asRecord, safeError, nowMs, normalizeUrl, agentElementPriority, MAX_AGENT_SNAPSHOT_ELEMENTS, agentSnapshotElement, agentSnapshotSummary, MAX_AGENT_SNAPSHOTS_PER_TAB, AGENT_SNAPSHOT_TTL_MS, MAX_AGENT_SNAPSHOT_PAGE_LIMIT, DEFAULT_AGENT_SNAPSHOT_PAGE_LIMIT, buildAgentSnapshotPage, MAX_AGENT_SNAPSHOT_PAGE_BYTES, urlHost, isMainDocumentNavigation, requireTextArg, asStringArray, asBoolean, requireStringArg, finiteNumber, shortcutModifier } from "./embedded-browser-manager-helpers";
const VERIFIED_FILL_SAMPLE_COUNT = 4;
const VERIFIED_FILL_SAMPLE_DELAY_MS = 50;
const TEXT_INPUT_COMPLETION_BUFFER_MS = 30000;
const TEXT_INPUT_CDP_EVENT_ESTIMATE_MS = 20;
const ELECTRON_CLICK_NAVIGATION_DETECTION_MS = 100;
const LEGACY_ACTIONS_REQUIRING_ADDRESSABLE_TARGET = new Set([
    'check',
    'uncheck',
    'paste',
    'select_option',
    'scroll',
]);
function textInputOperationTimeout(params, tab) {
    const requestedDelay = typeof params.delay === 'string' ? Number.parseInt(params.delay, 10) : params.delay;
    const delay = Number.isFinite(requestedDelay) ? Math.max(0, requestedDelay ?? 0) : 0;
    const characters = Array.from(params.text);
    const delayedInputMs = characters.length * delay;
    const elements = tab.controller.getElementMapManager().getElementMap();
    const element = params.index !== undefined
        ? (elements.find((candidate) => candidate.index === params.index) ?? null)
        : params.selector
            ? (elements.find((candidate) => candidate.selector === params.selector) ?? null)
            : null;
    const estimatedCdpEventCount = element?.inputStrategy === 'focused-keyboard'
        ? characters.reduce((count, char) => count + (/^[\x20-\x7E]$/u.test(char) ? 3 : 1), params.clear ? 4 : 0)
        : 0;
    const cdpDispatchMs = estimatedCdpEventCount * TEXT_INPUT_CDP_EVENT_ESTIMATE_MS;
    const requiredTimeoutMs = delayedInputMs + cdpDispatchMs + TEXT_INPUT_COMPLETION_BUFFER_MS;
    if (requiredTimeoutMs > BROWSER_TIMEOUTS.longTabOperation) {
        throw new Error(`INPUT_DURATION_EXCEEDS_DEADLINE: Delayed input requires ${requiredTimeoutMs}ms but the maximum safe Browser action budget is ${BROWSER_TIMEOUTS.longTabOperation}ms`);
    }
    return Math.min(BROWSER_TIMEOUTS.longTabOperation, Math.max(BROWSER_TIMEOUTS.tabOperation, requiredTimeoutMs));
}
function visualRectForElement(element) {
    if (element.coordinateSpace !== 'main-frame-viewport')
        return undefined;
    const { x, y, width, height } = element.boundingBox;
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
        return undefined;
    }
    return { x, y, width, height };
}
function agentElementIsEditable(element) {
    const tag = element.tag.toLowerCase();
    const attributes = element.attributes;
    const type = (attributes.type || element.type).toLowerCase();
    const excludedInputTypes = new Set([
        'button',
        'checkbox',
        'file',
        'hidden',
        'image',
        'radio',
        'reset',
        'submit',
    ]);
    return ((tag === 'input' && !excludedInputTypes.has(type)) ||
        tag === 'textarea' ||
        type === 'textbox' ||
        type === 'searchbox' ||
        attributes.contenteditable === 'true' ||
        attributes.role === 'textbox' ||
        attributes.role === 'searchbox');
}
function agentQueryFailure(result) {
    const error = asString(result.error, asString(result.message, 'Browser query failed'));
    const invalidSelector = asString(result.code) === 'INVALID_SELECTOR' ||
        /(?:failed to execute ['"]?queryselector|not a valid selector|invalid selector|selector[^\n]*syntaxerror|syntaxerror[^\n]*selector)/iu.test(error);
    return {
        success: false,
        code: invalidSelector ? 'INVALID_SELECTOR' : 'QUERY_FAILED',
        error,
        recovery: invalidSelector
            ? 'Use query with kind: "text" for text matching, or continue inspect and act through a returned opaque ref. CSS selectors must use standard CSS syntax.'
            : 'Inspect the current page state and retry the query once; if navigation occurred, continue from the new snapshot.',
    };
}
/** Keep the legacy query contract fail-closed before either provider path runs. */
function normalizeAgentQueryArgs(args) {
    if (args.frame)
        throw new Error('Browser query does not accept an unscoped frame target');
    const kind = asString(args.kind, 'snapshot');
    const supportedFields = new Set(kind === 'snapshot'
        ? ['snapshotId', 'offset', 'limit']
        : kind === 'editable'
            ? ['snapshotId', 'offset', 'limit']
            : kind === 'semantic'
                ? ['text', 'limit']
                : kind === 'dom' || kind === 'text'
                    ? ['selector', 'maxChars']
                    : kind === 'console'
                        ? ['levels', 'filter', 'limit']
                        : kind === 'network'
                            ? ['status', 'resourceTypes', 'filter', 'afterSequence', 'limit']
                            : []);
    const unsupportedFields = Object.keys(args).filter((field) => field !== 'kind' && args[field] !== undefined && !supportedFields.has(field));
    if (unsupportedFields.length > 0) {
        throw new Error(`Browser query kind "${kind}" does not accept ${unsupportedFields.join(', ')}`);
    }
    return { ...args, kind };
}
export class EmbeddedBrowserToolRuntime {
    constructor(host) {
        this.host = host;
        this.sharedBrowserCore = new BrowserCore({
            provider: 'electron-cdp',
            version: 1,
            actions: ELECTRON_BROWSER_CORE_ACTIONS,
        });
        this.sharedPageContexts = new WeakMap();
        this.sharedCoreTabs = new WeakSet();
    }
    async navigateAgentTab(tab, url, signal) {
        const sessionId = tab.sessionId?.trim();
        if (!sessionId)
            throw new Error('Browser tool requires an active session');
        const coreResult = await this.tryExecuteBrowserCore({ sessionId, tabId: tab.tabId }, 'navigate', { url }, signal, tab);
        if (coreResult.used)
            return coreResult.result;
        return this.stripAgentTarget(await this.executeTool('navigate', { sessionId, tabId: tab.tabId, url }, signal));
    }
    async executeAgentTool(agentTarget, tool, rawArgs, signal) {
        const trustedSessionId = agentTarget.sessionId.trim();
        if (!trustedSessionId)
            throw new Error('Browser tool requires an active session');
        if (!AGENT_BROWSER_ACTIONS.has(tool)) {
            throw new Error(`Unsupported Agent browser action: ${tool}`);
        }
        const { sessionId: _ignoredSessionId, tabId: _ignoredTabId, ...rawArgsWithoutTarget } = rawArgs;
        const args = tool === 'query'
            ? normalizeAgentQueryArgs(rawArgsWithoutTarget)
            : tool === 'upload_files'
                ? this.normalizeAuthorizedUploadArgs(rawArgsWithoutTarget)
                : rawArgsWithoutTarget;
        const target = { sessionId: trustedSessionId, tabId: agentTarget.tabId };
        const coreResult = await this.tryExecuteBrowserCore(target, tool, args, signal);
        if (coreResult.used)
            return coreResult.result;
        if (tool === 'inspect') {
            if (args.frame)
                throw new Error('Browser inspect does not accept a frame without an element ref');
            const requestedSnapshotId = asString(args.snapshotId);
            if (requestedSnapshotId) {
                const tab = await this.host.requireBrowserTab(target, {
                    createIfMissing: false,
                    bounds: OFFSCREEN_BOUNDS,
                });
                return this.readAgentSnapshotPage(tab, requestedSnapshotId, args);
            }
            if (asNumber(args.offset, 0) > 0) {
                throw new Error('Browser inspect offset requires snapshotId from a previous inspect');
            }
            const result = await this.executeTool('inspect', { ...args, ...target }, signal);
            if (asRecord(result).success === false)
                return this.stripAgentTarget(result);
            const tab = await this.host.requireBrowserTab(target, {
                createIfMissing: true,
                bounds: OFFSCREEN_BOUNDS,
            });
            return this.createAgentSnapshot(tab, result, args);
        }
        if (tool === 'query')
            return this.queryAgentBrowser(target, args, signal);
        if (tool === 'back')
            return this.stripAgentTarget(await this.host.goBack(target, signal));
        if (tool === 'forward')
            return this.stripAgentTarget(await this.host.goForward(target, signal));
        if (tool === 'reload')
            return this.stripAgentTarget(await this.host.reload(target, signal));
        if (tool === 'upload_files') {
            return this.uploadAgentFiles(target, args, signal);
        }
        if (tool === 'click_and_wait_for_navigation') {
            return this.clickAndWaitForNavigation(target, args, signal);
        }
        if (tool === 'click' || tool === 'double_click') {
            return this.executeGuardedAgentClick(target, tool, args, signal);
        }
        if ((tool === 'fill' || tool === 'type') && asString(args.ref)) {
            return this.executeVerifiedAgentTextAction(target, tool, args, signal);
        }
        const actionArgs = await this.resolveAgentActionArgs(target, tool, args, signal);
        let result;
        switch (tool) {
            case 'double_click':
                result = await this.executeTool('click', {
                    ...actionArgs,
                    ...target,
                    click_count: 2,
                }, signal);
                break;
            case 'fill':
                result = await this.executeTool('type', {
                    ...actionArgs,
                    ...target,
                    clear: true,
                }, signal);
                break;
            case 'wait':
                result = await this.executeTool('wait_for', {
                    ...this.normalizeAgentWaitArgs(actionArgs),
                    ...target,
                }, signal);
                break;
            default:
                result = await this.executeTool(tool, { ...actionArgs, ...target }, signal);
                break;
        }
        return this.stripAgentTarget(result);
    }
    async tryExecuteBrowserCore(agentTarget, tool, input, signal, explicitTab) {
        const { sessionId, tabId } = agentTarget;
        if (!ELECTRON_BROWSER_CORE_ACTIONS.some((action) => action === tool)) {
            return { used: false };
        }
        const clickAction = tool === 'click' || tool === 'double_click' || tool === 'click_and_wait_for_navigation';
        if (tool === 'inspect' && input.frame) {
            throw new Error('Browser inspect does not accept a frame without an element ref');
        }
        if (explicitTab?.sessionId !== undefined && explicitTab.sessionId !== sessionId) {
            throw new Error('Browser tab does not belong to the active session');
        }
        if (explicitTab && explicitTab.tabId !== tabId) {
            throw new Error('Browser tab does not match the requested target');
        }
        const tab = explicitTab ??
            (await this.host.requireBrowserTab(agentTarget, {
                createIfMissing: true,
                bounds: OFFSCREEN_BOUNDS,
            }));
        const webContents = this.host.getWebContents(tab);
        // Unit hosts and early tab initialization deliberately expose no
        // WebContents. Keep the mature controller path as a compatibility seam;
        // every real Electron Agent Browser page takes the shared Core path.
        const unusableWebContents = !webContents ||
            webContents.isDestroyed() ||
            typeof webContents.executeJavaScript !== 'function' ||
            typeof webContents.debugger?.sendCommand !== 'function';
        if (unusableWebContents) {
            if (this.sharedCoreTabs.has(tab)) {
                return {
                    used: true,
                    result: {
                        success: false,
                        code: 'BROWSER_UNAVAILABLE',
                        error: 'The Browser page is unavailable after the shared Core session was created.',
                        retryable: true,
                        recovery: 'Inspect the Browser page after it is recreated before retrying the action.',
                    },
                };
            }
            return { used: false };
        }
        if (!webContents)
            return { used: false };
        let pageContext = this.sharedPageContexts.get(webContents);
        if (!pageContext) {
            const controllerCdpHelper = tab.controller.getCDPHelper();
            const controllerTransport = controllerCdpHelper && typeof controllerCdpHelper.getTransport === 'function'
                ? controllerCdpHelper.getTransport()
                : undefined;
            const transport = controllerTransport instanceof ElectronCdpTransport
                ? controllerTransport
                : new ElectronCdpTransport(webContents);
            const sharedCdpHelper = controllerTransport === transport ? controllerCdpHelper : undefined;
            transport.enableOopifAutoAttach();
            try {
                await this.host.withTabOperation(tab, 'browser-core:transport-start', (operationSignal) => transport.start(operationSignal ?? signal), { signal, operationTimeoutMs: BROWSER_TIMEOUTS.tabOperation });
            }
            catch (error) {
                // A cancelled first action can happen before the Core session is
                // registered. Release the shared transport claim; either Core or the
                // legacy helper will attach the same owner again on its next command.
                await transport.close().catch(() => undefined);
                throw error;
            }
            const coreSession = this.sharedBrowserCore.createSession(transport, {
                ...(sharedCdpHelper ? { cdpHelper: sharedCdpHelper } : {}),
                actionTimeoutMs: BROWSER_TIMEOUTS.tabOperation,
                // Preserve the desktop Browser contract for renderer-backed page
                // evaluation. Heavy pages can keep Electron's executeJavaScript call
                // pending longer than Browser Core's provider-neutral 15s default.
                commandTimeoutMs: BROWSER_TIMEOUTS.cdpCommand,
                inputCoordinateScaleProvider: () => tab.controller.getInputCoordinateScale(),
                beforePointerAction: (event) => tab.controller.prepareAgentCursorMove(event.point),
                clickNavigationDetectionMs: ELECTRON_CLICK_NAVIGATION_DETECTION_MS,
                captureScreenshot: (captureInput) => this.captureElectronCoreScreenshot(tab, captureInput),
            });
            pageContext = new ElectronBrowserPageContext({
                webContents,
                coreSession,
                onDisposed: () => {
                    this.sharedPageContexts.delete(webContents);
                    this.sharedCoreTabs.delete(tab);
                },
            });
            this.sharedPageContexts.set(webContents, pageContext);
            this.sharedCoreTabs.add(tab);
            pageContext.bindLifecycle();
        }
        pageContext.synchronizeGeneration(tab.navigationGeneration ?? 0);
        const clickProjection = clickAction
            ? this.createAgentClickProjection(tab, input, pageContext)
            : undefined;
        const coreInput = this.normalizeElectronCoreInput(tool, input);
        if (tool === 'navigate' || tool === 'back' || tool === 'forward' || tool === 'reload') {
            tab.lastLoadError = null;
        }
        const result = await this.host.withTabOperation(tab, `browser-core:${tool}`, (operationSignal) => pageContext.execute(tool, coreInput, operationSignal ?? signal), {
            signal,
            operationTimeoutMs: sharedCoreOperationTimeout(tool, coreInput),
        });
        const coreResult = asRecord(result);
        if (tool === 'navigate' && coreResult.success === false && !tab.lastLoadError) {
            const currentUrl = webContents.getURL();
            if (!currentUrl || currentUrl === 'about:blank') {
                tab.lastLoadError = {
                    code: asNumber(coreResult.errorCode),
                    description: safeError(coreResult.error ?? coreResult.message ?? 'Navigation failed'),
                    url: asString(coreInput.url),
                    ts: nowMs(),
                };
            }
        }
        this.host.refreshTabState(tab);
        if (tool === 'navigate' && tab.lastLoadError) {
            const failure = tab.lastLoadError;
            const navigation = isRecord(coreResult.navigation) ? coreResult.navigation : {};
            return {
                used: true,
                result: projectSharedCoreResult(tool, {
                    ...coreResult,
                    success: false,
                    code: 'NAVIGATION_FAILED',
                    error: failure.description || 'Navigation failed.',
                    message: failure.description || 'Navigation failed.',
                    errorCode: failure.code,
                    url: failure.url || asString(coreInput.url),
                    retryable: true,
                    recovery: 'Inspect the current Browser page before deciding whether to retry.',
                    navigation: { ...navigation, detected: true, loaded: false },
                }),
            };
        }
        const projected = projectSharedCoreResult(tool, result);
        return {
            used: true,
            result: clickProjection
                ? tool === 'click_and_wait_for_navigation'
                    ? this.projectAgentNavigationResult(tab, clickProjection, asRecord(projected))
                    : this.projectAgentClickResult(tab, clickProjection, asRecord(projected))
                : projected,
        };
    }
    stripAgentTarget(result) {
        if (!result || typeof result !== 'object' || Array.isArray(result))
            return result;
        const { tabId: _tabId, sessionId: _sessionId, browserState: _browserState, _virtualEditorBaseline, ...safeResult } = result;
        void _virtualEditorBaseline;
        return safeResult;
    }
    normalizeElectronCoreInput(tool, input) {
        if (tool === 'navigate') {
            const url = asString(input.url);
            return url ? { ...input, url: normalizeUrl(url) } : input;
        }
        if (tool === 'wait')
            return this.normalizeAgentWaitArgs(input);
        return input;
    }
    normalizeAuthorizedUploadArgs(args) {
        const files = Array.isArray(args.files) ? args.files.map(asRecord) : [];
        const authorizedFiles = files.filter((file) => asString(file.filePath).length > 0);
        if (authorizedFiles.length === 0 ||
            authorizedFiles.length !== files.length ||
            files.length > 20) {
            throw new Error('FILE_NOT_AUTHORIZED: upload files must come from the current turn');
        }
        const { paths: _untrustedPaths, ...authorizedArgs } = args;
        void _untrustedPaths;
        return { ...authorizedArgs, files: authorizedFiles };
    }
    async captureElectronCoreScreenshot(tab, input) {
        const capture = await this.host.captureTabScreenshot(tab, input);
        const result = {
            success: true,
            format: 'png',
            width: capture.width,
            height: capture.height,
            data: capture.data,
        };
        const filePath = asString(input.file_path);
        if (filePath) {
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, Buffer.from(capture.data, 'base64'));
            result.file_path = filePath;
        }
        return result;
    }
    createAgentSnapshot(tab, result, args, sourceElements, continuationKind = 'inspect') {
        const snapshotId = randomUUID();
        const refs = new Map();
        const semanticTargetRefs = new Map();
        const snapshotElements = new Map();
        const frameRefs = new Map();
        const elements = (sourceElements ?? tab.controller.getElementMapManager().getElementMap())
            .slice()
            .map((element, order) => ({ element, order }))
            .sort((left, right) => {
            const priority = agentElementPriority(left.element) - agentElementPriority(right.element);
            return priority || left.order - right.order;
        })
            .slice(0, MAX_AGENT_SNAPSHOT_ELEMENTS)
            .map(({ element }) => element);
        const orderedRefs = elements.map((element) => {
            const ref = `browser-element:${randomUUID()}`;
            const frameId = element.frameId ?? 'main';
            let frameRef = frameRefs.get(frameId);
            if (!frameRef) {
                frameRef = `browser-frame:${randomUUID()}`;
                frameRefs.set(frameId, frameRef);
            }
            refs.set(ref, {
                backendNodeId: element.backendNodeId,
                frameId,
                frameRef,
            });
            semanticTargetRefs.set(`${frameId}:${element.backendNodeId}`, { ref, frameRef });
            snapshotElements.set(ref, agentSnapshotElement(ref, frameRef, element));
            return ref;
        });
        const createdAt = nowMs();
        const semanticTree = process.env.MAVIS_BROWSER_SEMANTIC_TREE_V1 !== '0' && continuationKind === 'inspect'
            ? tab.controller.getElementMapManager().getSemanticPageTree()
            : null;
        const snapshot = {
            snapshotId,
            generation: tab.navigationGeneration ?? 0,
            continuationKind,
            refs,
            orderedRefs,
            elements: snapshotElements,
            summary: agentSnapshotSummary(result),
            ...(semanticTree ? { semanticTree, semanticTargetRefs } : {}),
            nextOffset: 0,
            createdAt,
            lastAccessedAt: createdAt,
        };
        this.storeAgentSnapshot(tab, snapshot);
        return this.readAgentSnapshotPage(tab, snapshotId, args, continuationKind);
    }
    storeAgentSnapshot(tab, snapshot) {
        const snapshots = this.pruneAgentSnapshots(tab);
        snapshots.set(snapshot.snapshotId, snapshot);
        while (snapshots.size > MAX_AGENT_SNAPSHOTS_PER_TAB) {
            const oldestSnapshotId = Array.from(snapshots.values()).reduce((oldest, candidate) => !oldest || candidate.lastAccessedAt < oldest.lastAccessedAt ? candidate : oldest, undefined)?.snapshotId;
            if (!oldestSnapshotId)
                break;
            snapshots.delete(oldestSnapshotId);
        }
    }
    pruneAgentSnapshots(tab) {
        const snapshots = (tab.agentSnapshots ?? (tab.agentSnapshots = new Map()));
        const generation = tab.navigationGeneration ?? 0;
        const cutoff = nowMs() - AGENT_SNAPSHOT_TTL_MS;
        for (const [snapshotId, snapshot] of snapshots) {
            if (snapshot.generation !== generation || snapshot.lastAccessedAt < cutoff) {
                snapshots.delete(snapshotId);
            }
        }
        return snapshots;
    }
    readAgentSnapshotPage(tab, snapshotId, args, continuationKind = 'inspect') {
        const snapshot = this.pruneAgentSnapshots(tab).get(snapshotId);
        const generation = tab.navigationGeneration ?? 0;
        if (!snapshot || snapshot.generation !== generation) {
            throw new Error('STALE_SNAPSHOT: inspect the page again before reading more elements');
        }
        if (snapshot.continuationKind !== continuationKind) {
            throw new Error('SNAPSHOT_KIND_MISMATCH: continue the snapshot with the action returned by its continuation');
        }
        const offset = Math.max(0, Math.floor(asNumber(args.offset, 0)));
        if (snapshot.nextOffset === null || offset !== snapshot.nextOffset) {
            throw new Error('SNAPSHOT_CONTINUATION_MISMATCH: continue from the exact nextOffset returned by the previous page');
        }
        const limit = Math.max(1, Math.min(MAX_AGENT_SNAPSHOT_PAGE_LIMIT, Math.floor(asNumber(args.limit, DEFAULT_AGENT_SNAPSHOT_PAGE_LIMIT))));
        const totalElements = snapshot.orderedRefs.length;
        const elements = [];
        let includeSemanticTree = true;
        const pageEnd = Math.min(totalElements, offset + limit);
        for (let index = offset; index < pageEnd; index += 1) {
            const ref = snapshot.orderedRefs[index];
            const target = ref ? snapshot.refs.get(ref) : undefined;
            const nextElement = ref ? snapshot.elements.get(ref) : undefined;
            if (!ref || !target || !nextElement) {
                throw new Error('STALE_SNAPSHOT: snapshot content is incomplete; inspect the page again');
            }
            let nextElements = [...elements, nextElement];
            let nextPage = buildAgentSnapshotPage(snapshot, offset, totalElements, nextElements, continuationKind, { includeSemanticTree });
            if (Buffer.byteLength(JSON.stringify(nextPage), 'utf8') > MAX_AGENT_SNAPSHOT_PAGE_BYTES) {
                if (elements.length > 0)
                    break;
                const attributes = asRecord(nextElement.attributes);
                const boundedFirstElement = {
                    ...nextElement,
                    attributes: {},
                    ...(Object.keys(attributes).length > 0 ? { attributesTruncated: true } : {}),
                };
                nextElements = [boundedFirstElement];
                nextPage = buildAgentSnapshotPage(snapshot, offset, totalElements, nextElements, continuationKind, { includeSemanticTree });
                if (Buffer.byteLength(JSON.stringify(nextPage), 'utf8') > MAX_AGENT_SNAPSHOT_PAGE_BYTES) {
                    includeSemanticTree = false;
                    nextPage = buildAgentSnapshotPage(snapshot, offset, totalElements, nextElements, continuationKind, { includeSemanticTree });
                    if (Buffer.byteLength(JSON.stringify(nextPage), 'utf8') > MAX_AGENT_SNAPSHOT_PAGE_BYTES) {
                        throw new Error('BROWSER_RESULT_TOO_LARGE: inspect summary exceeds the result budget');
                    }
                }
            }
            elements.push(nextElements[nextElements.length - 1]);
        }
        const page = buildAgentSnapshotPage(snapshot, offset, totalElements, elements, continuationKind, { includeSemanticTree });
        snapshot.lastAccessedAt = nowMs();
        snapshot.nextOffset = page.truncated === true ? asNumber(page.nextOffset) : null;
        return page;
    }
    async resolveAgentActionArgs(agentTarget, tool, args, signal) {
        const tab = await this.host.requireBrowserTab(agentTarget, {
            createIfMissing: true,
            bounds: OFFSCREEN_BOUNDS,
        });
        const allowPositionFallback = !LEGACY_ACTIONS_REQUIRING_ADDRESSABLE_TARGET.has(tool);
        if (!allowPositionFallback && this.sharedRefNeedsLegacyRefresh(tab, args)) {
            await this.host.withTabOperation(tab, 'browser-ref-bridge', (operationSignal) => tab.controller.inspect({}, { signal: operationSignal ?? signal }).then(() => undefined), { signal });
        }
        if (asRecord(args.source).ref || asRecord(args.target).ref) {
            return {
                ...args,
                source: this.resolveAgentFocusArgs(tab, asRecord(args.source), allowPositionFallback),
                target: this.resolveAgentFocusArgs(tab, asRecord(args.target), allowPositionFallback),
            };
        }
        return this.resolveAgentFocusArgs(tab, args, allowPositionFallback);
    }
    sharedRefNeedsLegacyRefresh(tab, args) {
        const targets = [args, asRecord(args.source), asRecord(args.target)];
        return targets.some((target) => {
            const ref = asString(target.ref);
            if (!ref)
                return false;
            const element = this.resolveSharedCoreRefElement(tab, ref, asString(target.frame));
            return (element !== null &&
                !isElectronAddressableSharedSelector(element.selector) &&
                !tab.controller.getElementMapManager().getElementByBackendNodeId(element.backendNodeId));
        });
    }
    resolveAgentFocusArgs(tab, args, allowPositionFallback = true) {
        const ref = asString(args.ref);
        if (!ref) {
            if (args.frame)
                throw new Error('Browser frame targeting requires an opaque element ref');
            return args;
        }
        if (args.position !== undefined || args.normalized_position !== undefined) {
            throw new Error('AMBIGUOUS_TARGET: use either an element ref or a coordinate position, not both');
        }
        const sharedElement = this.resolveSharedCoreRefElement(tab, ref, asString(args.frame));
        if (sharedElement) {
            const { ref: _ref, frame: _frame, ...rest } = args;
            if (isElectronAddressableSharedSelector(sharedElement.selector)) {
                return { ...rest, selector: sharedElement.selector };
            }
            const currentElement = tab.controller
                .getElementMapManager()
                .getElementByBackendNodeId(sharedElement.backendNodeId);
            if (currentElement) {
                if ((currentElement.frameId ?? 'main') !== (sharedElement.frameId ?? 'main')) {
                    throw new Error('STALE_ELEMENT_REF: element is no longer attached to the inspected frame');
                }
                // Reuse the mature Electron target path when the shared ref can be
                // mapped back to the live ElementMap. It performs scroll-into-view,
                // fresh box-model resolution, and frame-aware coordinate handling.
                return { ...rest, index: currentElement.index };
            }
            if (allowPositionFallback && sharedElement.coordinateSpace === 'main-frame-viewport') {
                return {
                    ...rest,
                    position: {
                        x: sharedElement.rect.x + sharedElement.rect.width / 2,
                        y: sharedElement.rect.y + sharedElement.rect.height / 2,
                    },
                };
            }
            if (!allowPositionFallback) {
                throw new Error('LEGACY_TARGET_UNRESOLVED: inspect the page again before using this action with the returned ref');
            }
            throw new Error('FRAME_COORDINATES_UNAVAILABLE: the shared Browser ref cannot be addressed by the Electron controller');
        }
        const currentElement = this.resolveAgentRefElement(tab, ref, asString(args.frame));
        const { ref: _ref, frame: _frame, ...rest } = args;
        return { ...rest, index: currentElement.index };
    }
    resolveAgentRefElement(tab, ref, frameRef = '') {
        const generation = tab.navigationGeneration ?? 0;
        const snapshots = Array.from(this.pruneAgentSnapshots(tab).values()).reverse();
        const snapshot = snapshots.find((candidate) => candidate.generation === generation && candidate.refs.has(ref));
        if (!snapshot) {
            const sharedElement = this.resolveSharedCoreRefElement(tab, ref, frameRef);
            if (sharedElement) {
                const currentElement = tab.controller
                    .getElementMapManager()
                    .getElementByBackendNodeId(sharedElement.backendNodeId);
                if (currentElement) {
                    if ((currentElement.frameId ?? 'main') !== (sharedElement.frameId ?? 'main')) {
                        throw new Error('STALE_ELEMENT_REF: element is no longer attached to the inspected frame');
                    }
                    return currentElement;
                }
                if (sharedElement.coordinateSpace !== 'main-frame-viewport' ||
                    sharedElement.commandSessionId) {
                    throw new Error('FRAME_COORDINATES_UNAVAILABLE: the shared Browser ref cannot be addressed by the Electron controller');
                }
                return sharedCoreElementToInteractiveElement(sharedElement);
            }
            throw new Error('STALE_ELEMENT_REF: inspect the page again after navigation');
        }
        const target = snapshot.refs.get(ref);
        if (!target)
            throw new Error('STALE_ELEMENT_REF: element reference is no longer available');
        snapshot.lastAccessedAt = nowMs();
        if (frameRef && frameRef !== target.frameRef) {
            throw new Error('STALE_ELEMENT_REF: element frame no longer matches');
        }
        const currentElement = tab.controller
            .getElementMapManager()
            .getElementByBackendNodeId(target.backendNodeId);
        if (!currentElement || (currentElement.frameId ?? 'main') !== target.frameId) {
            throw new Error('STALE_ELEMENT_REF: element is no longer attached to the inspected frame');
        }
        return currentElement;
    }
    resolveSharedCoreRefElement(tab, ref, frameRef = '') {
        const pageContext = this.getSharedPageContext(tab);
        if (!pageContext)
            return null;
        return this.resolveSharedPageContextTarget(pageContext, ref, frameRef)?.element ?? null;
    }
    resolveSharedPageContextTarget(pageContext, ref, frameRef = '') {
        const target = pageContext.resolveOpaqueTarget(ref);
        if (!target)
            return null;
        if (frameRef && frameRef !== target.frameRef) {
            throw new Error('STALE_ELEMENT_REF: element frame no longer matches');
        }
        return target;
    }
    async uploadAgentFiles(agentTarget, args, signal) {
        if (signal?.aborted)
            throw new Error('ABORTED: file upload was cancelled');
        const ref = asString(args.ref);
        if (!ref)
            throw new Error('INVALID_TARGET: upload_files requires an opaque element ref');
        const files = Array.isArray(args.files) ? args.files.map(asRecord) : [];
        const filePaths = files.map((file) => asString(file.filePath)).filter(Boolean);
        if (filePaths.length === 0 || filePaths.length !== files.length || filePaths.length > 20) {
            throw new Error('FILE_NOT_AUTHORIZED: upload files must come from the current turn');
        }
        const tab = await this.host.requireBrowserTab(agentTarget, {
            createIfMissing: true,
            bounds: OFFSCREEN_BOUNDS,
        });
        const frame = asString(args.frame);
        const sharedElement = this.resolveSharedCoreElement(tab, ref, frame);
        let element;
        if (sharedElement) {
            element = sharedElement;
        }
        else if (this.getSharedPageContext(tab)) {
            throw new Error('STALE_ELEMENT_REF: element reference is no longer available');
        }
        else {
            element = this.resolveAgentRefElement(tab, ref, frame);
        }
        const cdp = tab.controller.getCDPHelper();
        if (!cdp)
            throw new Error('CAPABILITY_UNAVAILABLE: browser file upload is unavailable');
        const beforeGeneration = tab.navigationGeneration ?? 0;
        const timeoutMs = Math.max(1, Math.min(120000, asNumber(args.timeout, 30000)));
        const upload = await this.host.withTabOperation(tab, 'upload-files', (operationSignal) => cdp.uploadFilesByBackendNodeId(element.backendNodeId, filePaths, {
            timeoutMs,
            signal: operationSignal ?? signal,
        }), { signal, operationTimeoutMs: timeoutMs + 5000 });
        if ((tab.navigationGeneration ?? 0) !== beforeGeneration) {
            throw new Error('UNEXPECTED_NAVIGATION: upload changed the active page');
        }
        return {
            success: true,
            filesAttached: upload.filesAttached,
            chooserOpened: upload.chooserOpened,
        };
    }
    resolveSharedCoreElement(tab, ref, frameRef) {
        const webContents = this.host.getWebContents(tab);
        if (!webContents || webContents.isDestroyed())
            return null;
        const pageContext = this.getSharedPageContext(tab);
        if (!pageContext)
            return null;
        const target = this.resolveSharedPageContextTarget(pageContext, ref, frameRef);
        return target ? { backendNodeId: target.element.backendNodeId } : null;
    }
    getSharedPageContext(tab) {
        const webContents = this.host.getWebContents(tab);
        if (!webContents || webContents.isDestroyed())
            return null;
        return this.sharedPageContexts.get(webContents) ?? null;
    }
    async clickAndWaitForNavigation(agentTarget, args, signal) {
        const tab = await this.host.requireBrowserTab(agentTarget, {
            createIfMissing: true,
            bounds: OFFSCREEN_BOUNDS,
        });
        const ref = asString(args.ref);
        const element = ref ? this.resolveAgentRefElement(tab, ref, asString(args.frame)) : undefined;
        const resolvedArgs = this.resolveAgentFocusArgs(tab, args);
        const { timeout: _timeout, ...clickArgs } = resolvedArgs;
        const timeoutMs = Math.max(1, Math.min(60000, asNumber(args.timeout, 30000)));
        const target = {
            resolved: true,
            ...(element
                ? {
                    tag: element.tag.slice(0, 80),
                    role: element.type.slice(0, 80),
                    ...(visualRectForElement(element) ? { rect: visualRectForElement(element) } : {}),
                }
                : {}),
        };
        return this.host.withTabOperation(tab, 'click-and-wait-for-navigation', async () => {
            if (signal?.aborted)
                throw new Error('ABORTED: Browser action was cancelled');
            const webContents = this.host.getWebContents(tab);
            if (!webContents || webContents.isDestroyed()) {
                throw new Error('BROWSER_UNAVAILABLE: Browser page is unavailable');
            }
            const startedAt = nowMs();
            const beforeGeneration = tab.navigationGeneration ?? 0;
            const beforeHost = urlHost(tab.url);
            let navigationDetected = false;
            let settled = false;
            let timer;
            let resolveOutcome;
            const cleanup = () => {
                if (timer)
                    clearTimeout(timer);
                timer = undefined;
                webContents.removeListener('did-start-navigation', onDidStartNavigation);
                webContents.removeListener('did-finish-load', onDidFinishLoad);
                webContents.removeListener('did-fail-load', onDidFailLoad);
                webContents.removeListener('destroyed', onDestroyed);
                signal?.removeEventListener('abort', onAbort);
            };
            const settle = (outcome) => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                resolveOutcome(outcome);
            };
            const onDidStartNavigation = (...eventArgs) => {
                if (isMainDocumentNavigation(eventArgs))
                    navigationDetected = true;
            };
            const onDidFinishLoad = () => {
                if (navigationDetected)
                    settle({ status: 'loaded' });
            };
            const onDidFailLoad = (...eventArgs) => {
                const errorCode = asNumber(eventArgs[1]);
                const errorDescription = asString(eventArgs[2]);
                const isMainFrame = eventArgs[4] !== false;
                if (!isMainFrame || errorCode === -3 || errorCode === 0)
                    return;
                navigationDetected = true;
                settle({ status: 'failed', errorCode, errorDescription });
            };
            const onDestroyed = () => settle({ status: 'unavailable' });
            const onAbort = () => settle({ status: 'aborted' });
            const outcomePromise = new Promise((resolve) => {
                resolveOutcome = resolve;
            });
            // Register every listener before the click. This closes the race where
            // a synchronous or zero-delay navigation completes before a later wait call.
            webContents.on('did-start-navigation', onDidStartNavigation);
            webContents.on('did-finish-load', onDidFinishLoad);
            webContents.on('did-fail-load', onDidFailLoad);
            webContents.on('destroyed', onDestroyed);
            signal?.addEventListener('abort', onAbort, { once: true });
            timer = setTimeout(() => settle({ status: 'timeout' }), timeoutMs);
            timer.unref?.();
            let clickResult;
            try {
                clickResult = asRecord(await tab.controller.click(clickArgs));
            }
            catch (error) {
                settle({ status: 'cancelled' });
                throw error;
            }
            if (clickResult.success === false) {
                settle({ status: 'cancelled' });
                return {
                    success: false,
                    code: asString(clickResult.code, 'ACTION_FAILED'),
                    message: asString(clickResult.message, asString(clickResult.error, 'Click failed.')),
                    retryable: clickResult.retryable === true,
                    target,
                    navigation: {
                        detected: navigationDetected,
                        loaded: false,
                        generation: tab.navigationGeneration ?? beforeGeneration,
                        beforeHost,
                        afterHost: urlHost(tab.url),
                    },
                    durationMs: nowMs() - startedAt,
                };
            }
            const outcome = await outcomePromise;
            this.host.refreshTabState(tab);
            const navigation = {
                detected: navigationDetected || (tab.navigationGeneration ?? beforeGeneration) > beforeGeneration,
                loaded: outcome.status === 'loaded',
                generation: tab.navigationGeneration ?? beforeGeneration,
                beforeHost,
                afterHost: urlHost(tab.url),
            };
            const durationMs = nowMs() - startedAt;
            if (outcome.status === 'aborted') {
                throw new Error('ABORTED: Browser action was cancelled');
            }
            if (outcome.status === 'unavailable') {
                return {
                    success: false,
                    code: 'BROWSER_UNAVAILABLE',
                    message: 'The Browser page became unavailable while waiting for navigation.',
                    retryable: true,
                    recovery: 'Inspect the Browser page before deciding whether to retry.',
                    target,
                    navigation,
                    durationMs,
                };
            }
            if (outcome.status === 'failed') {
                return {
                    success: false,
                    code: 'NAVIGATION_FAILED',
                    message: outcome.errorDescription.slice(0, 1024) || 'Navigation failed.',
                    errorCode: outcome.errorCode,
                    retryable: true,
                    recovery: 'Inspect the current Browser page before deciding whether to retry.',
                    target,
                    navigation,
                    durationMs,
                };
            }
            if (outcome.status === 'timeout') {
                return {
                    success: false,
                    code: 'ACTION_TIMEOUT',
                    message: `The click did not finish a main-document navigation within ${timeoutMs}ms.`,
                    retryable: true,
                    recovery: 'Inspect the current Browser page before deciding whether to retry.',
                    target,
                    navigation,
                    durationMs,
                };
            }
            return {
                success: true,
                target,
                navigation,
                durationMs,
            };
        }, { signal, operationTimeoutMs: timeoutMs + 5000 });
    }
    async executeGuardedAgentClick(agentTarget, tool, args, signal) {
        const tab = await this.host.requireBrowserTab(agentTarget, {
            createIfMissing: true,
            bounds: OFFSCREEN_BOUNDS,
        });
        const projection = this.createAgentClickProjection(tab, args);
        const resolvedArgs = this.resolveAgentFocusArgs(tab, args);
        const clickArgs = {
            ...resolvedArgs,
            ...(tool === 'double_click' ? { click_count: 2 } : {}),
        };
        const result = asRecord(await this.host.withTabOperation(tab, tool === 'double_click' ? 'double-click' : 'click', () => tab.controller.click(clickArgs), { signal }));
        return this.projectAgentClickResult(tab, projection, result);
    }
    createAgentClickProjection(tab, args, pageContext) {
        const ref = asString(args.ref);
        const frame = asString(args.frame);
        const sharedElement = ref
            ? pageContext
                ? this.resolveSharedPageContextTarget(pageContext, ref, frame)?.element
                : this.resolveSharedCoreRefElement(tab, ref, frame)
            : null;
        const element = sharedElement
            ? sharedCoreElementToInteractiveElement(sharedElement)
            : ref && !pageContext
                ? this.resolveAgentRefElement(tab, ref, frame)
                : undefined;
        this.host.refreshTabState(tab);
        return {
            ...(element ? { element } : {}),
            beforeGeneration: tab.navigationGeneration ?? 0,
            beforeUrl: tab.url,
        };
    }
    projectAgentClickResult(tab, projection, result) {
        const { element, beforeGeneration, beforeUrl } = projection;
        const runtimeTarget = asRecord(result.target);
        const target = this.projectAgentClickTarget(element, runtimeTarget);
        this.host.refreshTabState(tab);
        const afterGeneration = tab.navigationGeneration ?? beforeGeneration;
        const afterUrl = tab.url;
        const urlChanged = afterUrl !== beforeUrl;
        const navigation = {
            detected: afterGeneration !== beforeGeneration || urlChanged,
            urlChanged,
            generation: afterGeneration,
            beforeHost: urlHost(beforeUrl),
            afterHost: urlHost(afterUrl),
        };
        const sourceEffect = asRecord(result.effect);
        const dispatched = typeof sourceEffect.dispatched === 'boolean'
            ? sourceEffect.dispatched
            : result.success !== false;
        const effect = {
            dispatched,
            verified: false,
            verificationRequired: true,
        };
        const duration = typeof result.duration === 'number'
            ? result.duration
            : typeof result.durationMs === 'number'
                ? result.durationMs
                : undefined;
        const download = projectBrowserDownload(result.download);
        if (result.success === false) {
            if (result.code === 'UNEXPECTED_NAVIGATION') {
                return {
                    success: false,
                    code: 'UNEXPECTED_NAVIGATION',
                    message: 'Ordinary click changed the active Browser page unexpectedly.',
                    retryable: true,
                    recovery: 'Inspect the current page before deciding whether to go back or retry with a newly observed target.',
                    target,
                    effect,
                    navigation,
                    ...(download ? { download } : {}),
                    ...(duration !== undefined ? { duration } : {}),
                };
            }
            const error = asString(result.message, asString(result.error, 'Click failed.'));
            return {
                success: false,
                code: asString(result.code, 'ACTION_FAILED'),
                error,
                message: error,
                retryable: result.retryable === true,
                ...(asString(result.recovery)
                    ? { recovery: asString(result.recovery).slice(0, 1024) }
                    : {}),
                target,
                effect,
                navigation,
                ...(download ? { download } : {}),
                ...(duration !== undefined ? { duration } : {}),
            };
        }
        if (navigation.detected) {
            return {
                success: false,
                code: 'UNEXPECTED_NAVIGATION',
                message: 'Ordinary click changed the active Browser page unexpectedly.',
                retryable: true,
                recovery: 'Inspect the current page before deciding whether to go back or retry with a newly observed target.',
                target,
                effect,
                navigation,
                ...(download ? { download } : {}),
                ...(duration !== undefined ? { duration } : {}),
            };
        }
        return {
            success: true,
            target,
            effect,
            navigation,
            ...(download ? { download } : {}),
            ...(asString(result.recovery) ? { recovery: asString(result.recovery).slice(0, 1024) } : {}),
            ...(duration !== undefined ? { duration } : {}),
        };
    }
    projectAgentNavigationResult(tab, projection, result) {
        const runtimeTarget = asRecord(result.target);
        const target = this.projectAgentClickTarget(projection.element, runtimeTarget);
        const sourceNavigation = asRecord(result.navigation);
        this.host.refreshTabState(tab);
        const afterGeneration = tab.navigationGeneration ?? projection.beforeGeneration;
        const afterUrl = tab.url;
        const urlChanged = afterUrl !== projection.beforeUrl;
        const navigation = {
            detected: sourceNavigation.detected === true ||
                afterGeneration !== projection.beforeGeneration ||
                urlChanged,
            urlChanged: sourceNavigation.urlChanged === true || urlChanged,
            generation: typeof sourceNavigation.generation === 'number'
                ? sourceNavigation.generation
                : afterGeneration,
            beforeHost: urlHost(projection.beforeUrl),
            afterHost: urlHost(afterUrl),
        };
        for (const key of ['loaded', 'awaited']) {
            if (typeof sourceNavigation[key] === 'boolean')
                navigation[key] = sourceNavigation[key];
        }
        if (typeof sourceNavigation.readyState === 'string') {
            navigation.readyState = sourceNavigation.readyState.slice(0, 32);
        }
        const projected = {
            success: result.success === true,
            target,
            navigation,
        };
        for (const key of ['code', 'errorCode', 'retryable', 'recovery', 'url', 'title']) {
            if (result[key] !== undefined)
                projected[key] = result[key];
        }
        const message = asString(result.message, asString(result.error));
        if (message)
            projected.message = message;
        if (typeof result.durationMs === 'number')
            projected.durationMs = result.durationMs;
        else if (typeof result.duration === 'number')
            projected.durationMs = result.duration;
        return projected;
    }
    projectAgentClickTarget(element, runtimeTarget) {
        const elementRect = element ? visualRectForElement(element) : undefined;
        return {
            resolved: true,
            ...(element
                ? {
                    tag: element.tag.slice(0, 80),
                    role: element.type.slice(0, 80),
                    ...(elementRect ? { rect: elementRect } : {}),
                }
                : {}),
            ...(runtimeTarget.resolvedPosition
                ? { resolvedPosition: runtimeTarget.resolvedPosition }
                : {}),
            ...(runtimeTarget.hitTarget ? { hitTarget: runtimeTarget.hitTarget } : {}),
            ...(!element && runtimeTarget.rect ? { rect: runtimeTarget.rect } : {}),
        };
    }
    async executeVerifiedAgentTextAction(agentTarget, tool, args, signal) {
        const tab = await this.host.requireBrowserTab(agentTarget, {
            createIfMissing: true,
            bounds: OFFSCREEN_BOUNDS,
        });
        const cdp = tab.controller.getCDPHelper();
        if (!cdp) {
            return {
                success: false,
                code: 'ACTION_VERIFICATION_UNAVAILABLE',
                message: 'Browser text verification is unavailable for this target.',
                retryable: true,
                recovery: 'Inspect the page again after Browser CDP becomes available; do not assume the value was written.',
            };
        }
        const ref = asString(args.ref);
        const element = this.resolveAgentRefElement(tab, ref, asString(args.frame));
        const inspectRenderedState = (expected) => expected === undefined
            ? cdp.inspectRenderedStateByBackendNodeId(element.backendNodeId)
            : cdp.inspectRenderedStateByBackendNodeId(element.backendNodeId, expected);
        const inspectEditableState = (expected) => expected === undefined
            ? cdp.inspectEditableStateByBackendNodeId(element.backendNodeId)
            : cdp.inspectEditableStateByBackendNodeId(element.backendNodeId, expected);
        const beforeGeneration = tab.navigationGeneration ?? 0;
        const beforeUrl = tab.url;
        const focusedKeyboard = element.inputStrategy === 'focused-keyboard';
        let before;
        let target;
        if (focusedKeyboard) {
            target = {
                tag: element.tag.slice(0, 80),
                role: element.type.slice(0, 80),
                contentEditable: element.attributes.contenteditable === 'true',
                virtual: true,
                ...(visualRectForElement(element) ? { rect: visualRectForElement(element) } : {}),
            };
            if (!agentElementIsEditable(element)) {
                return {
                    success: false,
                    code: 'TARGET_NOT_EDITABLE',
                    message: 'The resolved Browser target is not editable.',
                    retryable: false,
                    recovery: 'Inspect the page and choose an input, textarea, or contenteditable ref.',
                    target,
                };
            }
            before = await inspectRenderedState();
        }
        else {
            const editableBefore = await inspectEditableState();
            target = {
                tag: editableBefore.tag.slice(0, 80),
                role: editableBefore.role.slice(0, 80),
                contentEditable: editableBefore.contentEditable,
                ...(visualRectForElement(element) ? { rect: visualRectForElement(element) } : {}),
            };
            if (!editableBefore.editable) {
                return {
                    success: false,
                    code: 'TARGET_NOT_EDITABLE',
                    message: 'The resolved Browser target is not editable.',
                    retryable: false,
                    recovery: 'Inspect the page and choose an input, textarea, or contenteditable ref.',
                    target,
                };
            }
            before = editableBefore;
        }
        const actionArgs = await this.resolveAgentActionArgs(agentTarget, tool, args, signal);
        const expectedText = tool === 'fill' ? requireTextArg(actionArgs, 'text') : undefined;
        const result = await this.executeTool('type', {
            ...actionArgs,
            ...agentTarget,
            ...(tool === 'fill' ? { clear: true } : {}),
        }, signal);
        this.host.refreshTabState(tab);
        const navigation = {
            detected: (tab.navigationGeneration ?? 0) !== beforeGeneration,
            beforeHost: urlHost(beforeUrl),
            afterHost: urlHost(tab.url),
        };
        if (navigation.detected) {
            return {
                success: false,
                code: 'UNEXPECTED_NAVIGATION',
                message: 'Typing changed the active Browser page unexpectedly.',
                retryable: true,
                recovery: 'Inspect the current page before deciding whether to retry.',
                target,
                navigation,
            };
        }
        if (asRecord(result).success === false) {
            return { ...asRecord(this.stripAgentTarget(result)), target, navigation };
        }
        const virtualEditorBaseline = asRecord(asRecord(result)._virtualEditorBaseline);
        if (focusedKeyboard &&
            typeof virtualEditorBaseline.fingerprint === 'string' &&
            typeof virtualEditorBaseline.textLength === 'number') {
            before = {
                fingerprint: virtualEditorBaseline.fingerprint,
                textLength: virtualEditorBaseline.textLength,
            };
        }
        const inspectState = (expected) => {
            if (focusedKeyboard) {
                return inspectRenderedState(expected);
            }
            return inspectEditableState(expected);
        };
        let after;
        let matchesExpected;
        if (tool === 'fill') {
            const samples = [];
            for (let sampleIndex = 0; sampleIndex < VERIFIED_FILL_SAMPLE_COUNT; sampleIndex += 1) {
                if (sampleIndex > 0) {
                    await new Promise((resolve) => setTimeout(resolve, VERIFIED_FILL_SAMPLE_DELAY_MS));
                    if (signal?.aborted)
                        throw new Error('ABORTED: Browser action was cancelled');
                }
                samples.push(await inspectState(expectedText));
            }
            const finalSample = samples[samples.length - 1];
            const previous = samples[samples.length - 2];
            if (!finalSample || !previous) {
                throw new Error('Browser fill verification did not collect enough samples.');
            }
            after = finalSample;
            matchesExpected =
                previous.matchesExpected === true &&
                    after.matchesExpected === true &&
                    previous.fingerprint === after.fingerprint;
        }
        else {
            after = await inspectState();
        }
        const focusedState = focusedKeyboard
            ? await cdp.inspectFocusedEditableStateByBackendNodeId(element.backendNodeId)
            : null;
        const focused = focusedKeyboard
            ? focusedState?.editable === true &&
                focusedState.focused === true &&
                focusedState.withinTarget === true
            : after.focused === true;
        const effect = {
            focused,
            textChanged: after.fingerprint !== before.fingerprint,
            textLength: after.textLength,
            ...(tool === 'fill' ? { matchesExpected } : {}),
        };
        if (focusedKeyboard && !focused) {
            return {
                success: false,
                code: 'INPUT_FOCUS_REJECTED',
                message: 'The visible editor host no longer owns the current editable focus.',
                retryable: true,
                recovery: 'Inspect the page again and choose the current visible editor ref.',
                target,
                effect,
                navigation,
            };
        }
        if (tool === 'fill' && !matchesExpected) {
            const code = focusedKeyboard
                ? effect.textChanged
                    ? 'INPUT_PARTIAL_EFFECT'
                    : 'INPUT_EVENT_NOT_CONSUMED'
                : 'ACTION_EFFECT_MISMATCH';
            return {
                success: false,
                code,
                message: 'The editable target does not contain the exact requested value after filling.',
                retryable: true,
                recovery: 'Inspect the page and retry with the current editable ref.',
                target,
                effect,
                navigation,
            };
        }
        if (tool === 'type' && !effect.textChanged) {
            return {
                success: false,
                code: focusedKeyboard ? 'INPUT_EVENT_NOT_CONSUMED' : 'ACTION_EFFECT_NOT_OBSERVED',
                message: 'The editable target did not change after typing.',
                retryable: true,
                recovery: 'Inspect the page and retry with the current editable ref.',
                target,
                effect,
                navigation,
            };
        }
        return {
            ...asRecord(this.stripAgentTarget(result)),
            success: true,
            target,
            effect,
            navigation,
        };
    }
    normalizeAgentWaitArgs(args) {
        if (args.frame)
            throw new Error('Browser wait does not accept an unscoped frame target');
        const kind = asString(args.kind);
        if (kind === 'timeout')
            return { kind, timeout: asNumber(args.timeout, 30000) };
        if (kind === 'selector') {
            return {
                selector: asString(args.selector),
                state: asString(args.state, 'visible'),
                timeout: asNumber(args.timeout, 30000),
            };
        }
        if (kind === 'text') {
            return { text: asString(args.text), timeout: asNumber(args.timeout, 30000) };
        }
        if (kind === 'url') {
            return { url: asString(args.url), timeout: asNumber(args.timeout, 30000) };
        }
        if (kind === 'load')
            return { load: true, timeout: asNumber(args.timeout, 30000) };
        throw new Error(`Unsupported browser wait kind: ${kind || 'missing'}`);
    }
    async queryAgentBrowser(agentTarget, args, signal) {
        const normalizedArgs = normalizeAgentQueryArgs(args);
        const kind = asString(normalizedArgs.kind, 'snapshot');
        if (kind === 'snapshot') {
            return this.executeAgentTool(agentTarget, 'inspect', normalizedArgs, signal);
        }
        if (kind === 'editable') {
            const requestedSnapshotId = asString(normalizedArgs.snapshotId);
            if (requestedSnapshotId) {
                const tab = await this.host.requireBrowserTab(agentTarget, {
                    createIfMissing: false,
                    bounds: OFFSCREEN_BOUNDS,
                });
                return this.formatEditableSnapshotPage(this.readAgentSnapshotPage(tab, requestedSnapshotId, normalizedArgs, 'query-editable'));
            }
            if (asNumber(normalizedArgs.offset, 0) > 0) {
                throw new Error('Browser editable query offset requires snapshotId from a previous editable query');
            }
            const result = await this.executeTool('inspect', agentTarget, signal);
            const tab = await this.host.requireBrowserTab(agentTarget, {
                createIfMissing: true,
                bounds: OFFSCREEN_BOUNDS,
            });
            const editableElements = tab.controller
                .getElementMapManager()
                .getElementMap()
                .filter(agentElementIsEditable);
            const page = this.createAgentSnapshot(tab, result, normalizedArgs, editableElements, 'query-editable');
            return this.formatEditableSnapshotPage(page);
        }
        if (kind === 'semantic') {
            return {
                success: false,
                code: 'BROWSER_CORE_UNAVAILABLE',
                error: 'Semantic query requires the shared Browser Core page connection.',
                recovery: 'Keep the Browser tab open, inspect the page, and retry the semantic query.',
            };
        }
        if (kind === 'console') {
            const tab = await this.host.requireBrowserTab(agentTarget, {
                createIfMissing: false,
                bounds: OFFSCREEN_BOUNDS,
            });
            const cdp = tab.controller.getCDPHelper();
            const diagnosticsReady = await cdp?.ensureConsoleDiagnosticsReady(signal);
            if (!diagnosticsReady || !cdp?.isConsoleDiagnosticsAvailable()) {
                return {
                    success: false,
                    code: 'CONSOLE_DIAGNOSTICS_UNAVAILABLE',
                    error: 'Console diagnostics are unavailable for the current Browser tab.',
                    recovery: 'Keep the current Browser tab open and retry once it finishes initializing.',
                };
            }
            const diagnostics = cdp.getConsoleDiagnostics({
                ...(args.levels !== undefined
                    ? {
                        levels: asStringArray(args.levels),
                    }
                    : {}),
                ...(args.filter !== undefined ? { filter: asString(args.filter) } : {}),
                limit: Math.max(1, Math.min(200, Math.floor(asNumber(args.limit, 100)))),
            });
            const state = tab.controller.getState();
            return {
                success: true,
                kind: 'console',
                url: sanitizeConsoleDiagnosticUrl(state.url),
                title: state.title,
                ...diagnostics,
            };
        }
        if (kind === 'network') {
            const tab = await this.host.requireBrowserTab(agentTarget, {
                createIfMissing: false,
                bounds: OFFSCREEN_BOUNDS,
            });
            const cdp = tab.controller.getCDPHelper();
            const diagnosticsReady = await cdp?.ensureNetworkDiagnosticsReady(signal);
            if (!diagnosticsReady || !cdp?.isNetworkDiagnosticsAvailable()) {
                return {
                    success: false,
                    code: 'NETWORK_DIAGNOSTICS_UNAVAILABLE',
                    error: 'Network diagnostics are unavailable for the current Browser tab.',
                    recovery: 'Keep the current Browser tab open and retry once it finishes initializing.',
                };
            }
            const diagnostics = cdp.getNetworkDiagnostics({
                ...(args.status !== undefined
                    ? { status: asStringArray(args.status) }
                    : {}),
                ...(args.resourceTypes !== undefined
                    ? {
                        resourceTypes: asStringArray(args.resourceTypes),
                    }
                    : {}),
                ...(args.filter !== undefined ? { filter: asString(args.filter) } : {}),
                ...(args.afterSequence !== undefined
                    ? {
                        afterSequence: Math.max(0, Math.floor(asNumber(args.afterSequence))),
                    }
                    : {}),
                limit: Math.max(1, Math.min(200, Math.floor(asNumber(args.limit, 100)))),
            });
            const state = tab.controller.getState();
            return {
                success: true,
                kind: 'network',
                url: sanitizeConsoleDiagnosticUrl(state.url),
                title: state.title,
                ...diagnostics,
            };
        }
        if (kind === 'dom') {
            const result = asRecord(await this.executeTool('get_dom', {
                ...(typeof args.selector === 'string' ? { selector: args.selector } : {}),
                ...agentTarget,
            }, signal));
            if (result.success === false) {
                return {
                    ...agentQueryFailure(result),
                    url: result.url,
                    title: result.title,
                };
            }
            const html = asString(result.html);
            const maxChars = Math.max(1, Math.min(50000, asNumber(args.maxChars, 20000)));
            return {
                success: result.success !== false,
                url: result.url,
                title: result.title,
                html: html.slice(0, maxChars),
                truncated: html.length > maxChars || asBoolean(result.htmlTruncated),
                totalLength: asNumber(result.htmlLength, html.length),
            };
        }
        if (kind === 'text') {
            const tab = await this.host.requireBrowserTab(agentTarget, {
                createIfMissing: true,
                bounds: OFFSCREEN_BOUNDS,
            });
            const selector = typeof args.selector === 'string' ? args.selector : null;
            const maxChars = Math.max(1, Math.min(50000, asNumber(args.maxChars, 20000)));
            const result = await this.host.withTabOperation(tab, 'query-text', () => tab.controller.evaluate({
                script: `(() => {
              const selector = ${JSON.stringify(selector)};
              const root = selector ? document.querySelector(selector) : document.body;
              if (!root) throw new Error('Element not found: ' + selector);
              return String(root.innerText || root.textContent || '');
            })()`,
            }), { signal });
            if (result.success === false)
                return agentQueryFailure(asRecord(result));
            const text = asString(result.result);
            return {
                success: true,
                text: text.slice(0, maxChars),
                truncated: text.length > maxChars,
                totalLength: text.length,
            };
        }
        throw new Error(`Unsupported browser query kind: ${kind}`);
    }
    formatEditableSnapshotPage(page) {
        const { elements, totalElements, returnedElements, ...summary } = page;
        return {
            ...summary,
            totalTargets: totalElements,
            returnedTargets: returnedElements,
            targets: elements,
        };
    }
    async executeTool(tool, rawArgs, signal) {
        const args = asRecord(rawArgs);
        const controllerArgs = this.withoutBrowserTarget(args);
        switch (tool) {
            case 'inspect': {
                const tab = await this.requireTab(args);
                const result = await this.host.withTabOperation(tab, 'inspect', (operationSignal) => tab.controller.inspect(controllerArgs, {
                    signal: operationSignal ?? signal,
                }), { signal });
                this.host.refreshTabState(tab);
                return this.withTabId(tab, result);
            }
            case 'navigate': {
                const tab = this.host.resolveBrowserTab(args, { allowLegacyActive: true }) ??
                    (await this.openTabForTarget(args));
                const url = asString(args.url);
                if (!url)
                    throw new Error('url is required');
                tab.lastLoadError = null;
                const normalized = normalizeUrl(url);
                this.host.clearRequestedUrlForNavigation(tab, normalized);
                const result = await this.host.withTabOperation(tab, 'navigate', (operationSignal) => tab.controller.navigate({ url: normalized }, {
                    prepareElementMap: false,
                    signal: operationSignal,
                }), { signal });
                // Some failures (e.g. invalid URLs rejected by loadURL) never fire
                // did-fail-load; surface them so the UI error page can show. Loads
                // that committed (timeouts on slow pages) are not errors.
                const failed = result?.success === false;
                if (failed && !tab.lastLoadError) {
                    const wc = this.host.getWebContents(tab);
                    const currentUrl = wc && !wc.isDestroyed() ? wc.getURL() : '';
                    if (!currentUrl || currentUrl === 'about:blank') {
                        tab.lastLoadError = {
                            code: 0,
                            description: safeError(result.error ?? 'Navigation failed'),
                            url: normalized,
                            ts: nowMs(),
                        };
                    }
                }
                this.host.refreshTabState(tab);
                return { ...result, tabId: tab.tabId };
            }
            case 'click': {
                const tab = await this.requireTab(args);
                return this.withTabId(tab, await this.host.withTabOperation(tab, 'click', () => tab.controller.click(controllerArgs), { signal }));
            }
            case 'drag': {
                const tab = await this.requireTab(args);
                return this.withTabId(tab, await this.host.withTabOperation(tab, 'drag', () => tab.controller.drag(controllerArgs), { signal }));
            }
            case 'check':
            case 'uncheck': {
                const tab = await this.requireTab(args);
                const params = {
                    ...controllerArgs,
                    checked: tool === 'check',
                };
                return this.withTabId(tab, await this.host.withTabOperation(tab, 'set-checked', () => tab.controller.setChecked(params), { signal }));
            }
            case 'select_option': {
                const tab = await this.requireTab(args);
                const params = {
                    ...controllerArgs,
                    values: asStringArray(controllerArgs.values),
                };
                return this.withTabId(tab, await this.host.withTabOperation(tab, 'select-option', () => tab.controller.selectOption(params), { signal }));
            }
            case 'type': {
                const tab = await this.requireTab(args);
                const params = {
                    ...controllerArgs,
                    text: requireTextArg(controllerArgs, 'text'),
                };
                return this.withTabId(tab, await this.host.withTabOperation(tab, 'type', (operationSignal) => tab.controller.type(params, {
                    signal: operationSignal ?? signal,
                }), {
                    signal,
                    operationTimeoutMs: textInputOperationTimeout(params, tab),
                }));
            }
            case 'press_key':
            case 'pressKey': {
                const tab = await this.requireTab(args);
                const params = {
                    ...controllerArgs,
                    key: requireStringArg(controllerArgs, 'key'),
                };
                return this.withTabId(tab, await this.host.withTabOperation(tab, 'press-key', () => tab.controller.pressKey(params), {
                    signal,
                }));
            }
            case 'scroll': {
                const tab = await this.requireTab(args);
                return this.withTabId(tab, await this.host.withTabOperation(tab, 'scroll', () => tab.controller.scroll(controllerArgs), { signal }));
            }
            case 'hover': {
                const tab = await this.requireTab(args);
                return this.withTabId(tab, await this.host.withTabOperation(tab, 'hover', () => tab.controller.hover(controllerArgs), { signal }));
            }
            case 'wait_for':
            case 'waitFor': {
                const tab = await this.requireTab(args);
                const timeoutMs = Math.max(1, Math.min(120000, asNumber(controllerArgs.timeout, 30000)));
                return this.withTabId(tab, await this.host.withTabOperation(tab, 'wait-for', () => tab.controller.waitFor(controllerArgs), { signal, operationTimeoutMs: timeoutMs + 5000 }));
            }
            case 'evaluate': {
                const tab = await this.requireTab(args);
                const params = {
                    ...controllerArgs,
                    script: requireStringArg(controllerArgs, 'script'),
                };
                return this.withTabId(tab, await this.host.withTabOperation(tab, 'evaluate', () => tab.controller.evaluate(params), {
                    signal,
                }));
            }
            case 'get_dom':
            case 'getDOM': {
                const tab = await this.requireTab(args);
                return this.withTabId(tab, await this.host.withTabOperation(tab, 'get-dom', () => tab.controller.getDOM(controllerArgs), { signal }));
            }
            case 'paste': {
                const tab = await this.requireTab(args);
                return this.host.withTabOperation(tab, 'paste', () => this.pasteIntoTab(tab, args), {
                    signal,
                });
            }
            case 'verify_text':
            case 'verifyText': {
                const tab = await this.requireTab(args);
                return this.host.withTabOperation(tab, 'verify-text', () => this.verifyTextInTab(tab, args), { signal });
            }
            case 'inspect_editable_targets':
            case 'inspectEditableTargets': {
                const tab = await this.requireTab(args);
                return this.host.withTabOperation(tab, 'inspect-editable-targets', () => this.inspectEditableTargets(tab, args), { signal });
            }
            case 'screenshot': {
                const tab = await this.requireTab(args);
                const capture = await this.host.withTabOperation(tab, 'screenshot', () => this.host.captureTabScreenshot(tab, controllerArgs), { signal });
                const result = {
                    success: true,
                    format: 'png',
                    width: capture.width,
                    height: capture.height,
                    data: capture.data,
                };
                if (typeof args.file_path === 'string') {
                    await fs.mkdir(path.dirname(args.file_path), { recursive: true });
                    await fs.writeFile(args.file_path, Buffer.from(capture.data, 'base64'));
                    result.file_path = args.file_path;
                }
                return result;
            }
            default:
                throw new Error(`Unknown embedded browser tool: ${tool}`);
        }
    }
    async requireTab(args) {
        return this.host.requireBrowserTab(args, {
            allowLegacyActive: true,
            createIfMissing: true,
            bounds: OFFSCREEN_BOUNDS,
        });
    }
    async openTabForTarget(args) {
        return this.host.requireBrowserTab(args, {
            allowLegacyActive: true,
            createIfMissing: true,
            bounds: OFFSCREEN_BOUNDS,
        });
    }
    withoutBrowserTarget(args) {
        const { sessionId: _sessionId, tabId: _tabId, ...controllerArgs } = args;
        return controllerArgs;
    }
    withTabId(tab, result) {
        if (result && typeof result === 'object') {
            return { ...result, tabId: tab.tabId };
        }
        return { success: true, tabId: tab.tabId, result };
    }
    focusParams(args) {
        if (typeof args.index === 'number')
            return { index: args.index };
        if (typeof args.selector === 'string' && args.selector.trim())
            return { selector: args.selector };
        const normalized = asRecord(args.normalized_position);
        const x = finiteNumber(normalized.x);
        const y = finiteNumber(normalized.y);
        return x !== null && y !== null ? { normalized_position: { x, y } } : null;
    }
    async pasteIntoTab(tab, args) {
        const text = asString(args.text);
        const html = asString(args.html);
        if (!text && !html) {
            return { success: false, tabId: tab.tabId, pasted: false, error: 'text or html is required' };
        }
        const focus = this.focusParams(args);
        if (focus) {
            const focused = await tab.controller.click(focus);
            if (focused.success === false)
                return this.withTabId(tab, focused);
        }
        const modifier = shortcutModifier();
        if (asBoolean(args.clear)) {
            const selectAll = await tab.controller.pressKey({ key: 'A', modifiers: [modifier] });
            if (selectAll.success === false)
                return this.withTabId(tab, selectAll);
            const backspace = await tab.controller.pressKey({ key: 'Backspace' });
            if (backspace.success === false)
                return this.withTabId(tab, backspace);
        }
        const previousClipboard = this.readClipboardSnapshot();
        try {
            clipboard.write({
                text: text || html,
                ...(html ? { html } : {}),
            });
            const pasted = await tab.controller.pressKey({ key: 'V', modifiers: [modifier] });
            const waitMs = finiteNumber(args.waitMs) ?? 300;
            if (waitMs > 0) {
                await tab.controller.waitFor({ timeout: waitMs });
            }
            const clipboardRestored = this.restoreClipboardSnapshot(previousClipboard);
            return {
                ...pasted,
                success: pasted.success !== false,
                tabId: tab.tabId,
                pasted: pasted.success !== false,
                clipboardRestored,
            };
        }
        catch (error) {
            const clipboardRestored = this.restoreClipboardSnapshot(previousClipboard);
            return {
                success: false,
                tabId: tab.tabId,
                pasted: false,
                clipboardRestored,
                error: safeError(error),
            };
        }
    }
    readClipboardSnapshot() {
        try {
            return {
                text: clipboard.readText(),
                html: clipboard.readHTML(),
            };
        }
        catch {
            return null;
        }
    }
    restoreClipboardSnapshot(snapshot) {
        if (!snapshot)
            return false;
        try {
            clipboard.write({
                text: snapshot.text,
                ...(snapshot.html ? { html: snapshot.html } : {}),
            });
            return true;
        }
        catch {
            return false;
        }
    }
    async verifyTextInTab(tab, args) {
        const texts = asStringArray(args.texts).concat(asStringArray(args.text));
        if (texts.length === 0) {
            return { success: false, tabId: tab.tabId, found: false, error: 'text or texts is required' };
        }
        const selector = typeof args.selector === 'string' && args.selector.trim() ? args.selector : null;
        const script = `
      (() => {
        const selector = ${JSON.stringify(selector)};
        const root = selector ? document.querySelector(selector) : document.body;
        if (!root) throw new Error('Element not found: ' + selector);
        const read = (node) => {
          const parts = [];
          if ('value' in node && typeof node.value === 'string') parts.push(node.value);
          if (typeof node.innerText === 'string') parts.push(node.innerText);
          if (typeof node.textContent === 'string') parts.push(node.textContent);
          node.querySelectorAll?.('input, textarea, select').forEach((item) => {
            if ('value' in item && typeof item.value === 'string') parts.push(item.value);
          });
          return parts.join('\\n');
        };
        const haystack = read(root);
        const caseSensitive = ${JSON.stringify(asBoolean(args.caseSensitive))};
        const exact = ${JSON.stringify(asBoolean(args.exact))};
        const needles = ${JSON.stringify(texts)};
        const body = caseSensitive ? haystack : haystack.toLowerCase();
        const matches = [];
        const missing = [];
        for (const needle of needles) {
          const target = caseSensitive ? needle : needle.toLowerCase();
          const ok = exact ? body.trim() === target.trim() : body.includes(target);
          (ok ? matches : missing).push(needle);
        }
        return { haystackLength: haystack.length, matches, missing };
      })();
    `;
        const result = await tab.controller.evaluate({ script });
        if (result.success === false) {
            return {
                ...result,
                tabId: tab.tabId,
                found: false,
                matches: [],
                missing: texts,
            };
        }
        const payload = asRecord(result.result);
        const matches = asStringArray(payload.matches);
        const missing = asStringArray(payload.missing);
        return {
            success: missing.length === 0,
            tabId: tab.tabId,
            found: missing.length === 0,
            matches,
            missing,
            haystackLength: asNumber(payload.haystackLength),
            duration: result.duration,
        };
    }
    async inspectEditableTargets(tab, args) {
        const selector = typeof args.selector === 'string' && args.selector.trim() ? args.selector : null;
        const limit = Math.max(1, Math.min(200, asNumber(args.limit, 80)));
        const script = `
      (() => {
        const rootSelector = ${JSON.stringify(selector)};
        const root = rootSelector ? document.querySelector(rootSelector) : document;
        if (!root) throw new Error('Element not found: ' + rootSelector);
        const targetSelector = [
          'input:not([type="hidden"])',
          'textarea',
          'select',
          '[contenteditable]:not([contenteditable="false"])',
          '[role="textbox"]',
          '[aria-multiline="true"]'
        ].join(',');
        const cssEscape = (value) =>
          window.CSS && typeof window.CSS.escape === 'function'
            ? window.CSS.escape(value)
            : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
        const selectorFor = (element) => {
          if (element.id) return '#' + cssEscape(element.id);
          const testId = element.getAttribute('data-testid');
          if (testId) return '[data-testid="' + String(testId).replace(/"/g, '\\\\"') + '"]';
          const parts = [];
          let node = element;
          while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 6) {
            const tag = node.tagName.toLowerCase();
            const parent = node.parentElement;
            if (!parent) {
              parts.unshift(tag);
              break;
            }
            const siblings = Array.from(parent.children).filter((item) => item.tagName === node.tagName);
            const index = siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : '';
            parts.unshift(tag + index);
            node = parent;
          }
          return parts.join(' > ') || element.tagName.toLowerCase();
        };
        const isVisible = (element, rect) => {
          const style = window.getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
            style.visibility !== 'hidden' && style.opacity !== '0';
        };
        const nodes = [];
        if (root instanceof Element && root.matches(targetSelector)) nodes.push(root);
        root.querySelectorAll?.(targetSelector).forEach((item) => nodes.push(item));
        return nodes.slice(0, ${JSON.stringify(limit)}).map((element, index) => {
          const rect = element.getBoundingClientRect();
          const text = String(element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim();
          const type = element.getAttribute('type') || element.getAttribute('aria-multiline') || '';
          const autocomplete = element.getAttribute('autocomplete') || '';
          const authenticationSecret =
            String(type).toLowerCase() === 'password' ||
            /(?:^|\\s)(?:current-password|new-password|one-time-code)(?:\\s|$)/i.test(autocomplete);
          return {
            targetIndex: index,
            selector: selectorFor(element),
            tagName: element.tagName.toLowerCase(),
            type,
            autocomplete,
            role: element.getAttribute('role') || '',
            ...(authenticationSecret
              ? { valueRedacted: true }
              : {
                  text: text.slice(0, 200),
                  value: 'value' in element && typeof element.value === 'string' ? element.value.slice(0, 200) : '',
                }),
            placeholder: element.getAttribute('placeholder') || '',
            ariaLabel: element.getAttribute('aria-label') || '',
            contentEditable: element.isContentEditable || element.getAttribute('contenteditable') === 'true',
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            visible: isVisible(element, rect),
          };
        });
      })();
    `;
        const result = await tab.controller.evaluate({ script });
        if (result.success === false)
            return this.withTabId(tab, result);
        return {
            success: true,
            tabId: tab.tabId,
            targets: Array.isArray(result.result) ? result.result : [],
            duration: result.duration,
        };
    }
}

function sharedCoreOperationTimeout(tool, input) {
    const requested = asNumber(input.timeout, BROWSER_TIMEOUTS.tabOperation);
    if (tool === 'fill' || tool === 'type') {
        // Browser Core owns the target-aware text deadline. Keep the host timeout
        // outside Core's maximum action budget so it never cancels a valid
        // focused-keyboard action first.
        return BROWSER_TIMEOUTS.longTabOperation;
    }
    const margin = tool === 'click_and_wait_for_navigation' || tool === 'wait' ? 1000 : 5000;
    return Math.min(BROWSER_TIMEOUTS.longTabOperation, Math.max(BROWSER_TIMEOUTS.tabOperation, Math.floor(requested) + margin));
}
export function projectSharedCoreResult(tool, result) {
    if (!result || typeof result !== 'object' || Array.isArray(result))
        return result;
    const source = result;
    const projected = {};
    const commonKeys = [
        'success',
        'url',
        'title',
        'durationMs',
        'duration',
        'error',
        'message',
        'code',
        'errorCode',
        'retryable',
        'recovery',
        'snapshotId',
        'offset',
        'nextOffset',
        'truncated',
        'continuation',
        'viewport',
        'scrollPosition',
        'pageHeight',
        'pageWidth',
        'elements',
        'targets',
        'semanticTree',
        'semanticTreeOmitted',
        'totalElements',
        'returnedElements',
        'totalTargets',
        'returnedTargets',
        'kind',
        'query',
        'matchCount',
        'returnedMatches',
        'text',
        'totalLength',
        'html',
        'entries',
        'lastSequence',
        'totalEntries',
        'returnedEntries',
    ];
    const actionKeys = {
        click: ['target', 'effect', 'navigation', 'download'],
        double_click: ['target', 'effect', 'navigation', 'download'],
        click_and_wait_for_navigation: ['target', 'effect', 'navigation'],
        navigate: ['navigation'],
        back: ['navigation'],
        forward: ['navigation'],
        reload: ['navigation'],
        drag: ['target', 'effect', 'mode', 'dragStarted', 'dropDispatched'],
        hover: ['target', 'effect'],
        fill: ['target', 'effect', 'navigation'],
        type: ['target', 'effect', 'navigation'],
        press_key: ['target', 'effect'],
        check: ['target', 'effect'],
        uncheck: ['target', 'effect'],
        select_option: ['target', 'effect'],
        scroll: ['target', 'effect'],
        wait: ['kind', 'waitedMs'],
        screenshot: ['format', 'width', 'height', 'data', 'file_path'],
        upload_files: ['target', 'effect', 'filesAttached', 'chooserOpened', 'navigation'],
    };
    const keys = new Set([...commonKeys, ...(actionKeys[tool] ?? [])]);
    for (const key of keys) {
        if (source[key] !== undefined)
            projected[key] = source[key];
    }
    if (projected.duration === undefined) {
        if (typeof source.durationMs === 'number')
            projected.duration = source.durationMs;
        else if (tool === 'wait' && typeof source.waitedMs === 'number') {
            projected.duration = source.waitedMs;
        }
    }
    for (const key of ['elements', 'targets']) {
        const values = source[key];
        if (Array.isArray(values))
            projected[key] = values.map(projectSharedCoreElement);
    }
    if (isRecord(projected.target))
        projected.target = projectSharedCoreTarget(projected.target);
    if (isRecord(projected.effect))
        projected.effect = projectSharedCoreEffect(projected.effect);
    if (isRecord(projected.navigation)) {
        projected.navigation = projectSharedCoreNavigation(projected.navigation);
    }
    const download = projectBrowserDownload(projected.download);
    if (download)
        projected.download = download;
    else
        delete projected.download;
    if ((tool === 'click' || tool === 'double_click') &&
        source.code === 'NO_CLICK_EFFECT' &&
        source.success === false) {
        projected.success = true;
        projected.effect = {
            ...(asRecord(source.effect) ?? {}),
            dispatched: true,
            verified: false,
            verificationRequired: true,
        };
        delete projected.code;
        delete projected.error;
        delete projected.recovery;
    }
    if ((tool === 'click' || tool === 'double_click') && source.success === true) {
        // Electron's established Agent contract only guarantees that the input
        // was dispatched. Keep Core's richer effect verification internal to the
        // provider so existing desktop callers still verify the business result
        // with inspect/query/screenshot.
        projected.effect = {
            dispatched: true,
            verified: false,
            verificationRequired: true,
        };
    }
    if ((tool === 'back' || tool === 'forward') && source.success === false && !source.error) {
        projected.error = tool === 'back' ? 'Cannot go back' : 'Cannot go forward';
    }
    return projected;
}
function projectBrowserDownload(value) {
    if (!isRecord(value))
        return undefined;
    const download = {};
    if (value.state === 'inProgress' || value.state === 'completed' || value.state === 'canceled') {
        download.state = value.state;
    }
    if (value.observation === 'timeout')
        download.observation = 'timeout';
    const suggestedFilename = asString(value.suggestedFilename, asString(value.fileName));
    if (suggestedFilename)
        download.suggestedFilename = suggestedFilename.slice(0, 255);
    for (const key of ['receivedBytes', 'totalBytes']) {
        if (typeof value[key] === 'number' && Number.isFinite(value[key])) {
            download[key] = Math.max(0, Math.floor(value[key]));
        }
    }
    return Object.keys(download).length > 0 ? download : undefined;
}
function projectSharedCoreElement(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return value;
    const source = value;
    const sourceCoordinateSpace = asString(source.coordinateSpace, 'main-frame-viewport');
    const coordinateSpace = sourceCoordinateSpace === 'frame-local' || sourceCoordinateSpace === 'unavailable'
        ? sourceCoordinateSpace
        : 'main-frame-viewport';
    const rectSource = asRecord(source.rect) ?? asRecord(source.boundingBox);
    const inViewport = typeof source.inViewport === 'boolean' ? source.inViewport : source.isInViewport === true;
    const actionable = typeof source.actionable === 'boolean' ? source.actionable : source.isInteractable === true;
    const pointerActionable = typeof source.pointerActionable === 'boolean'
        ? source.pointerActionable
        : actionable && coordinateSpace === 'main-frame-viewport';
    const projected = {
        ref: asString(source.ref),
        tag: asString(source.tag).slice(0, 80),
        type: asString(source.type).slice(0, 120),
        text: asString(source.text).slice(0, 300),
        selector: asString(source.selector).slice(0, 500),
        attributes: boundedSharedCoreAttributes(source.attributes),
        inViewport,
        actionable,
        pointerActionable,
        coordinateSpace,
    };
    if (coordinateSpace !== 'unavailable' && rectSource) {
        const rect = boundedSharedCoreRect(rectSource);
        if (rect)
            projected.rect = rect;
    }
    const frame = asString(source.frame);
    if (frame)
        projected.frame = frame;
    return projected;
}
function projectSharedCoreTarget(value) {
    const projected = {};
    if (value.resolved !== undefined)
        projected.resolved = value.resolved;
    for (const key of ['tag', 'role']) {
        if (typeof value[key] === 'string')
            projected[key] = value[key].slice(0, 80);
    }
    for (const key of ['contentEditable', 'virtual']) {
        if (typeof value[key] === 'boolean')
            projected[key] = value[key];
    }
    const rect = asRecord(value.rect);
    if (rect) {
        const bounded = boundedSharedCoreRect(rect);
        if (bounded)
            projected.rect = bounded;
    }
    const resolvedPosition = asRecord(value.resolvedPosition);
    if (resolvedPosition) {
        const x = finiteNumber(resolvedPosition.x);
        const y = finiteNumber(resolvedPosition.y);
        if (x !== null && y !== null)
            projected.resolvedPosition = { x, y };
    }
    const hitTarget = asRecord(value.hitTarget);
    if (hitTarget) {
        const projectedHitTarget = {};
        for (const key of ['tag', 'role', 'name', 'text']) {
            if (typeof hitTarget[key] === 'string')
                projectedHitTarget[key] = hitTarget[key].slice(0, 300);
        }
        const hitRect = asRecord(hitTarget.rect);
        if (hitRect) {
            const bounded = boundedSharedCoreRect(hitRect);
            if (bounded)
                projectedHitTarget.rect = bounded;
        }
        if (Object.keys(projectedHitTarget).length > 0)
            projected.hitTarget = projectedHitTarget;
    }
    return projected;
}
function projectSharedCoreEffect(value) {
    const projected = {};
    const booleanKeys = [
        'dispatched',
        'verified',
        'verificationRequired',
        'observed',
        'moved',
        'atStart',
        'atEnd',
        'focusChanged',
        'targetStateChanged',
        'textChanged',
        'focused',
        'matchesExpected',
        'hovered',
        'tooltipObserved',
        'checked',
        'chooserOpened',
    ];
    for (const key of booleanKeys) {
        if (typeof value[key] === 'boolean')
            projected[key] = value[key];
    }
    const numberKeys = [
        'mutations',
        'actualDeltaX',
        'actualDeltaY',
        'textLength',
        'expectedTextLength',
        'fileCount',
    ];
    for (const key of numberKeys) {
        if (typeof value[key] === 'number' && Number.isFinite(value[key]))
            projected[key] = value[key];
    }
    if (Array.isArray(value.selectedValues)) {
        projected.selectedValues = value.selectedValues
            .filter((item) => typeof item === 'string')
            .slice(0, 20)
            .map((item) => item.slice(0, 500));
    }
    const semantic = isRecord(value.semantic) ? value.semantic : null;
    if (semantic) {
        projected.semantic = {
            name: asString(semantic.name).slice(0, 500),
            source: asString(semantic.source).slice(0, 80),
            confidence: asString(semantic.confidence).slice(0, 20),
            supportingText: asString(semantic.supportingText).slice(0, 500),
        };
    }
    return projected;
}
function projectSharedCoreNavigation(value) {
    const projected = {};
    for (const key of ['detected', 'urlChanged', 'loaded', 'awaited']) {
        if (typeof value[key] === 'boolean')
            projected[key] = value[key];
    }
    if (typeof value.generation === 'number' && Number.isFinite(value.generation)) {
        projected.generation = value.generation;
    }
    if (typeof value.readyState === 'string')
        projected.readyState = value.readyState.slice(0, 32);
    return projected;
}
function boundedSharedCoreAttributes(value) {
    const attributes = asRecord(value);
    return Object.fromEntries(Object.entries(attributes)
        .slice(0, 20)
        .map(([key, attributeValue]) => [key.slice(0, 120), asString(attributeValue).slice(0, 300)]));
}
function boundedSharedCoreRect(value) {
    const x = finiteNumber(value.x);
    const y = finiteNumber(value.y);
    const width = finiteNumber(value.width);
    const height = finiteNumber(value.height);
    if (x === null || y === null || width === null || height === null)
        return undefined;
    return { x, y, width, height };
}
function sharedCoreElementToInteractiveElement(element) {
    return {
        index: -1,
        backendNodeId: element.backendNodeId,
        selector: element.selector ?? '',
        tag: element.tag,
        type: element.type,
        text: element.text,
        // Shared refs are converted back to selector/position arguments before
        // reaching the legacy controller. Keep this field conservative because
        // the shared record does not carry the Electron viewport dimensions.
        normalizedPosition: { x: 0.5, y: 0.5 },
        boundingBox: { ...element.rect },
        coordinateSpace: element.coordinateSpace === 'main-frame-viewport' ? 'main-frame-viewport' : 'unavailable',
        isInViewport: true,
        isInteractable: element.isInteractable !== false,
        attributes: { ...element.attributes },
        ...(element.frameId ? { frameId: element.frameId } : {}),
        ...(element.commandSessionId ? { commandSessionId: element.commandSessionId } : {}),
        ...(element.virtualEditor ? { inputStrategy: 'focused-keyboard' } : {}),
    };
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isElectronAddressableSharedSelector(selector) {
    const normalized = selector?.trim() ?? '';
    return (normalized.length > 0 && !/^\[data-backend-node-id=(?:"\d+"|'\d+'|\d+)\]$/u.test(normalized));
}
