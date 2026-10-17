/**
 * Migration copy (MR1) of v1 `channels/adapters/wechat/wechat-onboard.ts`.
 */
/**
 * WeChat iLink real onboarding flow.
 *
 * Implements two stages:
 *   1. `startBindReal` — POST a fresh QR via iLink `get_bot_qrcode` (no auth)
 *      and persist a `pending` bind session in {@link LocalWeChatChannelStore}.
 *   2. `pollBindStatusReal` — one-shot long-poll iLink `get_qrcode_status`;
 *      on `confirmed`, finalize the binding with the issued `bot_token` /
 *      `ilink_bot_id`.
 *
 * HTTP transport is `globalThis.fetch` so we stay portable across Node + test
 * runners; production (Electron main) shares the same call surface. Tests
 * stub `globalThis.fetch` to drive deterministic transitions.
 */
import { settleOr } from '../../settle.js';
import { buildIlinkCommonHeaders } from './sdk/ilink-wire.js';
const DEFAULT_ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_BOT_TYPE = '3';
/**
 * Call iLink `/ilink/bot/get_bot_qrcode` and persist a `pending` binding.
 * Returns the QR url for the UI to render.
 */
export async function startBindReal(input, store, options = {}) {
    // Overwrite guard: the UI auto-fires startBind on mount (incl. when the user
    // merely re-opens the bind dialog to inspect an already-bound channel). The
    // legacy behaviour blindly persisted a fresh `pending:` record under the same
    // `wechat:<agent>` clientId key, clobbering a previously `confirmed`
    // (`connected: true`) binding back to disconnected. That is what made a
    // successful scan "disappear" on the next visit. Only an active real polling
    // binding can short-circuit; a disabled rollback row must get a fresh QR
    // instead of being reported as confirmed.
    const existing = await store.get(input.agentName);
    const alreadyBound = alreadyBoundResult(existing, input.sessionId);
    if (alreadyBound)
        return alreadyBound;
    const baseUrl = ensureTrailingSlash(input.baseUrl ?? DEFAULT_ILINK_BASE_URL);
    const botType = encodeURIComponent(input.botType ?? DEFAULT_BOT_TYPE);
    const url = `${baseUrl}ilink/bot/get_bot_qrcode?bot_type=${botType}`;
    const doFetch = options.fetch ?? globalFetch();
    const res = await doFetch(url);
    if (!res.ok) {
        const body = await settleOr(res.text(), '(unreadable)');
        throw new Error(`iLink getQrCode failed: ${res.status} ${res.statusText} body=${body}`);
    }
    const data = (await res.json());
    const { qrcodeUrl, isImageData } = normaliseQrContent(data.qrcode_img_content);
    await store.bind({
        agentName: input.agentName,
        botToken: `pending:${input.sessionId}`,
        bindSessionId: input.sessionId,
        qrcodeUrl,
        qrcodeToken: data.qrcode,
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
        mode: 'polling',
        connected: false,
    });
    return {
        status: 'pending',
        sessionId: input.sessionId,
        qrcode: data.qrcode,
        qrcodeUrl,
        isImageData,
    };
}
/** Active real polling binding short-circuits; rollback rows fall through. */
function alreadyBoundResult(existing, sessionId) {
    if (existing?.enabled === true &&
        existing.connected === true &&
        existing.mode === 'polling' &&
        existing.botToken &&
        !existing.botToken.startsWith('pending:')) {
        return {
            status: 'pending',
            sessionId: existing.bindSessionId ?? sessionId,
            qrcode: existing.qrcodeToken ?? '',
            qrcodeUrl: existing.qrcodeUrl ?? '',
            isImageData: false,
            alreadyBound: true,
        };
    }
    return undefined;
}
/**
 * Long-poll iLink `/ilink/bot/get_qrcode_status` once. On `confirmed`, write
 * the real `bot_token` and `ilink_bot_id` back into the binding so the
 * monitor / outbound paths can find them.
 *
 * Reads the persisted `qrcodeToken` field from the binding record (written
 * by {@link startBindReal}); the caller MUST go through that flow first so
 * the token is available.
 */
export async function pollBindStatusReal(input, store, options = {}) {
    const record = await store.getByBindSessionId(input.sessionId);
    if (!record) {
        return { status: 'expired', sessionId: input.sessionId, error: 'bind session expired' };
    }
    const preResolved = preResolvedPollResult(record, input.sessionId);
    if (preResolved)
        return preResolved;
    const polled = await fetchQrStatusOnce({ input, record, options });
    if ('result' in polled)
        return polled.result;
    return settlePollStatus({ resp: polled.resp, store, record, sessionId: input.sessionId });
}
/**
 * One long-poll round against `/ilink/bot/get_qrcode_status`. An abort
 * (long-poll window elapsed) reads as `pending`; transport failures map to
 * the error contract so the caller returns them verbatim.
 */
