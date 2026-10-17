/**
 * Memory V2 对外导出面。
 *
 * 只暴露 runtime 装配需要的入口与类型；领域服务、adapter 与契约细节都不外泄，
 * 消费方一律经 `InitializedMemorySystem` 的九个成员访问（§5.17）。
 */
export { initializeRuntimeMemoryV2System, initializeProductionMemoryV2System, } from './production.js';
// §5.15 DesktopAdapter 需要的作用域展示标识；全局单作用域下即 scopeKey 本身。
export { GLOBAL_SCOPE_KEY } from './contracts.js';
export { createMemoryExecutionQuery } from './execution/query.js';
//# sourceMappingURL=index.js.map