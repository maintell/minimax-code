import { getRuntimeBuildEnv } from '@mavis/config';
export function isPeekEnabled(configGetter) {
    return getRuntimeBuildEnv() !== 'prod' && configGetter?.().beta?.peek !== false;
}
//# sourceMappingURL=peek-gate.js.map