async function fetchQrStatusOnce(poll) {
    const { input, record } = poll;
    const qrcode = record.qrcodeToken ?? '';
    const baseUrl = ensureTrailingSlash(input.baseUrl ?? record.baseUrl ?? DEFAULT_ILINK_BASE_URL);
    const url = `${baseUrl}ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    const doFetch = poll.options.fetch ?? globalFetch();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS);
    try {
        const res = await doFetch(url, {
            headers: buildIlinkCommonHeaders(),
            signal: controller.signal,
        });
        if (!res.ok) {
            const body = await settleOr(res.text(), '(unreadable)');
            return {
                result: {
                    status: 'error',
                    sessionId: input.sessionId,
                    error: `status poll ${res.status}: ${body}`,
                },
            };
        }
        return { resp: (await res.json()) };
    }
    catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
            return {
                result: { status: 'pending', sessionId: input.sessionId, qrcodeUrl: record.qrcodeUrl },
            };
        }
        return {
            result: {
                status: 'error',
                sessionId: input.sessionId,
                error: err instanceof Error ? err.message : String(err),
            },
        };
    }
    finally {
        clearTimeout(timer);
    }
}
function formatUnknownStatus(resp) {
    if (resp.errmsg || resp.errcode !== undefined) {
        return `iLink status error${resp.errcode !== undefined ? ` ${resp.errcode}` : ''}: ${resp.errmsg ?? 'unknown error'}`;
    }
    return `unexpected iLink QR status: ${String(resp.status ?? 'missing')}`;
}
/** Persist the confirmed credentials, switching mode to `polling`. */
async function finaliseBinding(store, pending, input) {
    await store.bind({
        agentName: pending.agentName,
        botToken: input.botToken,
        ilinkBotId: input.ilinkBotId,
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
        ...(pending.botName ? { botName: pending.botName } : {}),
        ...(pending.bindSessionId ? { bindSessionId: pending.bindSessionId } : {}),
        ...(pending.qrcodeUrl ? { qrcodeUrl: pending.qrcodeUrl } : {}),
        mode: 'polling',
        connected: true,
    });
}
/** Compute the QR url + isImageData flag from the raw `qrcode_img_content`. */
function normaliseQrContent(raw) {
    if (!raw)
        return { qrcodeUrl: '', isImageData: false };
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
        return { qrcodeUrl: raw, isImageData: false };
    }
    if (raw.startsWith('weixin://') || raw.includes('://')) {
        return { qrcodeUrl: raw, isImageData: false };
    }
    if (raw.startsWith('data:image/')) {
        return { qrcodeUrl: raw, isImageData: true };
    }
    // Treat as raw base64 image data.
    return { qrcodeUrl: `data:image/png;base64,${raw}`, isImageData: true };
}
function ensureTrailingSlash(url) {
    return url.endsWith('/') ? url : `${url}/`;
}
function globalFetch() {
    const g = globalThis;
    if (!g.fetch)
        throw new Error('globalThis.fetch is not available');
    return g.fetch.bind(globalThis);
}
/** A binding that already carries a live token needs no further polling. */
function preResolvedPollResult(record, sessionId) {
    if (record.enabled &&
        record.connected &&
        record.botToken &&
        !record.botToken.startsWith('pending:')) {
        return {
            status: 'confirmed',
            sessionId,
            clientId: record.clientId,
            botToken: record.botToken,
            ilinkBotId: record.ilinkBotId ?? '',
            ...(record.baseUrl ? { baseUrl: record.baseUrl } : {}),
        };
    }
    if (!record.qrcodeToken) {
        return { status: 'error', sessionId, error: 'qrcode token missing' };
    }
    return undefined;
}
/** Map one iLink QR status response onto the poll contract; persists on confirm. */
async function settlePollStatus(input) {
    const { resp, record, sessionId } = input;
    switch (resp.status) {
        case 'wait':
            return { status: 'pending', sessionId, qrcodeUrl: record.qrcodeUrl };
        case 'scaned':
            return { status: 'scanned', sessionId, qrcodeUrl: record.qrcodeUrl };
        case 'expired':
            return { status: 'expired', sessionId, error: 'qr expired' };
        case 'confirmed':
            return settleConfirmed(input);
        case 'scaned_but_redirect':
        case 'need_verifycode':
        case 'verify_code_blocked':
        case 'binded_redirect':
            return {
                status: 'error',
                sessionId,
                error: `unsupported iLink QR status: ${resp.status}`,
            };
        default:
            return { status: 'error', sessionId, error: formatUnknownStatus(resp) };
    }
}
/** Write the real bot_token / ilink_bot_id back so monitor + outbound can run. */
async function settleConfirmed(input) {
    const { resp, store, record, sessionId } = input;
    if (!resp.bot_token || !resp.ilink_bot_id) {
        return {
            status: 'error',
            sessionId,
            error: 'confirmed without bot_token / ilink_bot_id',
        };
    }
    await finaliseBinding(store, record, {
        botToken: resp.bot_token,
        ilinkBotId: resp.ilink_bot_id,
        baseUrl: resp.baseurl,
    });
    return {
        status: 'confirmed',
        sessionId,
        clientId: record.clientId,
        botToken: resp.bot_token,
        ilinkBotId: resp.ilink_bot_id,
        ...(resp.baseurl ? { baseUrl: resp.baseurl } : {}),
    };
}
//# sourceMappingURL=wechat-onboard.js.map