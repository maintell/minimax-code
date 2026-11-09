import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { defineRuntimeTool } from '@mavis/agent-core/tools';
import { Type } from '@sinclair/typebox';
import { ModelAccessPackageError } from '../errors.js';
export const MODEL_ACCESS_EXTENSION_TOOL_NAME = 'model_access_extension';
const ACTIONS = [
    'preview',
    'start_dev',
    'reload',
    'status',
    'probe',
    'stop_dev',
    'keep',
    'export',
];
const DESCRIPTION = `Develop a MiniMax Code model access extension package in a local folder (the folder you generated).
Actions:
- preview {path}: read model-access.json, digest and file counts; never runs package code.
- start_dev {path}: ask the user, in this conversation, to run the package in a development session. Package code runs as native code only after the user approves; the call waits for their decision and returns running or declined.
- reload {path}: re-snapshot the folder into the running dev session (after edits).
- status {path}: dev session state, load errors and declared providers/methods.
- probe {path}: declared providers, credential kinds and login/borrow/API entry points of the running package.
- stop_dev {path}: end the dev session and remove the dev package.
- keep {path}: once it works, ask the user to keep the running dev package as their extension (a kept extension of the same name is updated in place, sign-ins stay). Waits for their decision.
- export {path, target}: write the running dev package as a .zip (target is an absolute .zip path).
Only the user can approve start_dev and keep. This tool never returns credentials, tokens or package logs.`;
function text(value, isError = false) {
    return {
        tool_name: MODEL_ACCESS_EXTENSION_TOOL_NAME,
        text: value,
        content: [{ type: 'text', text: value }],
        ...(isError ? { isError: true } : {}),
    };
}
function errorCode(error) {
    if (error instanceof ModelAccessPackageError)
        return error.code;
    const code = error?.code;
    return typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(code) ? code : 'failed';
}
function readInput(value) {
    if (!value || typeof value !== 'object')
        throw new ModelAccessPackageError('invalid_package');
    const { action, path: target, target: zip } = value;
    if (typeof action !== 'string' || !ACTIONS.includes(action))
        throw new ModelAccessPackageError('invalid_package');
    if (typeof target !== 'string' || !path.isAbsolute(target))
        throw new ModelAccessPackageError('invalid_package');
    return {
        action: action,
        path: target,
        ...(typeof zip === 'string' ? { target: zip } : {}),
    };
}
/**
 * Agent tool for the authoring skill. Every action runs on the local runtime that owns the
 * session; it cannot grant native-code consent (start_dev only records a request the user
 * approves in Desktop) and exposes no secret material.
 */
