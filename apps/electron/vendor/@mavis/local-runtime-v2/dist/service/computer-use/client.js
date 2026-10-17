/** Fail-closed client for sessions where the CUA utility is not connected. */
export function createUnavailableComputerUseClient(reason = 'computer_unavailable') {
    return {
        async ensureReady() {
            throw new Error(reason);
        },
        async call() {
            throw new Error(reason);
        },
        release() { },
    };
}
/** Direct request/response client used inside local-runtime-v2 utility. */
export function createComputerUsePortClient(input) {
    const pending = new Map();
    let sequence = 0;
    let closed = false;
    const nextId = input.requestId ?? (() => `computer-${Date.now().toString(36)}-${++sequence}`);
    input.port.on('message', (event) => {
        const response = event.data;
        if (!response || typeof response.requestId !== 'string')
            return;
        const waiter = pending.get(response.requestId);
        if (!waiter)
            return;
        pending.delete(response.requestId);
        waiter.cleanup();
        if (response.generation !== input.generation) {
            waiter.reject(new Error('computer_generation_mismatch'));
        }
        else if (response.ok) {
            waiter.resolve(response.result);
        }
        else {
            waiter.reject(new Error(response.error?.code ?? 'computer_driver_error'));
        }
    });
    input.port.on('close', () => {
        closed = true;
        input.logger?.info({ event: 'computer_use_channel_close', generation: input.generation, pending: pending.size }, 'Computer Use runtime channel closed');
        for (const waiter of pending.values()) {
            waiter.cleanup();
            waiter.reject(new Error('computer_channel_closed'));
        }
        pending.clear();
        input.onClose?.();
    });
    input.port.start?.();
    return {
        async ensureReady() {
            if (closed)
                throw new Error('computer_channel_closed');
        },
        call(request, signal) {
            if (closed)
                return Promise.reject(new Error('computer_channel_closed'));
            if (signal?.aborted)
                return Promise.reject(new Error('computer_aborted'));
            const requestId = nextId();
            return new Promise((resolve, reject) => {
                const onAbort = () => {
                    pending.delete(requestId);
                    signal?.removeEventListener('abort', onAbort);
                    try {
                        input.port.postMessage({
                            type: 'cua-cancel',
                            requestId,
                            generation: input.generation,
                        });
                    }
                    catch {
                        // The local rejection is authoritative if the channel is already closed.
                    }
                    reject(new Error('computer_aborted'));
                };
                pending.set(requestId, {
                    request,
                    resolve,
                    reject,
                    cleanup: () => signal?.removeEventListener('abort', onAbort),
                });
                signal?.addEventListener('abort', onAbort, { once: true });
                try {
                    input.port.postMessage({
                        version: 1,
                        requestId,
                        kind: request.kind,
                        sessionId: request.sessionId,
                        ...(request.turnId ? { turnId: request.turnId } : {}),
                        generation: input.generation,
                        ...(request.leaseId ? { leaseId: request.leaseId } : {}),
                        payload: request.payload,
                    });
                }
                catch (error) {
                    signal?.removeEventListener('abort', onAbort);
                    pending.delete(requestId);
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            });
        },
        release(sessionId, turnId) {
            try {
                input.port.postMessage({
                    type: 'cua-release',
                    ...(turnId ? { turnId } : {}),
                    generation: input.generation,
                    ...(sessionId ? { sessionId } : {}),
                });
            }
            catch {
                // The lease disappears with a closed channel; release is best-effort.
            }
        },
    };
}
export function computerUseToolResult(name, value) {
    const record = isRecord(value) ? value : undefined;
    const unresolved = name === 'computer_app_state' && isUnresolvedWindow(record);
    let text = computerUseResultText(name, value, record);
    const content = [{ type: 'text', text }];
    const images = trustedResultImages(record, unresolved);
    for (const image of images) {
        const resolved = computerUseResultImage(image);
        if (!resolved)
            continue;
        // Never inflate an oversized binary into the text field. The SDK normally
        // returns bounded screenshots; this fallback keeps malformed/unsupported
        // formats fail-closed while retaining ordinary image results.
        if (resolved.data.length <= 7_000_000)
            content.push({ type: 'image', ...resolved });
    }
    text = describeScreenshotAvailability(name, text, content);
    content[0] = { type: 'text', text };
    const result = {
        tool_name: name,
        text,
        content,
        ...(record?.isError === true || unresolved ? { isError: true } : {}),
        ...(record?.structuredJson !== undefined
            ? { details: { structuredJson: record.structuredJson } }
            : {}),
    };
    return result;
}
function describeScreenshotAvailability(name, text, content) {
    if (name !== 'computer_app_state' || content.some((item) => item.type === 'image'))
        return text;
    return `No screenshot is included in this observation. Do not describe a previous image as the current rendered state; request include_screenshot:true if visual verification is needed.\n\n${text}`;
}
function trustedResultImages(record, unresolved) {
    // A closed-window crop can contain another app even with screenshot_frame_valid=true.
    if (unresolved)
        return [];
    return Array.isArray(record?.images) ? record.images : [];
}
function isUnresolvedWindow(record) {
    const state = record ? parseStructuredRecord(record) : undefined;
    return (typeof state?.degraded_reason === 'string' &&
        state.degraded_reason.startsWith('ax_window_unresolved'));
}
function computerUseResultText(name, value, record) {
    const sourceText = baseComputerUseResultText(value, record);
    const verification = verificationResultText(name, sourceText, record);
    if (verification !== undefined)
        return verification;
    const rawText = name === 'computer_window_list' ? formatWindowList(sourceText, record) : sourceText;
    const nativeText = name === 'computer_desktop_state' ? desktopCoordinateText(rawText, record) : rawText;
    const stateText = name === 'computer_app_state' ? exposeElementState(nativeText, record) : nativeText;
    const tokenText = exposeElementTokens(stateText, record);
    const baseText = name === 'computer_app_state'
        ? summarizeWindowButtons(compactApplicationMenus(tokenText, record), record)
        : tokenText;
    const coverage = name === 'computer_app_state'
        ? [
            truncatedObservationText(nativeText),
            windowCoverageText(record, nativeText),
            backgroundRouteText(record),
            editableSnapshotFidelityText(record),
        ]
            .filter(Boolean)
            .join('\n\n')
        : '';
    const appActivity = name === 'computer_app_list' ? appActivityText(record) : '';
    const observation = [appActivity, coverage, baseText].filter(Boolean).join('\n\n');
    const guidance = computerUseOperationalGuidance(record, name) || missingClickEffectGuidance(name, record);
    return guidance ? `${observation}\n${guidance}` : observation;
}
/** An SDK receipt without effect metadata cannot establish a UI postcondition. */
function missingClickEffectGuidance(name, record) {
    if (name !== 'computer_click' || record?.isError === true)
        return '';
    const state = record ? parseStructuredRecord(record) : undefined;
    if (state?.effect !== undefined || state?.code || state?.error)
        return '';
    return 'This click result contains no structured UI-effect verification. Read fresh state of the same target before dependent input or claiming success; an Invoke/Press receipt alone does not prove the requested conversation, page or input field opened. If unchanged, inspect a fresh screenshot and supported alternative route instead of repeating the same click blindly.';
}
const taskVerificationGuidance = 'A satisfied check proves only the supplied predicates, not completion of the user request. Derive expected values from the original user request, including all text, whitespace and non-ASCII characters; do not shorten expectations to match your own action arguments or observed output. Verify the intended target and every requested outcome before claiming completion.';
/** Surface native focus evidence that the SDK's human-readable app list omits. */
function appActivityText(record) {
    const state = record ? parseStructuredRecord(record) : undefined;
    if (!Array.isArray(state?.apps))
        return '';
    const active = state.apps.filter(isRecord).filter((app) => app.active === true);
    if (active.length === 0) {
        return 'No active application is identified in the returned app list. This list may be filtered or activity may be unreported; do not infer that no application has focus.';
    }
    return `Native active application observation: ${JSON.stringify(active.map(({ name, pid, bundle_id }) => ({ name, pid, bundle_id })))}. This is a point-in-time observation, not proof that focus stayed unchanged between calls. Background delivery alone does not prove focus preservation.`;
}
function verificationResultText(name, sourceText, record) {
    if (name !== 'computer_verify_state')
        return undefined;
    const state = record ? parseStructuredRecord(record) : undefined;
    if (Array.isArray(state?.predicates)) {
        const predicates = state.predicates
            .slice(0, 8)
            .filter(isRecord)
            .map((item) => ({
            index: item.index,
            status: item.status,
            unknown_reason: item.unknown_reason,
        }));
        return `${sourceText}\n\nVerification predicates: ${JSON.stringify(predicates)}\nUnknown or unsatisfied is not success. For invalid_predicate, correct the predicate structure instead of retrying unchanged. Do not add invented selector placeholders for a window-only check. ${taskVerificationGuidance}`;
    }
    return `${sourceText}\n\n${taskVerificationGuidance}`;
}
/** The pinned macOS SDK normalizes AX values before serializing the observation. */
function editableSnapshotFidelityText(record) {
    const state = record ? parseStructuredRecord(record) : undefined;
    if (!Array.isArray(state?.elements) ||
        !state.elements.some((element) => isRecord(element) &&
            ['AXTextArea', 'AXTextField', 'AXComboBox'].includes(String(element.role)))) {
        return '';
    }
    return "Text fidelity limitation: CUA Driver 0.22.1 macOS AX snapshots may trim leading/trailing whitespace, including the final newline. The displayed value is not a lossless copy of the document. For a partial edit, use the application's targeted find/replace or a verified selection; do not rebuild the entire document from this snapshot. Whole-value replacement is appropriate only when the user explicitly supplies or authorizes the complete replacement. AX readback alone cannot prove that untouched whitespace was preserved.";
}
/** Window prerequisites do not prove a particular element's ancestry or writability. */
/** Keep current per-window state adjacent to its identity, without dropping native fields. */
function formatWindowList(rawText, record) {
    if (record?.isError === true)
        return rawText;
    let state = record ? (parseStructuredRecord(record) ?? record) : undefined;
    if (!Array.isArray(state?.windows)) {
        try {
            const parsed = JSON.parse(rawText);
            state = isRecord(parsed) ? parsed : undefined;
        }
        catch {
            return rawText;
        }
    }
    if (!Array.isArray(state?.windows) || !state.windows.every(isRecord))
        return rawText;
    const { windows, ...metadata } = state;
    const rows = windows.map((window) => {
        const { window_ref, is_on_screen, on_current_space, ...details } = window;
        return [
            `Window ${JSON.stringify(window_ref ?? window.window_id ?? 'unidentified')}: is_on_screen=${observedFlag(is_on_screen)}; on_current_space=${observedFlag(on_current_space)}`,
            `  Native details: ${JSON.stringify(details)}`,
        ].join('\n');
    });
    return [
        'Current window observations. is_on_screen is not foreground focus. on_current_space=null or missing means unknown, not off-Space; do not infer a need to activate or move the window from unknown Space metadata. A hidden window can reopen with the same window_ref; unchanged IDs do not mean unchanged visibility. Inspect the exact window with computer_app_state before concluding that recovery succeeded or failed.',
        `Native list metadata: ${JSON.stringify(metadata)}`,
        ...rows,
        ...(rows.length === 0 ? ['No windows reported.'] : []),
    ].join('\n');
}
function observedFlag(value) {
    if (value === undefined)
        return 'unknown (not reported)';
    if (value === null)
        return 'unknown (null)';
    return JSON.stringify(value);
}
function backgroundRouteText(record) {
    const state = record ? parseStructuredRecord(record) : undefined;
    if (!state || !isRecord(state.background_input))
        return '';
    const routes = state.background_input.routes;
    if (!Array.isArray(routes))
        return '';
    const knownRoutes = ['accessibility', 'window_pointer', 'pid_keyboard'];
    const entries = routes
        .filter((route) => isRecord(route) &&
        knownRoutes.includes(String(route.route)) &&
        ['available', 'refused'].includes(String(route.status)))
        .map((route) => `${route.route}: ${route.status}${typeof route.reason === 'string' ? ` (${route.reason})` : ''}`);
    if (!entries.length)
        return '';
    return `Native background route prerequisites: ${entries.join('; ')}. These are window-level observations, not proof that a specific element is writable. Each action revalidates its target and host restrictions still apply. A refused pid_keyboard route does not disable available accessibility actions; prefer a fresh supported element action and verify its effect.`;
}
/** Derive desktop capture units from measured dimensions instead of a stale scale hint. */
function desktopCoordinateText(text, record) {
    const state = record ? parseStructuredRecord(record) : undefined;
    if (!state || state.platform !== 'macos')
        return text;
    const dimensions = [
        state.screenshot_width,
        state.screenshot_height,
        state.screen_width,
        state.screen_height,
    ];
    if (!dimensions.every((value) => typeof value === 'number' && Number.isFinite(value) && value > 0))
        return text;
    const [width, height, screenWidth, screenHeight] = dimensions;
    // The native scale_factor can be 1 even when the capture contains two pixels per point.
    // Preserve raw metadata for diagnostics; make the action-facing units unambiguous.
    return text.replace(/^desktop screenshot[^\n]*/u, `desktop screenshot ${width}x${height} px (screen ${screenWidth}x${screenHeight} pts; pixels per point: x=${width / screenWidth}, y=${height / screenHeight}). Desktop action x/y use these screenshot pixels; do not divide them by the pixels-per-point ratio.`);
}
/** Keep large application menus from externalizing the window's actionable controls. */
function compactApplicationMenus(text, record) {
    if (text.length <= 16_000)
        return text;
    const state = record ? parseStructuredRecord(record) : undefined;
    // Explicit semantic queries may intentionally target a menu; preserve those results.
    if (!state ||
        typeof state.filtered_element_count === 'number' ||
        !Array.isArray(state.elements)) {
        return text;
    }
    const menu = state.elements.find((element) => isRecord(element) &&
        element.role === 'AXMenuBar' &&
        element.depth === 0 &&
        Number.isInteger(element.element_index));
    if (!menu)
        return text;
    const pattern = new RegExp(`^- \\[${menu.element_index}\\] AXMenuBar\\b`, 'mu');
    const start = text.search(pattern);
    if (start < 0)
        return text;
    // Never discard a subsequent window or a different surface.
    if (/^- (?:\[[0-9]+\] )?AXWindow\b/mu.test(text.slice(start)))
        return text;
    return `${text.slice(0, start).trimEnd()}\n\nApplication menu subtree omitted from this large default observation. Window controls and their element tokens are retained. To inspect a menu, call computer_app_state with query set to the visible menu label (for example 文件 or File). The header total includes omitted menu elements.`;
}
/** Keep window-owned buttons discoverable when a large document tree is externalized. */
function summarizeWindowButtons(text, record = {}) {
    if (text.length <= 16_000 || record.isError === true || isUnresolvedWindow(record))
        return text;
    const state = parseStructuredRecord(record);
    if (!state || typeof state.filtered_element_count === 'number' || !Array.isArray(state.elements))
        return text;
    const root = state.elements.find((node) => isRecord(node) && node.role === 'AXWindow' && node.depth === 0);
    if (!isRecord(root) || !Number.isInteger(root.element_index))
        return text;
    const indices = new Set(state.elements
        .filter((node) => isRecord(node) &&
        node.role === 'AXButton' &&
        node.parent_index === root.element_index &&
        Number.isInteger(node.element_index))
        .map((node) => node.element_index));
    const lines = text
        .split('\n')
        .filter((line) => {
        const match = /^\s*- \[(\d+)\] AXButton\b/u.exec(line);
        return match && indices.has(Number(match[1]));
    })
        .slice(0, 12);
    if (lines.length === 0)
        return text;
    return `Window AXButton controls (up to 12 under the rendered window root; native layout containers may be collapsed; not semantic labels). Identify controls from a fresh screenshot before acting; do not infer close/minimize from order or position alone.\n${lines.map((line) => line.trim()).join('\n')}\n\nFull window observation follows:\n${text}`;
}
/** The pinned native driver reports its walk limit in the observation text. */
function truncatedObservationText(text) {
    if (!/AX tree truncated at \d+ nodes/u.test(text))
        return '';
    return 'Incomplete AX observation: the native tree walk reached its node limit BEFORE semantic filtering. Zero query matches do not prove the control or menu is absent. Retry this exact window once with the same query, omitting max_elements and max_depth to use native defaults (or increase limits if already using defaults). Do not cycle through synonyms with the same or smaller limits. If the wider observation remains incomplete, use a fresh screenshot to locate the target; do not infer coordinates from this partial tree.';
}
function windowCoverageText(record, text) {
    const state = record ? parseStructuredRecord(record) : undefined;
    if (!state || isUnresolvedWindow(record))
        return '';
    if (isApplicationMenuOnlyQuery(state)) {
        return 'This query matched only application menu entries, not controls inside the requested window. To execute an observed menu command, use computer_secondary_action with action:"show_menu", the same pid/window_ref, and path containing its complete displayed hierarchy (menu label then item label). This invokes the menu command; it does not require a menu element_token. Menu tokens are not window input targets. In particular, the macOS Help menu Search field does not search application content. For controls inside the document, inspect this window without query; if it is an overlay, reacquire the actual content window. Do not use set_value or window clicks/keys against menu tokens.';
    }
    if (state.filtered_element_count === 0) {
        if (truncatedObservationText(text))
            return '';
        return 'Semantic query returned 0 matches. The header element count is the unfiltered total, not matching controls. After input, a placeholder may disappear from the label/value; zero matches for its old text do not prove the field is absent or input failed. Query relevant text already observed in the target, or inspect this exact window once without query if no reliable locator remains. Reacquire a fresh token and verify the expected value or a fresh screenshot before retrying input; do not guess coordinates.';
    }
    // A semantic query can retain the window title while omitting every control.
    // Absence in that subset says nothing about the full window's AX coverage.
    if (typeof state.filtered_element_count === 'number')
        return '';
    return unfilteredWindowCoverageText(state);
}
function unfilteredWindowCoverageText(state) {
    if (!Array.isArray(state.elements))
        return '';
    const elements = state.elements.filter(isRecord);
    const rootIndex = elements.findIndex((item) => item.role === 'AXWindow');
    const root = elements[rootIndex];
    if (!root)
        return '';
    const next = elements[rootIndex + 1];
    if (next?.role !== 'AXMenuBar' || next.depth !== root.depth)
        return '';
    return 'This AXWindow has no accessible child controls; the following AXMenuBar belongs to the application, not window content. This does not mean other windows in the application lack accessibility. A transparent overlay screenshot can show underlying application controls that do not belong to this AXWindow. Inspect another fresh candidate if this root identifies a watermark or decorative overlay; do not send keys or clicks to that overlay as if it were the content window.';
}
function isApplicationMenuOnlyQuery(state) {
    if (typeof state.filtered_element_count !== 'number' ||
        state.filtered_element_count <= 0 ||
        !Array.isArray(state.elements)) {
        return false;
    }
    const elements = state.elements.filter(isRecord);
    return (
    // Filtered results can omit AXWindow but retain a matching child before the menu.
    elements[0]?.role === 'AXMenuBar' &&
        elements[0].depth === 0 &&
        elements.every((item) => item.depth !== 0 || item.role === 'AXMenuBar'));
}
/** Keep native opaque handles beside the matching rows in model-visible content. */
/** Preserve observed state independently of action support and token eligibility. */
// Keep literal payload newlines from splitting rows before state/token annotations.
function escapeMultilineElementPayloads(text, elements) {
    let normalized = text;
    for (const element of elements) {
        if (!isRecord(element) || !Number.isInteger(element.element_index))
            continue;
        for (const value of [element.label, element.value]) {
            normalized = escapeElementPayload(normalized, element.element_index, value);
        }
    }
    return normalized;
}
function escapeElementPayload(text, index, value) {
    if (typeof value !== 'string' || !/[\r\n]/u.test(value))
        return text;
    const row = new RegExp(`^[ \\t]*- \\[${index}\\][^\\r\\n]*`, 'mu').exec(text);
    if (!row)
        return text;
    const quoted = `"${value}"`;
    const start = text.indexOf(quoted, row.index);
    // Only consume a quoted payload beginning on this exact element row.
    if (start < row.index || start >= row.index + row[0].length)
        return text;
    return text.slice(0, start) + JSON.stringify(value) + text.slice(start + quoted.length);
}
function observedControlValue(element) {
    const valueRoles = [
        'AXRadioButton',
        'AXCheckBox',
        'AXSwitch',
        'AXSlider',
        'AXIncrementor',
        'AXProgressIndicator',
        'AXLevelIndicator',
        'AXScrollBar',
    ];
    if (!valueRoles.includes(String(element.role)))
        return;
    const value = element.value;
    if (typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))) {
        return `ax_value=${JSON.stringify(value)}`;
    }
}
function editableValueAnnotation(element) {
    if (!['AXTextArea', 'AXTextField', 'AXComboBox'].includes(String(element.role)))
        return;
    if (typeof element.value !== 'string') {
        return 'ax_value=unknown (not reported; do not infer empty)';
    }
    if (element.value === '' || element.value !== element.value.trim()) {
        return `ax_value=${JSON.stringify(element.value)}`;
    }
}
function exposeElementState(text, record) {
    const state = record ? parseStructuredRecord(record) : undefined;
    if (!Array.isArray(state?.elements))
        return text;
    const normalizedText = escapeMultilineElementPayloads(text, state.elements);
    const annotations = new Map();
    for (const element of state.elements) {
        if (!isRecord(element) || !Number.isInteger(element.element_index))
            continue;
        const fields = ['enabled', 'selected', 'expanded']
            .filter((key) => typeof element[key] === 'boolean')
            .map((key) => `ax_${key}=${element[key]}`);
        // Native markdown omits non-string AXValue, while structured elements
        // preserve it. For value controls, AXSelected is not their checked/value state.
        const controlValue = observedControlValue(element);
        if (controlValue !== undefined)
            fields.push(controlValue);
        const editableValue = editableValueAnnotation(element);
        if (editableValue !== undefined)
            fields.push(editableValue);
        annotations.set(element.element_index, fields.join(' '));
    }
    return normalizedText.replace(/^(\s*- \[([0-9]+)\])(.+)$/gmu, (row, prefix, index, rest) => {
        const annotation = annotations.get(Number(index));
        return annotation ? `${prefix}${rest} [${annotation}]` : row;
    });
}
function exposeElementTokens(text, record) {
    const structured = record ? parseStructuredRecord(record) : undefined;
    if (!Array.isArray(structured?.elements))
        return text;
    // Native menu tokens do not belong to the exact window's action target.
    // Preserve menu text for discovery without presenting these as window handles.
    if (isApplicationMenuOnlyQuery(structured))
        return text;
    const geometryConflict = hasWindowGeometryConflict(structured);
    const tokens = collectElementTokens(structured.elements);
    if (tokens.size === 0)
        return text;
    const annotated = text.replace(/^(\s*- \[([0-9]+)\])(.+)$/gmu, (row, prefix, index, rest) => {
        const token = tokens.get(Number(index));
        return token ? `${prefix}${rest} [element_token=${JSON.stringify(token)}]` : row;
    });
    const geometryGuidance = geometryConflict
        ? ' Geometry conflict: the AX window frame disagrees with the reported capture bounds. Do not use AX frames or this window pixel transform for coordinate input, even though native screenshot_frame_valid is true. Fresh semantic element actions remain available if supported. For pixel recovery, announce foreground work, inspect computer_desktop_state, and use the visible target on the primary desktop with scope:desktop. Stop if the target cannot be observed there or background-only is required.'
        : ' AX control frames are not verified screenshot coordinates. For pixel actions, locate the control in a fresh screenshot; do not derive its position from AX frames or previous annotations.';
    return `Use the exact element_token shown beside a node; [numbers] are display indices, not tokens. Omit x/y for element clicks; omit element_token for coordinate clicks. Refresh after UI changes. ax_selected describes selection, not keyboard focus or a checkbox/radio's checked value. For value controls inspect ax_value and the rendered UI; without an explicit focus observation, focus is unknown.${geometryGuidance}\n\n${annotated}`;
}
/** Native AX frames can disagree with rendered content even when the root bounds match. */
function collectElementTokens(elements) {
    const tokens = new Map();
    for (const element of windowInputElements(elements)) {
        if (Number.isInteger(element.element_index) &&
            typeof element.element_token === 'string' &&
            element.element_token.length > 0) {
            tokens.set(element.element_index, element.element_token);
        }
    }
    return tokens;
}
/** A capture bounds check cannot establish that AX and captured content share an origin. */
function hasWindowGeometryConflict(state) {
    if (state.screenshot_frame_valid !== true || !Array.isArray(state.elements))
        return false;
    const bounds = state.window_bounds;
    if (!isRecord(bounds))
        return false;
    const root = state.elements.find((e) => isRecord(e) && e.role === 'AXWindow');
    if (!isRecord(root) || !isRecord(root.frame))
        return false;
    const frame = root.frame;
    const pairs = [
        [frame.x, bounds.x],
        [frame.y, bounds.y],
        [frame.w, bounds.width],
        [frame.h, bounds.height],
    ];
    if (!pairs.flat().every((value) => typeof value === 'number' && Number.isFinite(value))) {
        return false;
    }
    if ([frame.w, frame.h, bounds.width, bounds.height].some((value) => value <= 0)) {
        return false;
    }
    // Upstream parent_index is the nearest actionable ancestor, not the native
    // parent. Offscreen native tabs/rows can therefore appear directly below
    // AXWindow. Only a disagreement between the two window frames establishes
    // a capture conflict; an out-of-viewport child does not invalidate the frame.
    return pairs.some(([ax, captured]) => Math.abs(ax - captured) > 8);
}
function* windowInputElements(elements) {
    let applicationMenuDepth;
    for (const element of elements) {
        if (!isRecord(element))
            continue;
        if (applicationMenuDepth !== undefined &&
            typeof element.depth === 'number' &&
            element.depth <= applicationMenuDepth) {
            applicationMenuDepth = undefined;
        }
        if (element.role === 'AXMenuBar' && element.depth === 0)
            applicationMenuDepth = 0;
        // Mixed observations can contain both exact-window controls and the app's
        // menu tree. Suppress the whole menu subtree, including Help text fields.
        if (applicationMenuDepth !== undefined)
            continue;
        yield element;
    }
}
function baseComputerUseResultText(value, record) {
    if (typeof value === 'string')
        return value;
    if (typeof record?.text === 'string')
        return record.text;
    if (typeof record?.structuredJson === 'string')
        return record.structuredJson;
    return JSON.stringify(value) ?? String(value);
}
/**
 * The provider contract sends ToolResult.content to the model, while
 * `details` is intentionally UI/runtime metadata.  Keep the CUA driver's
 * bounded escalation signal in the text channel as well, otherwise a model
 * can select a supported route without treating a driver hint as focus permission.
 */
