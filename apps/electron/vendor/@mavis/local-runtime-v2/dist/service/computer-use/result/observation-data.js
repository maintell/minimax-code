import { backgroundRoutes, booleanValue, definedFields, isRecord, numberValue, stringValue, } from './action-data.js';
/**
 * PTC `data` of the read-only Computer Use tools. Content fields (labels,
 * values, titles) are given only where the output shows them, so a program
 * never reads more than the model was shown. AX frames and the window
 * bounds of app_state are left out on purpose: its output forbids using AX
 * coordinates for input.
 */
export function computerObservationData(input) {
    const structured = input.structured ?? {};
    if (input.name === 'computer_app_state')
        return appStateData(input, structured);
    if (input.failed)
        return definedFields({ code: stringValue(structured.code) });
    switch (input.name) {
        case 'computer_window_list':
            return windowListData(structured, input.text);
        case 'computer_app_launch':
            return appLaunchData(structured, input.text);
        case 'computer_desktop_state':
            return {
                screenshot: screenshotData(structured, input.image),
                ...definedFields({
                    screenWidth: numberValue(structured.screen_width),
                    screenHeight: numberValue(structured.screen_height),
                }),
            };
        case 'computer_display_list':
            return displayListData(structured, input.text);
        case 'computer_verify_state':
            return verifyStateData(structured, input.image);
        default:
            return {};
    }
}
function appStateData(input, structured) {
    const ids = definedFields({
        pid: positiveInteger(structured.pid),
        windowId: positiveInteger(structured.window_id),
    });
    if (input.failed) {
        return {
            ...ids,
            ...definedFields({ degradedReason: stringValue(structured.degraded_reason) }),
            screenshot: { included: false },
        };
    }
    const routes = backgroundRoutes(structured);
    return {
        ...ids,
        ...definedFields({
            degradedReason: stringValue(structured.degraded_reason),
            elementCount: numberValue(structured.element_count),
            filteredElementCount: numberValue(structured.filtered_element_count),
        }),
        menuOmitted: input.menuOmitted,
        treeTruncated: input.treeTruncated,
        geometryConflict: input.geometryConflict,
        ...(routes.length > 0 ? { backgroundRoutes: routes } : {}),
        screenshot: screenshotData(structured, input.image),
        elements: shownElements(structured.elements, input.text),
    };
}
/**
 * Only elements whose `- [index]` row is in the output; an omitted menu
 * subtree has no rows left, so it drops out here too. A label, value or token
 * is kept only when that row shows it.
 */
function shownElements(elements, text) {
    if (!Array.isArray(elements))
        return [];
    const rows = new Map();
    for (const line of text.split('\n')) {
        const match = /^\s*- \[(\d+)\]/u.exec(line);
        if (match && !rows.has(Number(match[1])))
            rows.set(Number(match[1]), line);
    }
    return elements.filter(isRecord).flatMap((element) => {
        const index = element.element_index;
        const row = Number.isInteger(index) ? rows.get(index) : undefined;
        if (row === undefined)
            return [];
        const token = stringValue(element.element_token);
        return [
            definedFields({
                index,
                role: stringValue(element.role),
                label: quotedIn(row, element.label),
                value: typeof element.value === 'string'
                    ? quotedIn(row, element.value)
                    : annotatedValue(row, element.value),
                token: token && row.includes(`element_token=${JSON.stringify(token)}`) ? token : undefined,
                depth: numberValue(element.depth),
                enabled: booleanValue(element.enabled),
                selected: booleanValue(element.selected),
                expanded: booleanValue(element.expanded),
            }),
        ];
    });
}
/**
 * Rows quote payloads natively ("x") or JSON-escaped when they span lines;
 * window titles and display labels are inside JSON in the output.
 */
