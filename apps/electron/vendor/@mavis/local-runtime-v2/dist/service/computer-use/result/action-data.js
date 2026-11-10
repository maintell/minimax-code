/**
 * PTC `data` of the ten action tools and of any failed Computer Use call.
 * Every field is driver metadata the tool already holds; none repeats UI
 * content. Read only from the programmatic side channel, never shown to the
 * model or persisted.
 */
export const COMPUTER_ACTION_TOOLS = new Set([
    'computer_click',
    'computer_drag',
    'computer_type',
    'computer_set_value',
    'computer_select_text',
    'computer_key',
    'computer_scroll',
    'computer_secondary_action',
    'computer_app_activate',
    'computer_window_set_frame',
]);
const COMPLETIONS = new Set(['not_started', 'completed', 'unknown']);
/**
 * One shape for all action tools. A failed result keeps the same shape: the
 * effect, code and refused routes are what tells a program why it failed.
 */
export function computerActionData(name, structured) {
    if (!structured)
        return {};
    const delivery = isRecord(structured.delivery) ? structured.delivery : undefined;
    const escalation = isRecord(structured.escalation) ? structured.escalation : undefined;
    const refusedRoutes = backgroundRoutes(structured)
        .filter((route) => route.status === 'refused')
        .map(({ route, reason }) => (reason === undefined ? { route } : { route, reason }));
    const data = definedFields({
        effect: stringValue(structured.effect),
        code: stringValue(structured.code),
        route: stringValue(structured.route),
        deliveryMode: stringValue(delivery?.mode) ?? stringValue(structured.delivery_mode),
        dispatched: booleanValue(structured.dispatched),
        degradedReason: stringValue(structured.degraded_reason),
        escalation: stringValue(escalation?.recommended),
        refusedRoutes: refusedRoutes.length > 0 ? refusedRoutes : undefined,
    });
    if (name === 'computer_type') {
        Object.assign(data, definedFields({
            deliveredChars: numberValue(structured.delivered_chars),
            requestedChars: numberValue(structured.requested_chars),
            retryFromCharacter: numberValue(structured.retry_from_character),
        }));
    }
    if (name === 'computer_app_activate') {
        const observed = isRecord(structured.observed) ? structured.observed : {};
        Object.assign(data, definedFields({
            processActivated: booleanValue(structured.process_activated),
            focusedWindowId: observed.focused_window_id === null ? null : numberValue(observed.focused_window_id),
            frontProcessMatchesTarget: booleanValue(observed.front_process_matches_target),
        }));
    }
    return data;
}
/**
 * A thrown call has no result: its code and whether the action may have run
 * (`completion`) are the only facts, the same ones an action tool's message
 * now states (observation tools keep them only here).
 */
export function thrownComputerUseData(error) {
    if (error === null || typeof error !== 'object')
        return {};
    const code = Reflect.get(error, 'code');
    const completion = Reflect.get(error, 'completion');
    return definedFields({
        code: typeof code === 'string' && code ? code : undefined,
        completion: typeof completion === 'string' && COMPLETIONS.has(completion) ? completion : undefined,
    });
}
/** Native background route prerequisites, the same subset the output lists. */
export function backgroundRoutes(structured) {
    const input = isRecord(structured.background_input) ? structured.background_input : undefined;
    if (!Array.isArray(input?.routes))
        return [];
    return input.routes.filter(isRecord).flatMap((route) => {
        const name = stringValue(route.route);
        const status = stringValue(route.status);
        if (!name || !['accessibility', 'window_pointer', 'pid_keyboard'].includes(name))
            return [];
        if (!status || !['available', 'refused'].includes(status))
            return [];
        const reason = stringValue(route.reason);
        return [reason === undefined ? { route: name, status } : { route: name, status, reason }];
    });
}
export function definedFields(fields) {
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}
export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function stringValue(value) {
    return typeof value === 'string' ? value : undefined;
}
export function numberValue(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
export function booleanValue(value) {
    return typeof value === 'boolean' ? value : undefined;
}
//# sourceMappingURL=action-data.js.map