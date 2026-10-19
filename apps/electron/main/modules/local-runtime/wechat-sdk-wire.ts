import { net } from "electron";
/**
 * Pure adapter that turns the SDK module's free functions + ILinkClient
 * constructor into the `WeChatRuntimeSdk` object the channel subsystem
 * consumes. Synchronous — caller provides an already-loaded module so this
 * is trivially testable with an in-memory stub.
 *
 * The `as never` casts here are intentional: `WeChatClientHandle` /
 * `WeChatUploadedFile` are structural views of the SDK's `ILinkClient` /
 * `UploadedFileInfo` types. Runtime objects are produced and consumed
 * exclusively within this bridge, so the casts never surface to callers.
 */
export function buildWeChatRuntimeSdk(sdk) {
    return {
        createClient(opts) {
            const clientOpts = { token: opts.token };
            if (opts.baseUrl !== undefined)
                clientOpts.baseUrl = opts.baseUrl;
            return new sdk.ILinkClient(clientOpts);
        },
        sendText(params) {
            const sendParams = {
                to: params.to,
                contextToken: params.contextToken,
            };
            if (params.text !== undefined)
                sendParams.text = params.text;
            return sdk.sendTextMessage(params.client, sendParams);
        },
        sendMediaFile(params) {
            const sendParams = {
                to: params.to,
                contextToken: params.contextToken,
                uploaded: params.uploaded,
                fileName: params.fileName,
                mimeType: params.mimeType,
            };
            if (params.text !== undefined)
                sendParams.text = params.text;
            return sdk.sendMediaFile(params.client, sendParams);
        },
        async uploadImage(params) {
            const result = await sdk.uploadImage({
                client: params.client,
                buf: params.buf,
                toUserId: params.toUserId,
                cdnBaseUrl: params.cdnBaseUrl,
            });
            return result;
        },
        async uploadVideo(params) {
            const result = await sdk.uploadVideo({
                client: params.client,
                buf: params.buf,
                toUserId: params.toUserId,
                cdnBaseUrl: params.cdnBaseUrl,
            });
            return result;
        },
        async uploadFile(params) {
            const result = await sdk.uploadFile({
                client: params.client,
                buf: params.buf,
                toUserId: params.toUserId,
                cdnBaseUrl: params.cdnBaseUrl,
            });
            return result;
        },
        downloadAndDecrypt(input) {
            return sdk.downloadAndDecrypt(input.encryptedQueryParam, input.aesKey, input.cdnBaseUrl, input.token);
        },
        createMonitor(params) {
            const opts = {
                client: params.client,
            };
            if (params.getUpdatesBuf !== undefined)
                opts.getUpdatesBuf = params.getUpdatesBuf;
            if (params.botId !== undefined)
                opts.botId = params.botId;
            const instance = new sdk.ILinkMonitor(opts);
            // The SDK's ILinkMonitor instance is structurally compatible with
            // WeChatMonitorHandle (start/stop/isRunning/getState/on/off). The
            // `as never` cast bridges the typed `on/off` overloads on the contract
            // side without naming the SDK's `MonitorEvents` map here.
            return instance;
        },
        async getConfig(params) {
            // ILinkClient.getConfig is an instance method; the structural
            // WeChatClientHandle on the contract side does not name it because the
            // contract is SDK-agnostic. Route through `any` to invoke it here.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const client = params.client;
            if (typeof client?.getConfig !== 'function')
                return {};
            const resp = (await client.getConfig(params.ilinkUserId, params.contextToken));
            const out = {};
            if (typeof resp?.typing_ticket === 'string' && resp.typing_ticket) {
                out.typingTicket = resp.typing_ticket;
            }
            return out;
        },
        async sendTyping(params) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const client = params.client;
            if (typeof client?.sendTyping !== 'function')
                return;
            await client.sendTyping({
                ilink_user_id: params.ilinkUserId,
                typing_ticket: params.typingTicket,
                status: params.status,
            });
        },
    };
}
/**
 * Dynamic-import the WeChat SDK and bridge it. Takes the `importEsm` helper
 * from the host module so we reuse its CJS/ESM interop logic (and so unit
 * tests can drive the loader without touching `Function('return import…')`).
 */
export async function loadWeChatRuntimeSdk(importEsm) {
    const sdk = await importEsm('@mavis/local-runtime-v2/wechat-sdk');
    sdk.setIlinkFetch((url, init) => net.fetch(url, init));
    return buildWeChatRuntimeSdk(sdk);
}
