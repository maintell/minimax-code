import { defineRuntimeTool, } from '@mavis/agent-core/tools';
import { Type } from '@sinclair/typebox';
import { computerUseToolResult } from './client.js';
import { isComputerUseEnabled, registerComputerUseAbortController } from './state.js';
const ACTIONS = [
    [
        'computer_app_list',
        'Find running or installed desktop applications. For a specific app pass name; matching installed-but-not-running apps include their bundle_id so you can call computer_app_launch directly. An unfiltered summary may list only running apps. Prefer the returned bundle_id for an unambiguous launch.',
        'app_list',
        {
            name: {
                type: 'string',
                description: 'Case-insensitive app name or bundle ID substring. If a localized name has no matches, try the English application name. Omit or use empty string for the default inventory.',
            },
        },
    ],
    [
        'computer_window_list',
        'List exact native windows owned by one running application process. Select a specific window_ref from this fresh result; on_current_space describes Space membership and is_on_screen is not a reliable frontmost/visibility signal.',
        'window_list',
        { pid: { type: 'integer', minimum: 1 } },
    ],
    [
        'computer_display_list',
        'Read the current connected displays, including primary/internal flags, logical desktop bounds, work areas, scale factors and current cursor coordinates/display_id. Cursor coordinates also use electron_dip, not screenshot pixels. Resolution does not establish display position. Only combine these bounds with native window coordinates when matches_native_window_coordinates is true; screenshot pixels are a different space.',
        'display_list',
        {},
    ],
    [
        'computer_window_set_frame',
        'Move or resize one exact window using desktop coordinates from computer_window_list, not screenshot pixels. For moving between displays first read computer_display_list and use a compatible destination work_area. For a move, OMIT width and height: the host preserves the current window dimensions. Provide dimensions only when the user requests resizing. Native geometry readback reports the effect; refresh window_list and app_state afterward. This does not imply that desktop screenshots can capture secondary displays.',
        'window_set_frame',
        {
            pid: { type: 'integer', minimum: 1 },
            window_ref: { type: 'string' },
            x: { type: 'number' },
            y: { type: 'number' },
            width: {
                type: 'number',
                minimum: 1,
                description: 'Optional resize width; omit to preserve the current width.',
            },
            height: {
                type: 'number',
                minimum: 1,
                description: 'Optional resize height; omit to preserve the current height.',
            },
        },
    ],
    [
        'computer_desktop_state',
        'Inspect the primary display and return its screenshot. Use this for system launcher recovery when no actionable application window exists; this facade intentionally pins desktop capture to the CUA driver primary display on multi-display systems.',
        'desktop_state',
        {},
    ],
    [
        'computer_app_launch',
        'Launch a desktop application in the background. Prefer bundle_id from computer_app_list; launch does not foreground an existing window, so use an exact window_ref and supported background actions for interaction. Before foreground recovery, tell the user which app will take focus and why; then proceed without extra confirmation unless the user requires background-only.',
        'app_launch',
        {
            name: { type: 'string' },
            bundle_id: { type: 'string' },
            launch_path: {
                type: 'string',
                description: 'Windows only: copy the exact launch_path from computer_app_list for a registered desktop application. Do not invent an executable path. For packaged apps prefer their observed AUMID in bundle_id. Omit on macOS.',
            },
            urls: {
                type: 'array',
                items: { type: 'string' },
                description: 'On macOS, open the requested document or URL in this application, including when it has no document window; for a local document use its file:// URL and inspect the returned window. On Windows the native urls route uses the system URL handler and does not guarantee the specified application: use that application’s observed Open dialog for a document instead.',
            },
        },
    ],
    [
        'computer_app_activate',
        'Persistently activate a running app during window recovery after telling the user that foreground recovery is needed, unless the user requires background-only. This steals foreground and leaves it there. Use pid from app_list/launch; optionally pass a fresh window_ref to activate one exact existing window. After activation, list windows and read state: activation alone does not prove a closed window reopened. Do not use Cmd+Tab as a substitute.',
        'app_activate',
        { pid: { type: 'integer', minimum: 1 }, window_ref: { type: 'string' } },
    ],
    [
        'computer_app_state',
        'Inspect one exact application window and return its AX/UIA state plus screenshot. For a known target such as Search, pass query to return matching semantic nodes and their exact tokens without reading a large unrelated tree. Use only a fresh exact window_ref; if the result is degraded, follow its recovery guidance and do not substitute another same-process window.',
        'app_state',
        {
            pid: { type: 'integer' },
            window_ref: { type: 'string' },
            include_screenshot: {
                type: 'boolean',
                description: 'Default false: AX state is sufficient for semantic controls. Set true when you need visual inspection or screenshot coordinates. This captures the exact window; separately rendered menus or popups may be absent. Use desktop_state or inspect the popup window itself to verify those surfaces.',
            },
            max_elements: {
                type: 'integer',
                minimum: 1,
                description: 'Normally OMIT: native default is designed for ordinary observations. This counts visited nodes, not returned elements. Use to widen an explicitly truncated tree; lowering it may hide visible controls. Do not infer absence from truncation.',
            },
            max_depth: {
                type: 'integer',
                minimum: 1,
                description: 'Normally OMIT, including with query. Lowering the native tree depth can hide nested visible controls; only change it for a demonstrated observation need.',
            },
            query: {
                type: 'string',
                description: 'Optional case-insensitive semantic text filter for the target control; use the displayed UI language. Omit to inspect the full window. For unnamed window buttons, inspect with include_screenshot:true and match the Window-level AXButton controls summary to the screenshot instead of repeatedly querying Close.',
            },
        },
    ],
    [
        'computer_click',
        'Click using either a full element_token from the latest state or x/y from that exact window screenshot. These target modes are mutually exclusive: set unused target fields to null or omit them; mixed targets are rejected before input. Background delivery is the default; if background is unsupported, tell the user you will work in the foreground BEFORE retrying with foreground delivery, without asking for additional confirmation. Respect an explicit background-only constraint and verify prior effects before retrying. Prefer a supported semantic action from the observed element and verify the resulting UI.',
        'click',
        {
            scope: {
                type: 'string',
                enum: ['window', 'desktop'],
                description: 'Default window. desktop targets the primary display for visible desktop interaction or recovery from verified window-input no-ops. Omit pid, window_ref and element_token. Inspect computer_desktop_state first and establish the intended foreground control before desktop keys or typing.',
            },
            pid: { type: 'integer' },
            window_ref: { type: 'string' },
            x: {
                type: 'number',
                description: 'X in pixels of the original latest screenshot, relative to that exact window (or primary desktop for desktop scope). Use the reported screenshot dimensions; do not use logical display points or absolute AX frame coordinates.',
            },
            y: {
                type: 'number',
                description: 'Y in pixels of the original latest screenshot, using the same coordinate space as x.',
            },
            element_token: {
                type: 'string',
                description: 'Copy the full opaque element_token from the latest state. Never use a numeric display index or invent a token. Omit this field for coordinate targeting.',
            },
            action: {
                type: 'string',
                enum: ['auto', 'press', 'show_menu', 'pick', 'confirm', 'cancel', 'open'],
                description: 'Use auto for ordinary element or coordinate clicks (equivalent to omitting action). Other values explicitly select a macOS AX action matching an action advertised by the observed element (AXConfirm/confirm -> confirm; AXShowMenu/showmenu -> show_menu; AXPress/press -> press). Only non-auto actions require element_token, left button and a single click. Use auto or omit action for coordinate clicks or double clicks. This does not synthesize a keyboard shortcut or guarantee an application effect; inspect fresh state afterward.',
            },
            button: { type: 'string' },
            click_count: { type: 'integer' },
            delivery_mode: { type: 'string', enum: ['background', 'foreground'] },
        },
    ],
    [
        'computer_drag',
        'Drag within an exact application window using coordinates from its fresh screenshot. On macOS default to delivery_mode:"foreground" unless the active host explicitly reports background drag support. On Windows prefer supported background delivery. Before foreground input, tell the user which app will take mouse/keyboard control. Respect an explicit background-only constraint, do not repeat a refused delivery route, and verify effects before retrying.',
        'drag',
        {
            pid: { type: 'integer' },
            window_ref: { type: 'string' },
            from_x: { type: 'number' },
            from_y: { type: 'number' },
            to_x: { type: 'number' },
            to_y: { type: 'number' },
            delivery_mode: { type: 'string', enum: ['background', 'foreground'] },
        },
    ],
    [
        'computer_type',
        'Type UTF-8 text into an exact field. In rich-text editors, a multi-line string may not create paragraph breaks: use separate text and Return operations, verifying the resulting blocks. A type_text_incomplete count is not a proven prefix boundary; inspect actual content before recovery. Background delivery is the default; if background is unsupported, tell the user you will work in the foreground BEFORE retrying with foreground delivery, without asking for additional confirmation. Respect an explicit background-only constraint and verify prior effects before retrying. Never replace this with shell or AppleScript GUI automation.',
        'type',
        {
            scope: {
                type: 'string',
                enum: ['window', 'desktop'],
                description: 'Default window. desktop targets the primary display for visible desktop interaction or recovery from verified window-input no-ops. Omit pid, window_ref and element_token. Inspect computer_desktop_state first and establish the intended foreground control before desktop keys or typing.',
            },
            pid: { type: 'integer' },
            window_ref: { type: 'string' },
            text: { type: 'string' },
            element_token: {
                type: 'string',
                description: 'Copy the full opaque element_token from the latest state. Never use a numeric display index or invent a token. Omit this field for coordinate targeting.',
            },
            x: {
                type: 'number',
                description: 'Optional with y and without element_token: locate the editable control using pixels from the latest exact window screenshot. This performs a real click before typing and can move the caret or collapse a selection. After establishing and verifying focus, omit x/y for continued typing or replacement of the current selection; do not repeatedly click old coordinates. Verify the resulting text and selection.',
            },
            y: {
                type: 'number',
                description: 'Screenshot-pixel Y paired with x. Use numbers, not strings.',
            },
            delivery_mode: { type: 'string', enum: ['background', 'foreground'] },
        },
    ],
    [
        'computer_set_value',
        'Set the native value of an accessible control in an exact window. A visible value change does not prove the application input handler ran; verify dependent UI such as search results. If it does not update, select the existing text and use computer_type instead of repeating set_value. This is an accessibility-only operation; native set_value has no delivery_mode or foreground fallback. If it cannot change this control, inspect fresh state and use computer_type with an explicitly supported delivery mode.',
        'set_value',
        {
            pid: { type: 'integer' },
            window_ref: { type: 'string' },
            value: { type: 'string' },
            element_token: {
                type: 'string',
                description: 'Copy the full opaque element_token from the latest state. Never use a numeric display index or invent a token. Omit this field for coordinate targeting.',
            },
        },
    ],
    [
        'computer_select_text',
        'Select all text in the observed editable field. Use its fresh element_token for background delivery. Before foreground recovery, tell the user which app will take focus and why; then proceed without extra confirmation unless the user requires background-only. If an authorized foreground modifier shortcut is refused, do not retry the same token: inspect the exact window with include_screenshot:true, then use this tool with delivery_mode:"foreground" and x/y inside that field in the original screenshot, omitting element_token. This coordinate route clicks the field before selecting; verify selection or replacement from fresh state.',
        'select_text',
        {
            pid: { type: 'integer' },
            window_ref: { type: 'string' },
            element_token: {
                type: 'string',
                description: 'Copy the full opaque element_token from the latest state. Never use a numeric display index or invent a token. Omit this field for coordinate targeting.',
            },
            x: {
                type: 'number',
                description: 'Foreground only; ignored in background mode. Optional with y: focus this control before the shortcut. Use pixels from the latest exact window screenshot. Use coordinates only when a new focus click is intended; omit x/y to preserve the current caret or selection.',
            },
            y: {
                type: 'number',
                description: 'Screenshot-pixel Y of the same observed control; supply with x.',
            },
            delivery_mode: { type: 'string', enum: ['background', 'foreground'] },
        },
    ],
    [
        'computer_key',
        'Press a key or keyboard shortcut in an exact window. Background delivery is the default; if background is unsupported, tell the user you will work in the foreground BEFORE retrying with foreground delivery, without asking for additional confirmation. Respect an explicit background-only constraint and verify prior effects before retrying. Do not use shell/AppleScript as a fallback.',
        'key',
        {
            scope: {
                type: 'string',
                enum: ['window', 'desktop'],
                description: 'Default window. desktop targets the primary display for visible desktop interaction or recovery from verified window-input no-ops. Omit pid, window_ref and element_token. Inspect computer_desktop_state first and establish the intended foreground control before desktop keys or typing.',
            },
            pid: { type: 'integer' },
            window_ref: { type: 'string' },
            element_token: {
                type: 'string',
                minLength: 1,
                description: 'For an element-targeted key, copy the full element_token from the latest state. For foreground coordinate targeting, omit element_token or set it to null and supply x/y instead; these are alternative target modes. Also omit it for a window-level shortcut or desktop scope. Do not use a numeric display index.',
            },
            key: {
                type: 'string',
                description: 'One base key only, for example f, Return, or Escape. Put modifiers in the separate modifiers array: Cmd+F is key:"f", modifiers:["cmd"]. Do not pass cmd+f as the key name.',
            },
            modifiers: {
                type: 'array',
                items: { type: 'string', enum: ['cmd', 'win', 'shift', 'option', 'alt', 'ctrl', 'fn'] },
                description: 'Use canonical driver names: cmd (macOS), win (Windows/Meta), shift, option/alt, ctrl, or fn. Win is not Ctrl.',
            },
            x: {
                type: 'number',
                description: 'Foreground only; ignored in background mode. Optional with y: focus this control before the shortcut. Use pixels from the latest exact window screenshot. Use coordinates only when a new focus click is intended; omit x/y to preserve the current caret or selection.',
            },
            y: {
                type: 'number',
                description: 'Screenshot-pixel Y of the same observed control; supply with x.',
            },
            delivery_mode: { type: 'string', enum: ['background', 'foreground'] },
        },
    ],
    [
        'computer_scroll',
        'Scroll an exact application window or element. Background delivery is the default; if background is unsupported, tell the user you will work in the foreground BEFORE retrying with foreground delivery, without asking for additional confirmation. Respect an explicit background-only constraint and verify prior effects before retrying.',
        'scroll',
        {
            pid: { type: 'integer' },
            window_ref: { type: 'string' },
            direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
            by: {
                type: 'string',
                enum: ['line', 'page'],
                description: 'Scroll granularity; default line.',
            },
            amount: {
                type: 'integer',
                minimum: 1,
                maximum: 50,
                description: 'Count of wheel notches or key repetitions, NOT pixels. Default 3. Start with 1-3 and inspect the result.',
            },
            x: {
                type: 'number',
                description: 'With y, use a point inside the visible scroll region in the latest exact window screenshot. Omit element_token for this route. Use it when an element center is outside the viewport; do not change to foreground merely to reuse an out-of-bounds center.',
            },
            y: { type: 'number', description: 'Window screenshot pixel Y; supply with x.' },
            element_token: {
                type: 'string',
                description: 'Copy the full opaque element_token from the latest state. Never use a numeric display index or invent a token. Omit this field for coordinate targeting.',
            },
            delivery_mode: { type: 'string', enum: ['background', 'foreground'] },
        },
    ],
    [
        'computer_secondary_action',
        'Invoke a native menu command by its complete observed path, for example ["File", "Save"], on an exact window. This operation manages foreground activation internally and requires a user-visible foreground notice before invocation, even if it restores the prior app afterward; respect an explicit background-only constraint. On an unverified-focus error, stop and inspect the actual desktop; do not retry with delivery_mode or another element token.',
        'secondary_action',
        {
            pid: { type: 'integer' },
            window_ref: { type: 'string' },
            action: { type: 'string', enum: ['show_menu'] },
            path: { type: 'array', items: { type: 'string' } },
        },
    ],
    [
        'computer_verify_state',
        'Verify a bounded expected state after an action. Derive predicates from the original user request, not merely your action arguments or observed output. Match the complete requested text including whitespace and non-ASCII characters. Satisfied predicates alone do not prove the whole task is complete.',
        'verify_state',
        {
            pid: { type: 'integer' },
            window_ref: { type: 'string' },
            expect: {
                type: 'array',
                minItems: 1,
                maxItems: 8,
                description: 'One to eight predicates combined with AND. Use one assertion per item: window.exists, window.bounds, or element.selector plus exactly one of exists/value_equals/enabled/selected. Put multiple assertions in separate items; never add unrelated placeholder conditions. Example: [{element:{selector:{role:"AXTextArea"},value_equals:"expected text"}}]. Use an observed role/label; multiple matching elements return unknown. selected is the control selection state, not a text selection range.',
                items: {
                    anyOf: [
                        {
                            type: 'object',
                            additionalProperties: false,
                            required: ['window'],
                            properties: {
                                window: {
                                    type: 'object',
                                    additionalProperties: false,
                                    required: ['exists'],
                                    properties: {
                                        exists: {
                                            type: 'boolean',
                                        },
                                    },
                                },
                            },
                        },
                        {
                            type: 'object',
                            additionalProperties: false,
                            required: ['window'],
                            properties: {
                                window: {
                                    type: 'object',
                                    additionalProperties: false,
                                    required: ['bounds'],
                                    properties: {
                                        bounds: {
                                            type: 'object',
                                            additionalProperties: false,
                                            required: ['x', 'y', 'width', 'height'],
                                            properties: {
                                                x: {
                                                    type: 'number',
                                                },
                                                y: {
                                                    type: 'number',
                                                },
                                                width: {
                                                    type: 'number',
                                                },
                                                height: {
                                                    type: 'number',
                                                },
                                                tolerance_px: {
                                                    type: 'number',
                                                    minimum: 0,
                                                    maximum: 100,
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                        {
                            type: 'object',
                            additionalProperties: false,
                            required: ['element'],
                            properties: {
                                element: {
                                    type: 'object',
                                    additionalProperties: false,
                                    required: ['selector', 'exists'],
                                    properties: {
                                        selector: {
                                            type: 'object',
                                            additionalProperties: false,
                                            properties: {
                                                role: {
                                                    type: 'string',
                                                    minLength: 1,
                                                },
                                                label_contains: {
                                                    type: 'string',
                                                    minLength: 1,
                                                },
                                            },
                                        },
                                        exists: {
                                            type: 'boolean',
                                            enum: [true],
                                        },
                                    },
                                },
                            },
                        },
                        {
                            type: 'object',
                            additionalProperties: false,
                            required: ['element'],
                            properties: {
                                element: {
                                    type: 'object',
                                    additionalProperties: false,
                                    required: ['selector', 'value_equals'],
                                    properties: {
                                        selector: {
                                            type: 'object',
                                            additionalProperties: false,
                                            properties: {
                                                role: {
                                                    type: 'string',
                                                    minLength: 1,
                                                },
                                                label_contains: {
                                                    type: 'string',
                                                    minLength: 1,
                                                },
                                            },
                                        },
                                        value_equals: {
                                            type: 'string',
                                        },
                                    },
                                },
                            },
                        },
                        {
                            type: 'object',
                            additionalProperties: false,
                            required: ['element'],
                            properties: {
                                element: {
                                    type: 'object',
                                    additionalProperties: false,
                                    required: ['selector', 'enabled'],
                                    properties: {
                                        selector: {
                                            type: 'object',
                                            additionalProperties: false,
                                            properties: {
                                                role: {
                                                    type: 'string',
                                                    minLength: 1,
                                                },
                                                label_contains: {
                                                    type: 'string',
                                                    minLength: 1,
                                                },
                                            },
                                        },
                                        enabled: {
                                            type: 'boolean',
                                        },
                                    },
                                },
                            },
                        },
                        {
                            type: 'object',
                            additionalProperties: false,
                            required: ['element'],
                            properties: {
                                element: {
                                    type: 'object',
                                    additionalProperties: false,
                                    required: ['selector', 'selected'],
                                    properties: {
                                        selector: {
                                            type: 'object',
                                            additionalProperties: false,
                                            properties: {
                                                role: {
                                                    type: 'string',
                                                    minLength: 1,
                                                },
                                                label_contains: {
                                                    type: 'string',
                                                    minLength: 1,
                                                },
                                            },
                                        },
                                        selected: {
                                            type: 'boolean',
                                        },
                                    },
                                },
                            },
                        },
                    ],
                },
            },
            timeout_ms: { type: 'integer', minimum: 0, maximum: 10000 },
            stable_samples: { type: 'integer', minimum: 1, maximum: 5 },
            include_screenshot: { type: 'boolean' },
        },
    ],
];
function computerUseProperties(kind, properties) {
    return Object.fromEntries(Object.entries(properties)
        .filter(([key]) => !(kind === 'app_launch' && process.platform !== 'win32' && key === 'launch_path'))
        .map(([key, schema]) => {
        if (['key', 'type'].includes(kind) && key === 'scope') {
            return [
                key,
                {
                    ...schema,
                    description: `${schema.description} Desktop key/type use the current focus: omit x/y or set both to null. Coordinates do not focus a desktop control. Click separately when needed and verify focus/selection before typing.`,
                },
            ];
        }
        if (kind === 'app_state' && ['max_depth', 'max_elements'].includes(key)) {
            return [
                key,
                {
                    anyOf: [schema, { type: 'null' }],
                    description: 'Normally use null or omit this field to keep the native observation default. Set a number only to recover a demonstrably truncated observation; do not invent a small bound, including with query.',
                },
            ];
        }
        if (['click', 'type', 'key', 'select_text', 'scroll'].includes(kind) &&
            ['pid', 'window_ref', 'element_token', 'x', 'y'].includes(key)) {
            const description = schema.description;
            return [
                key,
                {
                    anyOf: [
                        key === 'element_token'
                            ? { ...schema, minLength: 1 }
                            : schema,
                        { type: 'null' },
                    ],
                    description: `${typeof description === 'string' ? description : ''} Optional target field: null means omitted. Coordinate input uses element_token:null; element input uses x:null and y:null. Never invent a target.`,
                },
            ];
        }
        return [key, schema];
    }));
}
/** Keep null targets and invalid values intact; only decimal numeric strings are compatible. */
function prepareComputerUseArguments(args, properties) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return args;
    }
    const prepared = { ...args };
    for (const [key, schema] of Object.entries(properties)) {
        const type = schema.type;
        if (type !== 'number' && type !== 'integer')
            continue;
        const value = prepared[key];
        if (typeof value !== 'string')
            continue;
        const numeric = decimalArgument(value, type === 'integer');
        if (numeric !== undefined)
            prepared[key] = numeric;
    }
    return prepared;
}
function decimalArgument(value, integer) {
    const trimmed = value.trim();
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed))
        return undefined;
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric) || (integer && !Number.isSafeInteger(numeric)))
        return undefined;
    return numeric;
}
/** Registered names for Task capability ceilings; this does not enable or instantiate tools. */
export const COMPUTER_USE_TOOL_NAMES = Object.freeze(ACTIONS.map(([name]) => name));
export function buildComputerUseRuntimeTools(client, readSessionTitle) {
    if (!client)
        return [];
    return ACTIONS.map(([name, description, kind, properties]) => defineRuntimeTool({
        name,
        description,
        prepareArguments: (args) => prepareComputerUseArguments(args, properties),
        schema: Type.Unsafe({
            type: 'object',
            additionalProperties: false,
            properties: computerUseProperties(kind, properties),
            ...(['window_list', 'app_activate'].includes(kind) ? { required: ['pid'] } : {}),
            ...(kind === 'verify_state' ? { required: ['window_ref', 'expect'] } : {}),
            ...(kind === 'window_set_frame' ? { required: ['pid', 'window_ref', 'x', 'y'] } : {}),
        }),
        execute: async (ctx, input, signal) => {
            if (!isComputerUseEnabled()) {
                const text = 'Computer Use is not enabled';
                return {
                    tool_name: name,
                    text,
                    content: [{ type: 'text', text }],
                    isError: true,
                };
            }
            if (signal?.aborted)
                throw new Error('computer_aborted');
            // The runtime control endpoint can abort calls independently of the
            // agent turn. Register every call before dispatch so setEnabled(false)
            // and /computer-use/abort reach the actual CUA transport.
            const controller = new AbortController();
            const unregister = registerComputerUseAbortController(controller);
            const combined = combineAbortSignals(signal, controller.signal);
            try {
                // Read on every operation so renamed sessions keep the same native identity.
                // Display lookup failures must not prevent an otherwise valid operation.
                let sessionTitle;
                try {
                    sessionTitle = await readSessionTitle?.(ctx.sessionId);
                }
                catch {
                    sessionTitle = undefined;
                }
                // Re-check the gate after registration and the asynchronous title lookup.
                // A toggle may have changed while this tool was being queued.
                if (!isComputerUseEnabled())
                    throw new Error('computer_disabled');
                if (combined.signal.aborted)
                    throw new Error('computer_aborted');
                const value = await client.call({
                    kind,
                    sessionId: ctx.sessionId,
                    ...(sessionTitle != null ? { sessionTitle } : {}),
                    turnId: ctx.turnId,
                    generation: 0,
                    payload: (input ?? {}),
                }, combined.signal);
                return computerUseToolResult(name, value);
            }
            catch (error) {
                const recovery = windowTargetRecovery(error);
                if (!recovery)
                    throw error;
                return {
                    tool_name: name,
                    text: recovery,
                    content: [{ type: 'text', text: recovery }],
                    isError: true,
                };
            }
            finally {
                combined.cleanup();
                unregister();
            }
        },
    }));
}
function windowTargetRecovery(error) {
    if (!(error instanceof Error))
        return;
    const reasons = {
        computer_window_not_found: 'The requested window is no longer in the current application window inventory. Its old window_ref and element tokens cannot be reused.',
        computer_ambiguous_window_target: 'The application has multiple windows; the intended window has not been identified.',
        computer_window_ref_required: 'An exact current application window is required for this operation.',
    };
    const reason = reasons[error.message];
    if (!reason)
        return;
    return `${error.message}: ${reason} Refresh computer_app_list if the process may have changed, then computer_window_list for that PID. Choose only an observed window_ref and inspect it with computer_app_state before taking a fresh element token. Never guess a neighboring window ID. If the intended window is closed, use computer_app_launch in background for that application or the known document URL, then observe again. If no matching actionable window returns, stop and report the limitation. Do not substitute Bash, AppleScript/osascript, browser scripting, or another GUI automation path. For an identified application needing foreground recovery, announce the focus change before activation or desktop recovery; respect an explicit background-only constraint. Never act on an unidentified window.`;
}
function combineAbortSignals(...signals) {
    const controller = new AbortController();
    const listeners = [];
    const abort = () => {
        if (!controller.signal.aborted)
            controller.abort();
    };
    for (const signal of signals) {
        if (!signal)
            continue;
        if (signal.aborted) {
            abort();
            break;
        }
        signal.addEventListener('abort', abort, { once: true });
        listeners.push({ signal, listener: abort });
    }
    return {
        signal: controller.signal,
        cleanup: () => {
            for (const { signal, listener } of listeners)
                signal.removeEventListener('abort', listener);
        },
    };
}
//# sourceMappingURL=tools.js.map