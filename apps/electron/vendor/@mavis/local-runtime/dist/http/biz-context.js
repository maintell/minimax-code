import { AsyncLocalStorage } from 'node:async_hooks';
import { HTTP_SERVICE_BIZ_ID_HEADER } from '@mavis/thrift-gen/runtime';
const bizIdStorage = new AsyncLocalStorage();
export function runWithDesktopServiceRequestContext(request, callback) {
    return bizIdStorage.run(readBizIdFromRequest(request), callback);
}
export function getBizId() {
    return bizIdStorage.getStore();
}
function readBizIdFromRequest(request) {
    const raw = request.headers.get(HTTP_SERVICE_BIZ_ID_HEADER);
    if (!raw)
        return undefined;
    const value = raw.trim();
    return value.length > 0 ? value : undefined;
}
//# sourceMappingURL=biz-context.js.map