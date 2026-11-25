import vm from 'node:vm';
import { createElementRuntime } from '../../sdk/element-runtime.js';
import { createHardenedContext } from '../../host/realm/boundary.js';
import { createRealmConsole, sdkModules } from '../../host/realm/realm.js';
/** Test code builds mod and `core` trees; only the module under test may register callbacks. */
const noCallbacks = {
    register: (_callback, target) => {
        throw new Error(`<${target.element} ${target.prop}> in test code: only the module under test can register callbacks`);
    },
};
const SLOT_SCRIPT = new vm.Script(`Object.defineProperty(globalThis, '__mcodeTest', {
    value: Object.seal({ fn: undefined, result: undefined }),
  }).__mcodeTest`, { filename: 'mcode-extension:test-slot' });
/**
 * vm context for one compiled `*.test.tsx`: the same hardened context as a plugin realm (no
 * ambient Node globals, no string or wasm code generation, every host value crossing the
 * boundary), with `/testing` and the module under test as extra specifiers.
 */
export class TestRealm {
    options;
    context;
    boundary;
    slot;
    invoke = new vm.Script('__mcodeTest.result = Reflect.apply(__mcodeTest.fn, undefined, []);', {
        filename: 'mcode-extension:test-invoke',
    });
    constructor(options) {
        this.options = options;
        const modules = new Map([
            ...sdkModules(createElementRuntime(noCallbacks)),
            [options.specifiers.moduleUnderTest, options.moduleUnderTest],
        ]);
        const { context, boundary, globals } = createHardenedContext('mcode-extension:test', {
            console: createRealmConsole(this.options.onLog),
            require: (specifier) => {
                const found = typeof specifier === 'string' ? modules.get(specifier) : undefined;
                if (found === undefined)
                    throw new Error(`Cannot import ${String(specifier)} in a test`);
                return found;
            },
        });
        // `mount`'s spec nests the test's own callbacks (`mcp`, `model`, `agent`, `composer`, `core`,
        // `mods`) that the driver calls later with host values; they cross as boundary wrappers.
        const mount = ((spec) => options.testing.mount(boundary.toHostTree(spec)));
        modules.set(options.specifiers.testing, Object.freeze({ ...options.testing, mount }));
        const module = boundary.object();
        module.exports = boundary.object();
        globals.module = module;
        this.context = context;
        this.boundary = boundary;
        this.slot = SLOT_SCRIPT.runInContext(context);
    }
    /** Runs the bundle body; its `test()` calls register the cases. */
    load(code, filename) {
        try {
            new vm.Script(`(function (module, exports, require) {${code}\n})(module, module.exports, require);`, { filename }).runInContext(this.context, { timeout: this.options.syncTimeoutMs });
        }
        catch (error) {
            throw this.boundary.toHost(error);
        }
    }
    /** Calls a test function with its synchronous part under the vm timeout. */
    run(fn) {
        this.slot.fn = this.boundary.toRealm(fn);
        try {
            this.invoke.runInContext(this.context, { timeout: this.options.syncTimeoutMs });
            return Promise.resolve(this.boundary.toHostResult(this.slot.result));
        }
        catch (error) {
            return Promise.reject(this.boundary.toHost(error));
        }
        finally {
            this.slot.fn = undefined;
            this.slot.result = undefined;
        }
    }
}
//# sourceMappingURL=realm.js.map