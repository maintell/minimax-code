import { defineRuntimeTool, } from '@mavis/agent-runtime';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
const EXTENSION_ACTIONS = ['init', 'preview', 'inspect', 'test', 'withdraw'];
const PluginId = Type.String({
    minLength: 1,
    maxLength: 80,
    pattern: '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$',
    description: 'Plugin name of the extension package, e.g. sprint-board.',
});
const Title = Type.String({
    minLength: 1,
    maxLength: 80,
    description: "Init only: the extension's display name and the label of its button in the above-prompt band.",
});
const SourcePath = Type.String({
    minLength: 1,
    maxLength: 4096,
    pattern: '^[^\\u0000]*$',
    description: 'Preview or test only: package directory to use instead of the dev directory returned by init.',
});
// One concrete provider-facing object; exact action/input pairing is checked below (a root
// anyOf is rejected by some providers).
const ExtensionProviderInputSchema = Type.Object({
    action: Type.String({
        enum: [...EXTENSION_ACTIONS],
        pattern: `^(?:${EXTENSION_ACTIONS.join('|')})$`,
        description: 'Extension authoring action.',
    }),
    pluginId: PluginId,
    title: Type.Optional(Title),
    sourcePath: Type.Optional(SourcePath),
}, {
    additionalProperties: false,
    description: 'title is accepted only for init; sourcePath only for preview and test.',
});
const ExtensionActionInputSchema = Type.Union([
    Type.Object({ action: Type.Literal('init'), pluginId: PluginId, title: Type.Optional(Title) }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal('preview'), pluginId: PluginId, sourcePath: Type.Optional(SourcePath) }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal('test'), pluginId: PluginId, sourcePath: Type.Optional(SourcePath) }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal('inspect'), pluginId: PluginId }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal('withdraw'), pluginId: PluginId }, { additionalProperties: false }),
]);
export class PluginExtensionAuthoringError extends Error {
    code;
    name = 'PluginExtensionAuthoringError';
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
const PUBLIC_MESSAGES = {
    PACKAGE_NOT_FOUND: 'The extension package does not exist; call init first.',
    SOURCE_PATH_INVALID: 'sourcePath must be an absolute package directory.',
    INTERNAL_ERROR: 'The extension host could not complete the action.',
    CANCELLED: 'The extension action was cancelled.',
};
/** Creates the host extension only when a real plugin extension service is available. */
export function createPluginExtensionAuthoringExtension(authoring) {
    const tool = createExtensionTool(authoring);
    return {
        id: 'plugin-extension-authoring',
        description: 'Host-owned plugin extension authoring: init, preview, inspect, test and withdraw.',
        init(api) {
            api.registerTool((context) => (exposesExtensionAuthoring(context) ? tool : null));
        },
    };
}
function createExtensionTool(authoring) {
    return defineRuntimeTool({
        name: 'extension',
        description: "Author a plugin extension (a card band above the composer or a tab in the conversation's side panel). Init scaffolds the package in a session dev directory and returns packagePath, the only place to write it; it also writes editor types. Preview validates the package and activates it for this session; it is a permission-checked action, so the user may be asked to allow it before it runs, and once allowed for the conversation later previews of any plugin run directly. If the user denies the permission, do not call preview again; tell the user they can allow it on the permission card. Withdraw removes the preview of the plugin from this session now (its buttons, module and bundled MCP servers); files stay and a later preview re-activates it. Use withdraw when the user asks to stop, remove or turn off a preview; installed extensions are turned off or uninstalled like any plugin. Inspect returns source diagnostics, entries, runtime diagnostics and console lines. Test runs the package *.test.tsx files against the real extension host. Every diagnostic carries fix, an edit to apply as written. Use extension-creator for authoring guidance.",
        schema: ExtensionProviderInputSchema,
        // No `source: 'builtin'`: the permission gate checks this tool like any other, and `preview`
        // asks the user (`extension` / `preview` permission rule).
        operationClassifier: {
            allowedValues: EXTENSION_ACTIONS,
            classify: (input) => readRecord(input).action,
        },
        execute: async (context, rawInput, signal) => {
            const action = readAction(rawInput);
            if (signal?.aborted)
                return errorResult(action, 'CANCELLED');
            if (!Value.Check(ExtensionActionInputSchema, rawInput)) {
                return invalidArguments(action, rawInput);
            }
            const input = rawInput;
            const target = {
                sessionId: context.sessionId,
                turnId: context.turnId,
                pluginId: input.pluginId,
                ...(signal ? { signal } : {}),
            };
            try {
                const result = await dispatch(authoring, input, target);
                return successResult(input.action, result, failed(result));
            }
            catch (error) {
                if (signal?.aborted)
                    return errorResult(input.action, 'CANCELLED');
                return errorResult(input.action, error instanceof PluginExtensionAuthoringError ? error.code : 'INTERNAL_ERROR', error instanceof PluginExtensionAuthoringError ? error.message : undefined);
            }
        },
    });
}
function dispatch(authoring, input, target) {
    switch (input.action) {
        case 'init':
            return authoring.init({ ...target, ...(input.title ? { title: input.title } : {}) });
        case 'preview':
            return authoring.preview({
                ...target,
                ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
            });
        case 'test':
            return authoring.test({
                ...target,
                ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
            });
        case 'inspect':
            return authoring.inspect(target);
        case 'withdraw':
            return authoring.withdraw(target);
    }
}
/** Invalid packages, refused previews and failing tests are tool errors the model must act on. */
function failed(result) {
    const record = result;
    if (record.status === 'invalid' || record.status === 'refused')
        return true;
    return record.status === 'ran' && typeof record.report?.failed === 'number'
        ? record.report.failed > 0
        : false;
}
function successResult(action, result, isError) {
    const response = { ok: !isError, action, result };
    const text = JSON.stringify(response);
    return {
        tool_name: 'extension',
        text,
        content: [{ type: 'text', text }],
        details: response,
        ...(isError ? { isError: true } : {}),
    };
}
function errorResult(action, code, message) {
    const response = {
        ok: false,
        action,
        error: {
            code,
            message: message ?? (code === 'INVALID_ARGUMENTS' ? 'Invalid arguments.' : PUBLIC_MESSAGES[code]),
        },
    };
    const text = JSON.stringify(response);
    return {
        tool_name: 'extension',
        text,
        content: [{ type: 'text', text }],
        details: response,
        isError: true,
    };
}
function invalidArguments(action, input) {
    const record = readRecord(input);
    let message = 'Extension arguments are invalid for the selected action.';
    if (!Object.hasOwn(record, 'pluginId'))
        message = 'pluginId is required.';
    else if (action !== 'init' && Object.hasOwn(record, 'title')) {
        message = 'title is only accepted for the init action.';
    }
    else if (action !== 'preview' && action !== 'test' && Object.hasOwn(record, 'sourcePath')) {
        message = 'sourcePath is only accepted for the preview and test actions.';
    }
    return errorResult(action, 'INVALID_ARGUMENTS', message);
}
function readAction(input) {
    const action = readRecord(input).action;
    return typeof action === 'string' && EXTENSION_ACTIONS.includes(action)
        ? action
        : 'unknown';
}
/** Interactive turns only: preview needs a user who can answer its permission ask. */
function exposesExtensionAuthoring(context) {
    if (context.sessionOrigin?.miniApp)
        return false;
    const profile = readRecord(readRecord(context.agentConfig).agent_profile);
    return profile.surface === 'interactive';
}
function readRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
//# sourceMappingURL=plugin-extension.js.map