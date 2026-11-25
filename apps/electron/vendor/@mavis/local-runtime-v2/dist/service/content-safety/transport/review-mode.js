import { logger } from '@mavis/shared/local-runtime-logging';
import { fetchCommonConfig } from '../../model-system/index.js';
/**
 * 服务端审核开关：托管模型本轮的输入、思考和正文是否改由 biz-gateway 审核。
 *
 * 开关是 common_config（Apollo）里的 key `agent_desktop_server_content_review`，经公开的 common_config
 * 接口读取，不带登录态；staging 构建按惯例优先读 `pre_` 前缀的同名 key。预览口令和泳道与模型预设读
 * common_config 时同源（`PREVIEW_SECRET`、`MAVIS_PLUGIN_CLOUD_LANE`），两者读到的是同一份配置。值为布尔 `true`（或文本
 * `"true"`）才算开；key 不存在、`false`、其他取值、请求失败或超时，一律算关，桌面端在本地送审。
 * 开关不跟网关版本走：网关停审或回滚之前，要先把 key 改成 false，并等至少 `FRESH_MS`。
 *
 * 不起定时器：每轮读开关时，结果超过 `REFRESH_AFTER_MS` 就在后台重新请求一次，本轮不等结果；
 * 超过 `FRESH_MS` 还没拿到新结果就按关处理。空闲的客户端不发请求，长时间空闲后的第一轮
 * 也不会沿用过期的「开」。时长用墙钟计，合盖睡眠的时间也算在内；系统时间被往回调、算出负数时同样按
 * 过期处理并重新请求。
 *
 * 结果变化时（包括第一次拿到结果）在 runtime 日志里记一条，带算不算开和原因，同样的结果不重复记；
 * 取值不认识或请求失败记 warn。
 */
const CONTENT_REVIEW_MODE_CONFIG_KEY = 'agent_desktop_server_content_review';
const CONTENT_REVIEW_MODE_FRESH_MS = 5 * 60_000;
const CONTENT_REVIEW_MODE_REFRESH_AFTER_MS = 4 * 60_000;
const CONTENT_REVIEW_MODE_TIMEOUT_MS = 5_000;
export function createContentReviewModeProbe(options = {}) {
    const now = options.nowMs ?? Date.now;
    const readSwitch = options.readSwitch ??
        (() => fetchCommonConfig(CONTENT_REVIEW_MODE_CONFIG_KEY, {
            timeoutMs: CONTENT_REVIEW_MODE_TIMEOUT_MS,
            previewSecret: process.env.PREVIEW_SECRET,
            lane: process.env.MAVIS_PLUGIN_CLOUD_LANE,
        }));
    let enabled = false;
    let fetchedAtMs;
    let reported;
    // 在途的刷新；refresh 自己吞掉所有失败，不会 reject。
    let pending;
    const refresh = async () => {
        let answer;
        try {
            answer = readAnswer(await readSwitch());
        }
        catch (error) {
            answer = {
                serverReview: false,
                reason: 'request_failed',
                errorName: error instanceof Error ? error.name : typeof error,
            };
        }
        enabled = answer.serverReview;
        fetchedAtMs = now();
        pending = undefined;
        reported = reportChange(reported, answer);
    };
    return {
        serverReviewEnabled: () => {
            // 还没拿到结果时为 NaN，下面的比较都不成立：按过期处理并去请求。
            const ageMs = fetchedAtMs === undefined ? Number.NaN : now() - fetchedAtMs;
            const settled = ageMs >= 0 && ageMs < CONTENT_REVIEW_MODE_REFRESH_AFTER_MS;
            if (!pending && !settled)
                pending = refresh();
            return enabled && ageMs >= 0 && ageMs < CONTENT_REVIEW_MODE_FRESH_MS;
        },
    };
}
/** Apollo 的值经接口返回时通常已解析成 JSON 布尔，存成文本的 `"true"` / `"false"` 同样认。 */
function readAnswer(value) {
    if (value === undefined)
        return { serverReview: false, reason: 'absent' };
    if (value === true || value === 'true')
        return { serverReview: true, reason: 'on' };
    if (value === false || value === 'false')
        return { serverReview: false, reason: 'off' };
    return { serverReview: false, reason: 'bad_value' };
}
/** 结果和上次记的不一样才记一条，返回这次的记录键。 */
function reportChange(previous, answer) {
    const key = `${answer.reason}:${answer.errorName ?? ''}`;
    if (key === previous)
        return key;
    const fields = {
        event: 'content_review_mode',
        server_review: answer.serverReview,
        reason: answer.reason,
        ...(answer.errorName ? { error_name: answer.errorName } : {}),
    };
    if (answer.reason === 'bad_value' || answer.reason === 'request_failed') {
        logger.warn(fields, '[content-safety] server review switch unreadable, reviewing locally');
    }
    else {
        logger.info(fields, '[content-safety] server review switch');
    }
    return key;
}
//# sourceMappingURL=review-mode.js.map