function quotedIn(shown, value) {
    if (typeof value !== 'string' || !value)
        return undefined;
    return shown.includes(`"${value}"`) || shown.includes(JSON.stringify(value)) ? value : undefined;
}
/** Non-string AX values appear only through the host's ax_value annotation. */
function annotatedValue(row, value) {
    if (typeof value !== 'boolean' && numberValue(value) === undefined)
        return undefined;
    return row.includes(`ax_value=${JSON.stringify(value)}`)
        ? value
        : undefined;
}
/** Screenshot size is the pixel space of x/y coordinates, reported by the driver. */
function screenshotData(structured, image) {
    if (!image)
        return { included: false };
    return {
        included: true,
        ...definedFields({
            width: positiveInteger(structured.screenshot_width),
            height: positiveInteger(structured.screenshot_height),
        }),
        mimeType: image.mimeType,
    };
}
function windowListData(structured, text) {
    if (!Array.isArray(structured.windows))
        return {};
    return {
        ...definedFields({ pid: positiveInteger(structured.pid) }),
        windows: structured.windows.filter(isRecord).flatMap((window) => {
            const windowId = positiveInteger(window.window_id ?? window.windowId);
            const windowRef = stringValue(window.window_ref);
            if (windowId === undefined || !windowRef)
                return [];
            return [
                definedFields({
                    windowRef,
                    windowId,
                    title: quotedIn(text, window.title),
                    isOnScreen: booleanValue(window.is_on_screen),
                    onCurrentSpace: window.on_current_space === null ? null : booleanValue(window.on_current_space),
                    bounds: rect(window.bounds),
                }),
            ];
        }),
    };
}
function appLaunchData(structured, text) {
    const state = isRecord(structured.launch_state) ? structured.launch_state : {};
    const observation = isRecord(structured.observation) ? structured.observation : {};
    const coverage = isRecord(observation.coverage) ? observation.coverage : {};
    return definedFields({
        pid: positiveInteger(structured.pid),
        processRunning: booleanValue(state.process_running),
        windowReadiness: stringValue(state.window_readiness),
        observedWindowIds: Array.isArray(state.observed_window_ids)
            ? state.observed_window_ids.filter((id) => positiveInteger(id) !== undefined)
            : undefined,
        observationComplete: booleanValue(coverage.complete),
        windows: Array.isArray(structured.windows)
            ? structured.windows.filter(isRecord).flatMap((window) => {
                const windowId = positiveInteger(window.window_id);
                if (windowId === undefined)
                    return [];
                return [
                    definedFields({
                        windowRef: stringValue(window.window_ref),
                        windowId,
                        title: quotedIn(text, window.title),
                    }),
                ];
            })
            : undefined,
    });
}
function displayListData(structured, text) {
    const cursor = isRecord(structured.cursor) ? structured.cursor : undefined;
    return definedFields({
        coordinateSpace: stringValue(structured.coordinate_space),
        matchesNativeWindowCoordinates: booleanValue(structured.matches_native_window_coordinates),
        cursor: cursor
            ? definedFields({
                x: numberValue(cursor.x),
                y: numberValue(cursor.y),
                displayId: stringValue(cursor.display_id),
            })
            : undefined,
        displays: Array.isArray(structured.displays)
            ? structured.displays.filter(isRecord).map((display) => definedFields({
                id: stringValue(display.id),
                label: quotedIn(text, display.label),
                primary: booleanValue(display.primary),
                internal: booleanValue(display.internal),
                bounds: rect(display.bounds),
                workArea: rect(display.work_area),
                scaleFactor: numberValue(display.scale_factor),
                rotation: numberValue(display.rotation),
            }))
            : undefined,
    });
}
/** The output lists at most eight predicates; so does data. */
function verifyStateData(structured, image) {
    const predicates = Array.isArray(structured.predicates)
        ? structured.predicates
            .slice(0, 8)
            .filter(isRecord)
            .map((item) => definedFields({
            index: numberValue(item.index),
            status: stringValue(item.status),
            unknownReason: stringValue(item.unknown_reason),
        }))
        : [];
    return { predicates, ...(image ? { screenshot: screenshotData(structured, image) } : {}) };
}
function rect(value) {
    if (!isRecord(value))
        return undefined;
    const { x, y, width, height } = value;
    const numbers = [x, y, width, height].map(numberValue);
    if (numbers.some((item) => item === undefined))
        return undefined;
    return { x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3] };
}
function positiveInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
//# sourceMappingURL=observation-data.js.map