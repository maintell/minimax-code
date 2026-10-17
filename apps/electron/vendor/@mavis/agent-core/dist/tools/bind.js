/**
 * `@bindTool(def)` —— TC39 stage-3 类装饰器,把 `ToolDefinition` 关联到一个
 * `ToolImpl` 实现类。同名工具的不同实现(`CloudBashTool` / `LocalBashTool`)
 * 各自 `@bindTool(BashToolDef)` 即可。
 *
 * `toRuntimeTool(instance)` —— 把装饰过的 class 实例换成 `RuntimeTool`,
 * PiTurnRunner 接受 `RuntimeTool[]` 作为输入。
 *
 * 装饰器执行时机:TC39 stage-3 装饰器在 class evaluation 时跑,`CLASS_TO_DEF.set`
 * 在 import 装饰类的文件时就完成。`toRuntimeTool` 在实例化后任何时间调用都
 * 能找到 def。
 */
// eslint-disable-next-line @typescript-eslint/ban-types
const CLASS_TO_DEF = new WeakMap();
/**
 * Class 装饰器:把 `ToolDefinition` 关联到 `ToolImpl<S, TCtx>` 实现类。
 *
 * ```ts
 * @bindTool(BashToolDef)
 * export class CloudBashTool implements ToolImpl<typeof BashToolDef.schema, CloudRuntimeContext> {
 *   async execute(ctx, input) { ... }   // input 自动推导成 Static<typeof BashToolDef.schema>
 * }
 * ```
 */
export function bindTool(def) {
    return function (target, _context) {
        // eslint-disable-next-line @typescript-eslint/ban-types
        CLASS_TO_DEF.set(target, def);
        return target;
    };
}
/**
 * 把装饰过的 class 实例换成 `RuntimeTool`。class 未装饰直接抛错 —— 这是
 * 编程错误(忘记 `@bindTool`),不应该 silent 退化。
 */
export function toRuntimeTool(instance) {
    const def = CLASS_TO_DEF.get(instance.constructor);
    if (!def) {
        throw new Error(`toRuntimeTool: ${instance.constructor.name} is missing the @bindTool(...) decorator`);
    }
    return { def, impl: instance };
}
//# sourceMappingURL=bind.js.map