import { reviewBlocks } from '@mavis/shared/local-runtime-safety';
import {} from './contracts.js';
/**
 * Shared safety policy service. Business owners decide when a review is
 * required; the v2 initializer owns the transport and borrowed legacy ports.
 */
export class ContentSafetyService {
    options;
    closed = false;
    closePromise;
    close() {
        this.closed = true;
        this.closePromise ??= this.options.close?.() ?? Promise.resolve();
        return this.closePromise;
    }
    constructor(options) {
        this.options = options;
    }
    review = async (content, scene) => {
        if (this.closed)
            return { pass: false, errorKind: 'local_error' };
        try {
            return await this.options.review(content, scene);
        }
        catch {
            return { pass: false, errorKind: 'local_error' };
        }
    };
    /** 这一轮托管模型的审核是否交给网关；服务关闭后、开关读不出来时都按本地送审处理。 */
    serverReviewEnabled = () => {
        if (this.closed)
            return false;
        try {
            return this.options.serverReviewEnabled?.() === true;
        }
        catch {
            return false;
        }
    };
    async blocks(content, scene) {
        if (!content.trim())
            return false;
        return reviewBlocks(await this.review(content, scene));
    }
}
export { reviewBlocks } from '@mavis/shared/local-runtime-safety';
export { digestSafetyInput, isInputSafetyDecision } from '@mavis/harness';
//# sourceMappingURL=content-safety.service.js.map