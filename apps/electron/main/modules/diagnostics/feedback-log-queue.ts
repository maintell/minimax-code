/**
 * 反馈日志后台上传队列。
 *
 * 渲染进程先建单、拿到工单号，再把日志任务交给这里：立刻装包写进 userData 下的专用目录，
 * 然后分两步——① 上传 OSS 拿 upload_id（拿到就记进清单）；② 调回填接口把日志号补进工单。
 * 哪步失败只重做哪步，失败后按 1 分钟、5 分钟、30 分钟、之后每 2 小时重试；app 启动（已登录）、
 * 唤醒、换回原账号时立即处理一次。同一时间只处理一个任务，退出 app 不等上传。
 * 只处理当前账号的任务，上传和回填前都再核对一次账号；发请求时还会核对这次拿到的登录凭证确实属于任务的
 * 账号（防止核对完、发请求前换了号），对不上就放回队列、不计失败。建单 3 天后仍没成功就报结果（已有 upload_id
 * 报 UPLOADED，否则报 FAILED）；建单满 7 天的任务不管属于哪个账号都直接丢弃。回填接口只有“工单不存在”
 * 和参数错误视为永久失败，其余业务码按重试处理。
 */
import * as fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { app, ipcMain, powerMonitor } from "electron";
import { IPC_CHANNELS } from "../../config/constants";
import { isDev, isTest, isStaging } from "../../config";
import logger from "../../utils/logger";
import { getUserInfo, getDesktopConfig, onUserInfoChanged } from "../../ipc/storage.ipc";
import { writeFeedbackDiagnosticArchive, sanitizeFeedbackLogRequest } from "../../ipc/system.ipc";
import { resolveMatrixApiOrigin, fetchWithSharedAuth, SharedAuthAccountMismatchError, uploadToOSS } from "../oss";
/** 回填接口只接受这两个状态（IDL FeedbackDiagnosticLogStatus）。 */
const DIAGNOSTIC_LOG_STATUS = {
    UPLOADED: 3,
    FAILED: 4,
};
const FEEDBACK_DIAGNOSTIC_LOG_PATH = '/minimax-cloud/api/v1/feedback/ticket/diagnostic-log';
const QUEUE_DIR_NAME = 'feedback-log-queue';
const QUEUE_FILE_NAME = 'queue.json';
const RETRY_DELAYS_MS = [60000, 5 * 60000, 30 * 60000];
const STEADY_RETRY_DELAY_MS = 2 * 60 * 60000;
const GIVE_UP_AFTER_MS = 3 * 24 * 60 * 60000;
/** 建单 7 天后连 FAILED 都没报成功（比如服务端没有回填接口），不再重试，直接丢弃。 */
const ABANDON_AFTER_MS = 7 * 24 * 60 * 60000;
/**
 * 回填接口里明确不可能重试成功的业务码，收到就丢弃任务；其余业务码（含需要登录 1000048）都按重试处理。
 * - 400 / 404：archon_biz constdef.StatusInvalidParams / StatusNotFound（工单不存在时返回 404）；
 * - 1406010011：archon-server 透传的 status_code.STATUS_MATRIX_ARCHON_INVALID_PARAMS。
 */
