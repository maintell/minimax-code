/**
 * Migration copy (MR1) of v1 `channels/adapters/wechat/sdk/ilink-auth.ts`.
 */
/**
 * iLink Bot SDK — QR code authentication module.
 *
 * Implements the full scan-to-login flow:
 *   1. GET get_bot_qrcode → QR code URL
 *   2. Long-poll GET get_qrcode_status → wait/scaned/confirmed/expired
 *   3. On confirmed → extract bot_token + ilink_bot_id
 */
import { settleOr } from '../../../settle.js';
import { ilinkFetch } from './ilink-fetch.js';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
import { buildIlinkCommonHeaders } from './ilink-wire.js';
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_BOT_TYPE = '3';
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;
const MAX_QR_REFRESH_COUNT = 3;
// ---------------------------------------------------------------------------
// ILinkAuth
// ---------------------------------------------------------------------------
export class ILinkAuth {
    baseUrl;
    botType;
    constructor(opts = {}) {
        this.baseUrl = ensureTrailingSlash(opts.baseUrl ?? DEFAULT_BASE_URL);
        this.botType = opts.botType ?? DEFAULT_BOT_TYPE;
    }
    /**
     * Fetch a new QR code for scanning.
     * Returns the qrcode token and the content for display.
     *
     * The qrcodeUrl can be:
     * - A URL to encode (http/https/weixin scheme) → use QRCodeSVG
     * - A data:image URL → display as <img>
     * - Raw base64 image data → convert to data URL and display as <img>
     */
    async getQrCode() {
        const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(this.botType)}`, this.baseUrl);
        const res = await ilinkFetch(url.toString());
        if (!res.ok) {
            const body = await settleOr(res.text(), '(unreadable)');
            throw new Error(`Failed to fetch QR code: ${res.status} ${res.statusText} body=${body}`);
        }
        const data = (await res.json());
        logger.info({
            qrcodePrefix: data.qrcode?.slice(0, 20),
            imageContentType: typeof data.qrcode_img_content,
            imageContentLength: data.qrcode_img_content?.length,
        }, 'ILink QR code response received');
        let qrcodeUrl = data.qrcode_img_content;
        let isImageData = false;
        // Detect the format of qrcode_img_content
        if (qrcodeUrl) {
            if (qrcodeUrl.startsWith('http://') || qrcodeUrl.startsWith('https://')) {
                // HTTP URL - this is the content to encode into a QR code
                isImageData = false;
            }
            else if (qrcodeUrl.startsWith('weixin://') || qrcodeUrl.includes('://')) {
                // WeChat deep link or other URL scheme - encode into QR
                isImageData = false;
            }
            else if (qrcodeUrl.startsWith('data:image/')) {
                // Already a data URL image - display directly
                isImageData = true;
            }
            else if (qrcodeUrl.startsWith('data:text/html')) {
                // HTML content - we can't easily render this, treat as URL to encode
                // This is a fallback; ideally the API should return a proper URL
                logger.warn({ reason: 'html_qrcode_content' }, 'ILink QR image content treated as URL');
                isImageData = false;
            }
            else {
                // Likely raw base64 image data - convert to data URL
                qrcodeUrl = `data:image/png;base64,${qrcodeUrl}`;
                isImageData = true;
            }
        }
        return {
            qrcode: data.qrcode,
            qrcodeUrl,
            isImageData,
        };
    }
    /**
     * Single long-poll for QR status (~35s).
     * Returns "wait" on timeout (normal behavior).
     */
    async pollQrStatus(qrcode) {
        const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, this.baseUrl);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS);
        try {
            const res = await ilinkFetch(url.toString(), {
                headers: buildIlinkCommonHeaders(),
                signal: controller.signal,
            });
            clearTimeout(timer);
            if (!res.ok) {
                const body = await settleOr(res.text(), '(unreadable)');
                throw new Error(`QR status poll failed: ${res.status} ${res.statusText} body=${body}`);
            }
            return (await res.json());
        }
        catch (err) {
            clearTimeout(timer);
            if (err instanceof Error && err.name === 'AbortError') {
                return { status: 'wait' };
            }
            throw err;
        }
    }
    /**
     * Complete login flow: get QR → poll until confirmed/timeout.
     *
     * @param opts.timeoutMs  Overall timeout (default 5 min)
     * @param opts.onStatus   Status callback for UI updates
     * @param opts.onQrCode   Called with qrcodeUrl each time a new QR is generated
     */
    async login(opts) {
        const timeoutMs = opts?.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
        const deadline = Date.now() + timeoutMs;
        let refreshCount = 0;
        const result = await this.getQrCode();
        let { qrcode, qrcodeUrl } = result;
        opts?.onQrCode?.(qrcodeUrl);
        opts?.onStatus?.('wait', 'please scan the QR code with WeChat');
        while (Date.now() < deadline) {
            const resp = await this.pollQrStatus(qrcode);
            switch (resp.status) {
                case 'wait':
                    // Normal long-poll timeout, continue
                    break;
                case 'scaned':
                    opts?.onStatus?.('scaned', 'scanned, please confirm on WeChat');
                    break;
                case 'expired': {
                    refreshCount++;
                    if (refreshCount >= MAX_QR_REFRESH_COUNT) {
                        throw new Error('QR code expired multiple times, please restart the login process');
                    }
                    opts?.onStatus?.('expired', `QR code expired, refreshing (${refreshCount}/${MAX_QR_REFRESH_COUNT})`);
                    const refreshed = await this.getQrCode();
                    qrcode = refreshed.qrcode;
                    qrcodeUrl = refreshed.qrcodeUrl;
                    opts?.onQrCode?.(qrcodeUrl);
                    break;
                }
                case 'confirmed':
                    if (!resp.ilink_bot_id) {
                        throw new Error('login failed: server did not return ilink_bot_id');
                    }
                    if (!resp.bot_token) {
                        throw new Error('login failed: server did not return bot_token');
                    }
                    opts?.onStatus?.('confirmed', 'login successfully');
                    return {
                        botToken: resp.bot_token,
                        ilinkBotId: resp.ilink_bot_id,
                        baseUrl: resp.baseurl,
                        userId: resp.ilink_user_id,
                    };
            }
        }
        throw new Error('login timed out, please try again');
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ensureTrailingSlash(url) {
    return url.endsWith('/') ? url : `${url}/`;
}
//# sourceMappingURL=ilink-auth.js.map