export function createModelAccessExtensionTool(host) {
    return defineRuntimeTool({
        name: MODEL_ACCESS_EXTENSION_TOOL_NAME,
        description: DESCRIPTION,
        executionMode: 'sequential',
        schema: Type.Object({
            action: Type.Union(ACTIONS.map((action) => Type.Literal(action))),
            path: Type.String({ description: 'Absolute path of the extension package folder.' }),
            target: Type.Optional(Type.String({ description: 'export only: absolute output path ending in .zip.' })),
        }, { additionalProperties: false }),
        execute: async (ctx, rawInput, signal) => {
            try {
                if (signal?.aborted)
                    throw new Error('Operation aborted');
                const input = readInput(rawInput);
                return text(await run(host, input, ctx.sessionId, signal));
            }
            catch (error) {
                return text(`model_access_extension failed: ${errorCode(error)}`, true);
            }
        },
    });
}
async function run(host, input, sessionId, signal) {
    const context = { host, sessionId, signal };
    if (input.action === 'preview')
        return previewPackage(host, input.path);
    if (input.action === 'start_dev')
        return startDev(context, input.path);
    const directory = await realDirectory(input.path);
    const session = host.userPackages.sessionForPath(directory);
    if (input.action === 'keep')
        return keepDev(context, directory, session);
    if (input.action === 'status' || input.action === 'probe')
        return devStatus(host, directory, session);
    if (!session)
        throw new ModelAccessPackageError('dev_session_missing');
    return sessionAction(host, input, session);
}
async function previewPackage(host, directory) {
    const preview = await host.userPackages.preview({ kind: 'dir', path: directory });
    return JSON.stringify({
        name: preview.manifest.name,
        version: preview.manifest.version,
        schemaVersion: preview.manifest.schemaVersion,
        digest: preview.digest,
        fileCount: preview.fileCount,
        byteCount: preview.byteCount,
        providers: preview.manifest.providers.map((item) => item.id),
        sources: preview.manifest.sources.map((item) => item.id),
    });
}
async function startDev(context, directory) {
    const { host } = context;
    const user = host.userPackages;
    const request = await user.requestDev(directory, context.sessionId);
    const outcome = await user.awaitRequest(request.requestId, context.signal);
    if (outcome !== 'approved')
        return declined(request);
    const started = user.sessionForPath(request.path);
    const item = started && host.list().find((e) => e.installationId === started.installationId);
    return JSON.stringify({
        status: item?.status ?? 'running',
        ...(item?.errorCode ? { errorCode: item.errorCode } : {}),
        digest: started?.digest ?? request.digest,
        next: 'Call probe, then ask the user to sign in or enable the borrow target and send a message with a model of the extension.',
    });
}
async function keepDev(context, directory, session) {
    if (!session)
        throw new ModelAccessPackageError('dev_session_missing');
    const user = context.host.userPackages;
    const request = await user.requestKeep(directory, context.sessionId);
    const outcome = await user.awaitRequest(request.requestId, context.signal);
    if (outcome !== 'approved')
        return declined(request);
    const kept = context.host.list().find((entry) => entry.installationId === session.installationId);
    return JSON.stringify({
        status: kept?.status ?? 'kept',
        kept: true,
        version: request.version,
        digest: request.digest,
    });
}
/** Every entry point the package declares: `<source>/<capability>/<id>[:kind]`. */
function entryPointsOf(manifest) {
    return manifest.sources.flatMap((source) => [
        ...(source.capabilities.login?.methods ?? []).map((method) => `${source.id}/login/${method.id}:${method.kind}`),
        ...(source.capabilities.subscriptionBorrow?.variants ?? []).map((variant) => `${source.id}/subscriptionBorrow/${variant.id}`),
        ...(source.capabilities.apiKeyScan?.readers ?? []).map((reader) => `${source.id}/apiKeyScan/${reader.id}`),
    ]);
}
function devStatus(host, directory, session) {
    if (!session) {
        const pending = host.userPackages.requestsList().find((item) => item.path === directory);
        return JSON.stringify({ status: pending ? 'awaiting_user_approval' : 'no_dev_session' });
    }
    const item = host.list().find((entry) => entry.installationId === session.installationId);
    const manifest = host.registry.get(session.installationId)?.manifest;
    return JSON.stringify({
        status: item?.status ?? 'missing',
        ...(item?.errorCode ? { errorCode: item.errorCode } : {}),
        sessionId: session.sessionId,
        digest: session.digest,
        ...(manifest
            ? {
                providers: manifest.providers.map((provider) => ({
                    id: provider.id,
                    credentialKinds: provider.credentialKinds,
                })),
                entryPoints: entryPointsOf(manifest),
            }
            : {}),
    });
}
async function sessionAction(host, input, session) {
    const user = host.userPackages;
    if (input.action === 'reload') {
        const reloaded = await user.reload(session.sessionId);
        return JSON.stringify({
            status: reloaded.installation.status,
            ...(reloaded.installation.errorCode ? { errorCode: reloaded.installation.errorCode } : {}),
            digest: reloaded.digest,
        });
    }
    if (input.action === 'stop_dev') {
        await user.stopDev(session.sessionId);
        return JSON.stringify({ status: 'stopped' });
    }
    if (!input.target)
        throw new ModelAccessPackageError('invalid_package');
    return JSON.stringify(await user.exportPackage(session.installationId, input.target));
}
function declined(request) {
    return JSON.stringify({
        status: 'declined',
        name: request.name,
        digest: request.digest,
        next: 'The user did not approve. Do not ask again unless they want to; answer their questions instead.',
    });
}
async function realDirectory(value) {
    try {
        return await realpath(value);
    }
    catch {
        return value;
    }
}
//# sourceMappingURL=agent-tool.js.map