const PERMANENT_REJECTION_CODES = new Set([400, 404, 1406010011]);
/** 回填请求的总超时；超时按网络错误重试。 */
const REPORT_TIMEOUT_MS = 30000;
/** 上传日志包的总超时（含取预签名地址），放得比较宽，超时按失败重试。 */
const UPLOAD_TIMEOUT_MS = 15 * 60000;
/** 与 renderer 请求签名一致（packages/ui/src/services/mmx-agent/axios.ts）。 */
const REQUEST_SIGNATURE_SECRET = 'I*7Cf%WZ#S&%1RlZJ&C2';
function currentUserId() {
    const userInfo = getUserInfo();
    const userId = userInfo.realUserID || userInfo.userID;
    return typeof userId === 'string' && userId ? userId : undefined;
}
/** 第 n 次失败后多久再试：1 分钟、5 分钟、30 分钟，之后每 2 小时。 */
export function feedbackLogRetryDelayMs(attempts) {
    return RETRY_DELAYS_MS[attempts - 1] ?? STEADY_RETRY_DELAY_MS;
}
/** 记进清单的装包参数：去掉界面消息列表，会话报告里本来就有完整对话。 */
function storedRequest(request) {
    return { ...request, metadata: { ...request.metadata, message_list: [] } };
}
function isStoredRequest(value, ticketId) {
    if (!value || typeof value !== 'object')
        return false;
    const request = value;
    return (request.ticketId === ticketId && !!request.metadata && typeof request.metadata === 'object');
}
function isTask(value) {
    if (!value || typeof value !== 'object')
        return false;
    const task = value;
    return (typeof task.ticketId === 'string' &&
        (task.request === undefined || isStoredRequest(task.request, task.ticketId)) &&
        typeof task.userId === 'string' &&
        (task.zipPath === undefined || typeof task.zipPath === 'string') &&
        (task.uploadId === undefined || typeof task.uploadId === 'string') &&
        Number.isFinite(task.createdAtMs) &&
        Number.isFinite(task.attempts) &&
        Number.isFinite(task.nextAttemptAtMs));
}
function businessCode(body) {
    if (!body || typeof body !== 'object')
        return undefined;
    const record = body;
    const baseResp = record.base_resp;
    if (typeof baseResp?.status_code === 'number' && baseResp.status_code !== 0) {
        return baseResp.status_code;
    }
    const statusInfo = record.statusInfo;
    if (typeof statusInfo?.code === 'number' && statusInfo.code !== 0)
        return statusInfo.code;
    return undefined;
}
function routingHeaders() {
    if (!(isDev || isTest || isStaging))
        return {};
    const lane = getDesktopConfig().swimLaneName?.trim();
    return lane ? { lane, bedrock_lane: lane, 'bedrock-lane': lane } : {};
}
/** 调回填接口。网络错误、超时、非 2xx 和非永久业务码返回 retry；工单不存在、参数错误返回 rejected。 */
async function reportDiagnosticLog(task, status) {
    const url = new URL(FEEDBACK_DIAGNOSTIC_LOG_PATH, resolveMatrixApiOrigin());
    url.searchParams.set('client', 'desktop');
    // 与渲染进程公共参数同名：安装包版本带通道后缀（内测包是 -preview），服务端据此区分内测上报。
    url.searchParams.set('is_desktop', '1');
    url.searchParams.set('desktop_version', app.getVersion());
    const body = JSON.stringify({
        ticket_id: task.ticketId,
        diagnostic_log_status: status,
        ...(status === DIAGNOSTIC_LOG_STATUS.UPLOADED && task.uploadId
            ? {
                diagnostic_log: {
                    upload_id: task.uploadId,
                    ...(task.zipPath ? { file_name: path.basename(task.zipPath) } : {}),
                },
            }
            : {}),
    });
    let response;
    try {
        response = await fetchWithSharedAuth(url.toString(), {
            body,
            timeoutMs: REPORT_TIMEOUT_MS,
            expectedUserId: task.userId,
            extraHeaders: () => {
                const second = String(Math.floor(Date.now() / 1000));
                return {
                    ...routingHeaders(),
                    'x-timestamp': second,
                    'x-signature': createHash('md5')
                        .update(`${second}${REQUEST_SIGNATURE_SECRET}${body}`)
                        .digest('hex'),
                };
            },
        });
    }
    catch (error) {
        if (error instanceof SharedAuthAccountMismatchError) {
            logger.info(`[FeedbackLog] Account changed before reporting ${task.ticketId}; keeping task queued`);
            return 'account_changed';
        }
        logger.warn(`[FeedbackLog] Diagnostic log report for ${task.ticketId} failed: ${error instanceof Error ? error.message : String(error)}`);
        return 'retry';
    }
    if (!response.ok) {
        await response.arrayBuffer().catch(() => undefined);
        logger.warn(`[FeedbackLog] Diagnostic log report for ${task.ticketId} returned HTTP ${response.status}`);
        return 'retry';
    }
    let data;
    try {
        data = await response.json();
    }
    catch {
        logger.warn(`[FeedbackLog] Diagnostic log report for ${task.ticketId} returned invalid JSON`);
        return 'retry';
    }
    const code = businessCode(data);
    if (code === undefined)
        return 'ok';
    if (!PERMANENT_REJECTION_CODES.has(code)) {
        logger.warn(`[FeedbackLog] Diagnostic log report for ${task.ticketId} returned code ${code}; will retry`);
        return 'retry';
    }
    logger.warn(`[FeedbackLog] Diagnostic log report for ${task.ticketId} rejected with code ${code}; dropping task`);
    return 'rejected';
}
export class FeedbackLogQueue {
    constructor(dir) {
        this.dir = dir;
        this.tasks = [];
        this.loaded = false;
        /** 正在装包的工单；装包期间不处理，避免把还没写完的 zip 当成丢失。 */
        this.building = new Set();
        this.buildTail = Promise.resolve();
        this.stopped = false;
    }
    get queueFilePath() {
        return path.join(this.dir, QUEUE_FILE_NAME);
    }
    /** 读取清单；首次读取时顺带清掉清单里没有的残留文件（上次装包到一半的临时文件等）。 */
    load() {
        if (this.loaded)
            return;
        this.loaded = true;
        try {
            const parsed = JSON.parse(fs.readFileSync(this.queueFilePath, 'utf8'));
            this.tasks = Array.isArray(parsed.tasks) ? parsed.tasks.filter(isTask) : [];
        }
        catch (error) {
            if (error?.code !== 'ENOENT') {
                logger.warn(`[FeedbackLog] Failed to read queue file: ${String(error)}`);
            }
            this.tasks = [];
        }
        this.removeUnreferencedFiles();
    }
    removeUnreferencedFiles() {
        let names;
        try {
            names = fs.readdirSync(this.dir);
        }
        catch {
            return;
        }
        const referenced = new Set(this.tasks.flatMap((task) => (task.zipPath ? [path.basename(task.zipPath)] : [])));
        for (const name of names) {
            if (name === QUEUE_FILE_NAME || referenced.has(name))
                continue;
            try {
                fs.rmSync(path.join(this.dir, name), { recursive: true, force: true });
            }
            catch {
                // 残留文件删不掉不影响队列。
            }
        }
    }
    /** 原子写清单：先写临时文件再改名。 */
    persist() {
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            const tempPath = `${this.queueFilePath}.tmp`;
            const content = { schemaVersion: 1, tasks: this.tasks };
            fs.writeFileSync(tempPath, JSON.stringify(content, null, 2), 'utf8');
            fs.renameSync(tempPath, this.queueFilePath);
        }
        catch (error) {
            logger.warn(`[FeedbackLog] Failed to persist queue file: ${String(error)}`);
        }
    }
    /**
     * 收到任务：先记进清单，再在后台装包；装好后立即处理。同步返回是否收下，不等装包。
     * 重复的工单号视为已收下；拿不到当前账号时不收。
     */
    accept(request) {
        if (this.stopped)
            return 'stopped';
        this.load();
        if (this.tasks.some((task) => task.ticketId === request.ticketId))
            return 'duplicate';
        const userId = currentUserId();
        if (!userId) {
            logger.warn(`[FeedbackLog] Not queuing ${request.ticketId}: no signed-in account`);
            return 'not_signed_in';
        }
        const nowMs = Date.now();
        const task = {
            ticketId: request.ticketId,
            userId,
            createdAtMs: nowMs,
            attempts: 0,
            nextAttemptAtMs: nowMs,
            request: storedRequest(request),
        };
        this.tasks.push(task);
        this.building.add(task.ticketId);
        this.persist();
        logger.info(`[FeedbackLog] Queued diagnostic log upload for ${task.ticketId}`);
        this.buildTail = this.buildTail.then(() => this.build(task, request));
        return 'accepted';
    }
    /** accept 之后等装包结束（含之前排着的装包）。 */
    async enqueue(request) {
        const result = this.accept(request);
        await this.buildTail;
        return result;
    }
    async build(task, request) {
        try {
            const { zipPath } = await writeFeedbackDiagnosticArchive(request, this.dir);
            task.zipPath = zipPath;
            this.persist();
        }
        catch (error) {
            // 没装出包（如本地 runtime 还没就绪、拿不到会话报告）：处理时按清单里的装包参数重新装，失败按退避重试。
            logger.warn(`[FeedbackLog] Failed to build diagnostic archive for ${task.ticketId}: ${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            this.building.delete(task.ticketId);
        }
        void this.kick();
    }
    /**
     * 处理队列。force 为 true 时（启动、唤醒、换回账号）不等重试时间，把当前账号的任务都处理一次；
     * 否则只处理到点的任务。正在处理时再次调用会在本轮结束后补跑一轮。
     */
    kick(options = {}) {
        if (this.stopped)
            return Promise.resolve();
        const force = !!options.force;
        if (this.processing) {
            this.pendingRun = { force: force || !!this.pendingRun?.force };
            return this.processing;
        }
        this.processing = (async () => {
            let next = { force };
            while (next && !this.stopped) {
                this.pendingRun = undefined;
                try {
                    await this.runOnce(next.force);
                }
                catch (error) {
                    logger.warn(`[FeedbackLog] Queue run failed: ${String(error)}`);
                }
                next = this.pendingRun;
            }
        })().finally(() => {
            this.processing = undefined;
            this.scheduleNext();
        });
        return this.processing;
    }
    stop() {
        this.stopped = true;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = undefined;
    }
    eligibleTasks(userId) {
        if (!userId)
            return [];
        return this.tasks.filter((task) => task.userId === userId && !this.building.has(task.ticketId));
    }
    /** 本地过期清理：建单满 7 天的任务不管属于哪个账号、有没有登录，直接删任务和 zip。 */
    expireStaleTasks() {
        const nowMs = Date.now();
        for (const task of [...this.tasks]) {
            if (this.building.has(task.ticketId) || nowMs - task.createdAtMs < ABANDON_AFTER_MS)
                continue;
            logger.warn(`[FeedbackLog] Abandoning diagnostic log task for ${task.ticketId} after 7 days without a successful report`);
            this.remove(task);
        }
    }
    /** 任务属于当前登录账号才能上传和回填，否则会用别的账号的登录态。 */
    ownedByCurrentUser(task) {
        return task.userId === currentUserId();
    }
    async runOnce(force) {
        this.load();
        this.expireStaleTasks();
        const handled = new Set();
        for (;;) {
            if (this.stopped)
                return;
            const nowMs = Date.now();
            // 每次都重新读当前账号：处理途中换了账号，剩下的任务先放着。
            const task = this.eligibleTasks(currentUserId()).find((candidate) => !handled.has(candidate.ticketId) && (force || candidate.nextAttemptAtMs <= nowMs));
            if (!task)
                return;
            handled.add(task.ticketId);
            await this.process(task);
        }
    }
    async process(task) {
        if (Date.now() - task.createdAtMs >= GIVE_UP_AFTER_MS) {
            // 日志已经传上、只是回填一直失败时仍报 UPLOADED，不浪费已上传的日志。
            await this.report(task, task.uploadId ? DIAGNOSTIC_LOG_STATUS.UPLOADED : DIAGNOSTIC_LOG_STATUS.FAILED);
            return;
        }
        if (!task.uploadId) {
            if (!task.zipPath || !fs.existsSync(task.zipPath)) {
                if (!task.request) {
                    logger.warn(`[FeedbackLog] Diagnostic archive for ${task.ticketId} is missing`);
                    await this.report(task, DIAGNOSTIC_LOG_STATUS.FAILED);
                    return;
                }
                // 上次退出时还没装完包（或包被删了）：按反馈当时的参数和时间重新装，装不出来就稍后再试。
                if (!(await this.rebuild(task, task.request))) {
                    this.backoff(task);
                    return;
                }
            }
            // 装包可能花了一阵子，期间换了账号就放回队列，不计失败。
            if (!this.ownedByCurrentUser(task))
                return;
            let result;
            try {
                result = await uploadToOSS({ file_path: task.zipPath }, true, {
                    timeoutMs: UPLOAD_TIMEOUT_MS,
                    expectedUserId: task.userId,
                });
            }
            catch (error) {
                if (!(error instanceof SharedAuthAccountMismatchError))
                    throw error;
                // 核对完账号到发请求之间换了号：放回队列、不计失败，换回原账号时再传。
                logger.info(`[FeedbackLog] Account changed before uploading ${task.ticketId}; keeping task queued`);
                this.deferWithoutCounting(task);
                return;
            }
            const uploadId = result.upload_id ? String(result.upload_id).trim() : '';
            if (result.success !== 1 || !uploadId) {
                logger.warn(`[FeedbackLog] Diagnostic archive upload for ${task.ticketId} failed: ${result.err_msg ?? 'unknown error'}`);
                this.backoff(task);
                return;
            }
            task.uploadId = uploadId;
            this.persist();
        }
        await this.report(task, DIAGNOSTIC_LOG_STATUS.UPLOADED);
    }
    async rebuild(task, request) {
        this.building.add(task.ticketId);
        try {
            const { zipPath } = await writeFeedbackDiagnosticArchive(request, this.dir, {
                nowMs: task.createdAtMs,
            });
            task.zipPath = zipPath;
            this.persist();
            logger.info(`[FeedbackLog] Rebuilt ${path.basename(zipPath)} for ticket ${task.ticketId}`);
            return true;
        }
        catch (error) {
            logger.warn(`[FeedbackLog] Failed to rebuild diagnostic archive for ${task.ticketId}: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
        finally {
            this.building.delete(task.ticketId);
        }
    }
    async report(task, status) {
        // 上传途中换了账号：不用新账号的登录态回填旧账号的工单，放回队列、不计失败。
        if (!this.ownedByCurrentUser(task))
            return;
        const outcome = await reportDiagnosticLog(task, status);
        // 发请求前换了号：同样放回队列、不计失败，保留已拿到的 upload_id。
        if (outcome === 'account_changed') {
            this.deferWithoutCounting(task);
            return;
        }
        if (outcome === 'retry') {
            this.backoff(task);
            return;
        }
        if (outcome === 'ok') {
            logger.info(`[FeedbackLog] Reported ${status === DIAGNOSTIC_LOG_STATUS.UPLOADED ? 'uploaded' : 'failed'} diagnostic log for ${task.ticketId}`);
        }
        this.remove(task);
    }
    /**
     * 凭证已经换成别的账号、但本地账号信息还没跟上时，任务仍算当前账号的，不推后会被立刻再排一轮、
     * 原地空转。推后 1 分钟、不加失败次数；换回原账号时会强制处理，不受这个时间影响。
     */
    deferWithoutCounting(task) {
        task.nextAttemptAtMs = Date.now() + RETRY_DELAYS_MS[0];
        this.persist();
    }
    backoff(task) {
        task.attempts += 1;
        task.nextAttemptAtMs = Date.now() + feedbackLogRetryDelayMs(task.attempts);
        this.persist();
    }
    remove(task) {
        if (task.zipPath) {
            try {
                fs.rmSync(task.zipPath, { force: true });
            }
            catch (error) {
                logger.warn(`[FeedbackLog] Failed to delete ${task.zipPath}: ${String(error)}`);
            }
        }
        this.tasks = this.tasks.filter((candidate) => candidate !== task);
        this.persist();
    }
    scheduleNext() {
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = undefined;
        if (this.stopped)
            return;
        const next = this.eligibleTasks(currentUserId()).reduce((earliest, task) => earliest === undefined ? task.nextAttemptAtMs : Math.min(earliest, task.nextAttemptAtMs), undefined);
        if (next === undefined)
            return;
        this.timer = setTimeout(() => void this.kick(), Math.max(0, next - Date.now()));
        this.timer.unref?.();
    }
}

/**
 * 启动队列：注册入队 IPC，监听唤醒和账号变化，登录态就绪后立即处理一次。返回清理函数。
 */
export function setupFeedbackLogQueue(options) {
    const queue = new FeedbackLogQueue(path.join(app.getPath('userData'), QUEUE_DIR_NAME));
    ipcMain.handle(IPC_CHANNELS.SYSTEM_ENQUEUE_FEEDBACK_LOG, (_event, raw) => {
        const request = sanitizeFeedbackLogRequest(raw);
        if (!request)
            return { accepted: false, error: 'invalid_request' };
        // 不等装包和上传，渲染进程只需要知道任务有没有收下。
        const result = queue.accept(request);
        return result === 'accepted' || result === 'duplicate'
            ? { accepted: true }
            : { accepted: false, error: result };
    });
    const onResume = () => void queue.kick({ force: true });
    powerMonitor.on('resume', onResume);
    // 资料编辑也会触发这个事件，只在登录账号真正变化（登录、换回原账号）时处理。
    let lastUserId = currentUserId();
    const stopUserWatch = onUserInfoChanged(() => {
        const userId = currentUserId();
        if (userId === lastUserId)
            return;
        lastUserId = userId;
        if (userId)
            void queue.kick({ force: true });
    });
    // 启动时总跑一轮（过期清理不需要登录态）；已登录时不等重试时间，把当前账号的任务都处理一次。
    void options.authSession
        .getStatus()
        .then((status) => void queue.kick({ force: status.status === 'authenticated' }))
        .catch(() => void queue.kick());
    return () => {
        queue.stop();
        ipcMain.removeHandler(IPC_CHANNELS.SYSTEM_ENQUEUE_FEEDBACK_LOG);
        powerMonitor.removeListener('resume', onResume);
        stopUserWatch();
    };
}