function computerUseOperationalGuidance(record, name) {
    if (!record)
        return '';
    const structured = parseStructuredRecord(record);
    if (!structured)
        return '';
    const specificGuidance = actionSpecificGuidance(name, structured);
    if (specificGuidance !== undefined)
        return specificGuidance;
    const guidance = formatOperationalGuidance(readOperationalSignal(structured), name, record.isError === true);
    if (name === 'computer_type' && structured.code === 'same_pid_keyboard_ambiguity') {
        return `The process-scoped keyboard route was refused. type_text may already have attempted an AXSelectedText write before refusing its keyboard fallback; this code alone does not prove that no input was attempted or applied. Inspect the exact field and rendered application state before any retry, and report unconfirmed effects as unknown rather than zero input. ${guidance}`;
    }
    return guidance;
}
function actionSpecificGuidance(name, structured) {
    if (name === 'computer_app_launch')
        return launchObservationGuidance(structured);
    if (name === 'computer_type' && structured.code === 'type_text_incomplete') {
        return 'Partial text input requires observation before retrying. The driver may infer delivered_chars and retry_from_character from AX value length changes; rich-text formatting, normalized whitespace, or paragraph splitting can make this different from the actual inserted prefix. Inspect the exact editor and compare its content and structure with the requested text. Do not blindly append a suffix or resend the whole payload. Repair only the observed mismatch within the authorized edit scope. For rich-text paragraphs, use separate text and Return operations and verify the resulting blocks. Coordinates on type/key perform a new focus click and can move the caret or collapse a selection: omit x/y when continuing at a verified caret or replacing a verified selection.';
    }
    if (name === 'computer_set_value' && structured.effect === 'unverifiable') {
        return 'The native value change is unverified. Check both the displayed value and the dependent application UI (for example search results). AXValue can change visible text without triggering the application input handler. If the dependent UI does not update, do not repeat set_value or press Return repeatedly: inspect the exact field, select its existing text when replacing it, and use computer_type with a fresh field token. Verify the resulting UI before continuing.';
    }
    if (isUnverifiedActivation(name, stringValue(structured.code))) {
        return activationFocusGuidance(structured);
    }
    return undefined;
}
function activationFocusGuidance(structured) {
    const observed = isRecord(structured.observed) ? structured.observed : {};
    const focusedId = observed.focused_window_id;
    const requestedId = structured.window_id;
    if (observed.front_process_matches_target === true &&
        Number.isInteger(focusedId) &&
        Number(focusedId) > 0 &&
        Number.isInteger(requestedId) &&
        Number(requestedId) > 0 &&
        focusedId !== requestedId) {
        return `Exact foreground activation was not verified. This application's observed focused_window_id=${focusedId} differs from the requested window_id=${requestedId}; a modal or another surface may own focus. Do not repeat activation or send keys to the original window. Call computer_window_list for the same pid and inspect the focused candidate with computer_app_state. Continue on its fresh window_ref and tokens only if the observed content confirms the intended task panel; the different ID is not permission to retarget input blindly. If it is an attached sheet without its own AXWindow, inspect the known initiating document for the matching sheet controls. If neither route resolves the task surface, inspect computer_desktop_state and use the visible intended control after announcing foreground work, unless background-only was requested.`;
    }
    return undefined;
}
function launchObservationGuidance(structured) {
    const state = isRecord(structured.launch_state) ? structured.launch_state : {};
    if (typeof state.window_readiness === 'string') {
        return state.window_readiness === 'observed'
            ? 'Only observed_window_ids had accessible window contents during the post-launch probe. This does not prove the requested document opened. Refresh the selected exact window before input; verify the requested document identity. Never treat a different filename as an alias or edit an unrelated existing document.'
            : 'Launch was requested, but no accessible content window was verified within the bounded observation. The listed CG windows may be closed remnants. Do not send input to those windows without a fresh successful app state. Reacquire windows once; if still unresolved, use the observed desktop launcher after announcing foreground work, unless the user requires background-only. Do not repeat actions on the old window. Document identity remains unverified.';
    }
    if (state.process_running === true && state.window_ready === false) {
        return 'The process is running but no usable window opened. Repeating background launch or sleeping does not reopen a closed document window. Refresh windows first. After announcing foreground work and unless the user requires background-only, try computer_app_activate once; if no content window appears, inspect computer_desktop_state and use the visible OS launcher. Reacquire the new window before acting. Otherwise report that reopening needs foreground assistance.';
    }
    return formatOperationalGuidance(readOperationalSignal(structured), 'computer_app_launch');
}
function readOperationalSignal(structured) {
    return {
        degraded: structured.degraded === true,
        code: stringValue(structured.code),
        effect: stringValue(structured.effect),
        degradedReason: stringValue(structured.degraded_reason),
        recommended: recommendedEscalation(structured),
        refusedReason: backgroundRefusalReason(structured),
    };
}
const windowMenuRecoveryGuidance = 'If the target remains registered but inaccessible after a move or activation, inspect an accessible window of the same application for its native Window menu. Use only an observed menu entry uniquely identifying the original document to select it, then refresh the original target window and verify its contents. The other window is only a route to the application menu, not a substitute document to read or edit. If the entry is absent or ambiguous, do not guess.';
function isUnverifiedDispatch(signal, resultFailed) {
    const { code, effect, degradedReason, recommended, refusedReason } = signal;
    return (effect === 'unverifiable' &&
        !resultFailed &&
        !code &&
        !recommended &&
        !signal.degraded &&
        !degradedReason &&
        !refusedReason);
}
function formatOperationalGuidance(signal, name, resultFailed = false) {
    const { code, effect, degradedReason, refusedReason } = signal;
    if (isUnverifiedDispatch(signal, resultFailed)) {
        return [
            'The driver confirms action dispatch only; its UI effect is unverified. Inspect fresh state of the same target before another dependent action or a success claim. A successful action receipt does not establish that the requested value, selection, page or dialog changed.',
            name === 'computer_secondary_action'
                ? 'Native menu commands may restore the previously active application after dispatch. Reading the target window does not activate it. Before a subsequent desktop key/type (including Escape), inspect the desktop and verify the intended application and control focus. If that fresh observation already establishes the target in front with the intended control focused, do not reactivate it merely because a menu command ran. Otherwise prefer a supported fresh window-element action. Activate the exact target window and re-observe after announcing foreground work, unless the user requires background-only. Do not send desktop input based only on a successful menu receipt or background window observation.'
                : '',
        ]
            .filter(Boolean)
            .join(' ');
    }
    if (isUnverifiedActivation(name, code)) {
        return `Exact foreground activation was not verified; this does not establish that the window lacks accessible controls. Do not repeat activation. Inspect computer_app_state for this exact window first, with include_screenshot:true if visual targeting is needed. If fresh AX controls are available, continue through their background element tokens and verify the effect; do not assume foreground keyboard delivery is safe. ${windowMenuRecoveryGuidance} If no actionable window or menu route exists, inspect computer_desktop_state; use the visible OS launcher after announcing foreground work, unless the user requires background-only, then reacquire its window. Do not treat process_activated or request_accepted as proof of foreground focus.`;
    }
    if (!needsRecoveryGuidance(signal, name))
        return '';
    const lines = ['CUA observation requires recovery.'];
    appendGuidanceLine(lines, code, 'code');
    appendGuidanceLine(lines, effect, 'effect');
    appendGuidanceLine(lines, degradedReason, 'degraded_reason');
    const reason = refusedReason ?? degradedReason?.split(':', 1)[0];
    appendGuidanceLine(lines, reason, 'background_refusal');
    if (name === 'computer_app_state' && degradedReason?.startsWith('ax_window_unresolved')) {
        lines.push('The exact AX window binding is unresolved. off_space_or_ax_unresolved is a combined refusal, not proof of another Space or missing permission. Unknown/null Space metadata does not resolve that uncertainty. Do not claim that activation or moving the window is required or will fix it; report the observed binding failure when background-only was requested.');
        lines.push(windowMenuRecoveryGuidance);
        lines.push('Screenshot withheld because it cannot be grounded to the requested window and may show another application. computer_app_state has no delivery_mode. Do not retry observation with a delivery mode or guess clicks/keys on this unresolved surface. If the window was closed or hidden, list windows again and inspect any recovered exact window. After announcing foreground work, and unless the user requires background-only, you may use computer_app_launch, computer_app_activate or native scope:"desktop" click/key/type on the observed system launcher to recover it. Otherwise report that foreground assistance is needed. Read computer_desktop_state before using the launcher. Stop if the launcher is not observable on the primary display. on_current_space=true describes this window, not the active display.');
    }
    else {
        const inputGuidance = inputRecoveryGuidance(signal);
        if (inputGuidance)
            lines.push(inputGuidance);
    }
    return lines.join(' ');
}
function inputRecoveryGuidance(signal) {
    if (signal.code === 'element_outside_target_window')
        return 'Do not repeat the same input on the same window just because its snapshot contains the field. Snapshot containment can differ from native element ownership, particularly for modal or popup content. Refresh computer_window_list for this application and inspect candidate windows with computer_app_state to locate the intended control in its actual host. Only re-address after a fresh observation confirms both the intended surface and field; do not substitute another document, reuse the old token, or guess the host from size alone. Keep background delivery. If ownership remains unresolved, stop the input attempt. Never drop the window target or switch to foreground to bypass this refusal.';
    if (signal.recommended === 'foreground' || signal.refusedReason || signal.effect === 'refused') {
        return 'Prefer supported background actions. When the background route is unavailable, tell the user which app will take focus and why BEFORE foreground input; no additional confirmation is needed. Respect an explicit background-only constraint. Do not escalate permission denial, cancellation, or unresolved target ownership. After announcing foreground work, and unless the user requires background-only, you may retry the refused action against the same window_ref with delivery_mode:"foreground"; first verify that the prior action had no effect to avoid duplicate input. Never drop the window target to bypass an ownership refusal. Do not infer another Space from this result; on_current_space=true means the window belongs to the current Space.';
    }
    return '';
}
function isUnverifiedActivation(name, code) {
    return (name === 'computer_app_activate' &&
        code?.startsWith('bring_to_front_') === true &&
        code.endsWith('_unverified'));
}
function needsRecoveryGuidance(signal, name) {
    // Individual keyboard route refusals do not invalidate a healthy AX tree.
    if (name === 'computer_app_state' && !signal.degraded && !signal.degradedReason)
        return false;
    return Boolean(signal.degraded ||
        signal.degradedReason ||
        signal.recommended ||
        signal.refusedReason ||
        signal.effect === 'refused');
}
function appendGuidanceLine(lines, value, label) {
    if (value)
        lines.push(`${label}: ${value}`);
}
function recommendedEscalation(structured) {
    if (!isRecord(structured.escalation))
        return undefined;
    return stringValue(structured.escalation.recommended);
}
function backgroundRefusalReason(structured) {
    if (!isRecord(structured.background_input))
        return undefined;
    const routes = structured.background_input.routes;
    if (!Array.isArray(routes))
        return undefined;
    const refused = routes.find((route) => isRecord(route) && route.status === 'refused');
    return isRecord(refused) ? stringValue(refused.reason) : undefined;
}
function computerUseResultImage(value) {
    if (!isRecord(value))
        return undefined;
    let data;
    if (typeof value.dataBase64 === 'string')
        data = value.dataBase64;
    else if (typeof value.data === 'string')
        data = value.data;
    if (!data)
        return undefined;
    const mimeType = typeof value.mimeType === 'string' ? value.mimeType : 'image/png';
    return { data, mimeType };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseStructuredRecord(value) {
    const raw = value.structuredJson ?? value.rawJson;
    let parsed = raw;
    if (typeof raw === 'string') {
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            return undefined;
        }
    }
    return isRecord(parsed) ? parsed : undefined;
}
function stringValue(value) {
    return typeof value === 'string' ? value : undefined;
}
//# sourceMappingURL=client.js.map