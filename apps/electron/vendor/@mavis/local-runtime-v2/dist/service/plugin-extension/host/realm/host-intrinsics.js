/**
 * Second layer under `RealmBoundary`, for threads that run nothing but extension realms (the
 * render Worker and the `extension test` Worker; never the main thread). Should a host value
 * still reach plugin code by a path the boundary does not convert, it leads nowhere useful:
 *
 * - the host function constructors are sealed: `constructor` on the four function prototypes is a
 *   function that throws, so no host function compiles code;
 * - the host intrinsics plugin code could reach from a host object are frozen (the `Object`,
 *   `Array`, `Promise` and `Error` families, the four function kinds and the iterator
 *   prototypes, with their constructors), so plugin code cannot plant a getter or replace a
 *   method that host code later runs.
 *
 * Freezing alone would break plain host code through the "override mistake": assigning
 * `error.name` or `object.toString` throws once the inherited property is read-only. Those few
 * properties become accessors whose setter defines the property on the receiver instead, the way
 * Node's `--frozen-intrinsics` does. Node's own code is unaffected: it holds its intrinsics from
 * startup.
 */
const OVERRIDABLE = ['constructor', 'name', 'message', 'toString', 'toLocaleString', 'valueOf'];
const FUNCTION_KINDS = [
    ['Function', () => undefined],
    ['AsyncFunction', async () => undefined],
    [
        'GeneratorFunction',
        function* sampleGenerator() {
            yield undefined;
        },
    ],
    [
        'AsyncGeneratorFunction',
        async function* sampleAsyncGenerator() {
            yield undefined;
        },
    ],
];
let hardened = false;
/** Seals and freezes this thread's host intrinsics; call once, before any realm loads. */
export function hardenWorkerIntrinsics() {
    if (hardened)
        return;
    hardened = true;
    sealFunctionConstructors();
    for (const target of hardenedIntrinsics()) {
        if (!target)
            continue;
        for (const key of OVERRIDABLE)
            enableOverride(target, key);
        Object.freeze(target);
    }
}
function sealFunctionConstructors() {
    for (const [name, sample] of FUNCTION_KINDS) {
        const prototype = Reflect.getPrototypeOf(sample);
        if (!prototype)
            continue;
        const sealed = {
            [name]() {
                throw new EvalError('Code generation is disabled in the extension host');
            },
        }[name];
        Object.defineProperty(prototype, 'constructor', {
            value: sealed,
            writable: true,
            enumerable: false,
            configurable: true,
        });
    }
}
/**
 * What `hardenWorkerIntrinsics` freezes: the intrinsics a host object leads to.
 * @internal Exported for focused tests.
 */
export function hardenedIntrinsics() {
    const proto = (value) => value === null || value === undefined ? undefined : Reflect.getPrototypeOf(Object(value));
    const generator = proto(FUNCTION_KINDS[2][1]);
    const asyncGenerator = proto(FUNCTION_KINDS[3][1]);
    const generatorPrototype = generator?.prototype;
    const asyncGeneratorPrototype = asyncGenerator?.prototype;
    const arrayIterator = proto([][Symbol.iterator]());
    const asyncIterator = proto(asyncGeneratorPrototype);
    const errors = [
        Error,
        TypeError,
        RangeError,
        SyntaxError,
        ReferenceError,
        EvalError,
        URIError,
        AggregateError,
    ];
    return [
        Object,
        Object.prototype,
        Function,
        Function.prototype,
        proto(FUNCTION_KINDS[1][1]),
        generator,
        generatorPrototype,
        asyncGenerator,
        asyncGeneratorPrototype,
        Array,
        Array.prototype,
        Promise,
        Promise.prototype,
        ...errors.flatMap((constructor) => [constructor, constructor.prototype]),
        proto(arrayIterator),
        arrayIterator,
        asyncIterator,
        proto(new Map().entries()),
        proto(new Set().values()),
        proto(''[Symbol.iterator]()),
        proto(/x/gu[Symbol.matchAll]('')),
    ];
}
/** Turns an inherited data property into an accessor whose setter shadows it on the receiver. */
function enableOverride(target, key) {
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.configurable)
        return;
    const { value } = descriptor;
    Object.defineProperty(target, key, {
        get: function getIntrinsic() {
            return value;
        },
        set: function overrideIntrinsic(next) {
            if (this === target) {
                throw new TypeError(`Cannot assign to read only property '${key}' of a frozen intrinsic`);
            }
            Object.defineProperty(this, key, {
                value: next,
                writable: true,
                enumerable: true,
                configurable: true,
            });
        },
        enumerable: descriptor.enumerable ?? false,
        configurable: false,
    });
}
//# sourceMappingURL=host-intrinsics.js.map