/**
 * Migration copy (MR1) of v1 `channels/adapters/wechat/wechat-sdk-stub.ts`.
 */
/**
 * Default WeChat runtime SDK stub.
 *
 * Slice 2 ships the {@link WeChatRuntimeSdk} *contract* but defers the
 * production wiring (which depends on `sdk/index.ts`, which in turn
 * uses Electron's `net` module) to a follow-up MR. Until then, the host
 * registers this no-op stub so:
 *
 *   1. The unified adapter contract is in place on day one — questionnaire
 *      bridge / channel runner can call into `wechat` adapters from
 *      synchronous code paths without dynamic-import gymnastics.
 *   2. Unit tests that don't bind an iLink credential never go through the
 *      stub's throwing code paths.
 *   3. Production Electron main can `import('./sdk/index.js')` and
 *      construct a real {@link WeChatRuntimeSdk} on top of `ILinkClient` /
 *      `sendTextMessage` / `uploadImage` / etc. as a single later patch
 *      without touching any caller.
 *
 * Every method throws a clearly-labelled error so a misconfigured
 * production setup (binding present but no real SDK injected) surfaces
 * immediately rather than silently dropping outbound traffic.
 */
import { EventEmitter } from 'node:events';
const STUB_ERROR_MSG = 'WeChat runtime SDK not wired — host must inject a real WeChatRuntimeSdk (slice 2 backlog)';
class StubClient {
    baseUrl;
    token;
    constructor(token, baseUrl) {
        this.baseUrl = baseUrl;
        this.token = token;
    }
    setToken(token) {
        this.token = token;
    }
    getToken() {
        return this.token;
    }
    getBaseUrl() {
        return this.baseUrl;
    }
}
export const stubWeChatRuntimeSdk = {
    createClient(opts) {
        return new StubClient(opts.token, opts.baseUrl ?? '');
    },
    sendText(_params) {
        return Promise.reject(new Error(STUB_ERROR_MSG));
    },
    sendMediaFile(_params) {
        return Promise.reject(new Error(STUB_ERROR_MSG));
    },
    uploadImage(_params) {
        return Promise.reject(new Error(STUB_ERROR_MSG));
    },
    uploadVideo(_params) {
        return Promise.reject(new Error(STUB_ERROR_MSG));
    },
    uploadFile(_params) {
        return Promise.reject(new Error(STUB_ERROR_MSG));
    },
    downloadAndDecrypt(_input) {
        return Promise.reject(new Error(STUB_ERROR_MSG));
    },
    createMonitor(_params) {
        return new StubMonitorHandle();
    },
};
/**
 * Inert monitor handle used when no real SDK is wired (unit tests, missing
 * production wiring). `start()` resolves immediately, `getState()` always
 * returns the empty cursor, no messages are ever emitted. Tests that need
 * to drive inbound traffic substitute their own fake — see
 * `test/unit/local-wechat-monitor.test.ts`.
 */
class StubMonitorHandle {
    emitter = new EventEmitter();
    running = false;
    async start() {
        this.running = true;
    }
    stop() {
        this.running = false;
    }
    isRunning() {
        return this.running;
    }
    getState() {
        return '';
    }
    on(event, listener) {
        this.emitter.on(event, listener);
        return this;
    }
    off(event, listener) {
        this.emitter.off(event, listener);
        return this;
    }
}
//# sourceMappingURL=wechat-sdk-stub.js.map