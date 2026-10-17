import { AsyncLocalStorage } from "node:async_hooks";
const initExecution = new AsyncLocalStorage();
class LifecycleContractError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LifecycleContractError';
    }
}
export class LifecycleInitFatalError extends Error {
    constructor(ownerName, results, cause) {
        super(`Fatal lifecycle init failure: ${ownerName}`);
        this.name = 'LifecycleInitFatalError';
        this.results = [...results];
        this.cause = cause;
    }
}

function isThenable(value) {
    return ((typeof value === 'object' && value !== null && 'then' in value) ||
        (typeof value === 'function' && 'then' in value));
}
function observeIgnoredThenable(value) {
    void Promise.resolve(value).catch(() => undefined);
}
function isSameThenable(value, candidate) {
    return value === candidate;
}
function deferredValue() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}
function deferredVoid() {
    let resolve;
    const promise = new Promise((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}
function abortError(signal) {
    if (signal.reason instanceof Error)
        return signal.reason;
    const error = new Error('Lifecycle disposal aborted');
    error.name = 'AbortError';
    return error;
}
export class LifecycleKernel {
    constructor(dependencies) {
        this.modules = [];
        this.moduleNames = new Set();
        this.initResults = [];
        this.lifecycleState = 'registering';
        this.beforeReadyRan = false;
        this.beforeQuitRan = false;
        this.disposeBarrierClosed = false;
        this.dependencies = dependencies;
    }
    get state() {
        return this.lifecycleState;
    }
    register(module) {
        if (this.lifecycleState !== 'registering') {
            throw new LifecycleContractError('Lifecycle registration is closed');
        }
        if (!module || typeof module.name !== 'string' || module.name.length === 0) {
            throw new LifecycleContractError('Lifecycle module requires a non-empty name');
        }
        if (this.moduleNames.has(module.name)) {
            throw new LifecycleContractError(`duplicate lifecycle module: ${module.name}`);
        }
        if (module.phase !== 'beforeReady' && module.phase !== 'whenReady') {
            throw new LifecycleContractError(`Invalid lifecycle phase for ${module.name}`);
        }
        if (typeof module.init !== 'function') {
            throw new LifecycleContractError(`Lifecycle module ${module.name} requires an explicit init`);
        }
        if (module.onInitError !== 'fatal' && module.onInitError !== 'continue') {
            throw new LifecycleContractError(`Lifecycle module ${module.name} requires an explicit onInitError policy`);
        }
        for (const dependency of module.dependsOn ?? []) {
            const dependencyOwner = this.modules.find((candidate) => candidate.module.name === dependency);
            if (!dependencyOwner) {
                throw new LifecycleContractError(`dependency must be registered first: ${module.name} -> ${dependency}`);
            }
            if (module.phase === 'beforeReady' && dependencyOwner.module.phase === 'whenReady') {
                throw new LifecycleContractError(`Lifecycle beforeReady module ${module.name} cannot depend on whenReady module ${dependency}`);
            }
        }
        if (module.dispose !== undefined) {
            if (typeof module.dispose !== 'function') {
                throw new LifecycleContractError(`Lifecycle module ${module.name} has an invalid dispose`);
            }
            if (!module.disposeStage) {
                throw new LifecycleContractError(`Lifecycle module ${module.name} must declare disposeStage`);
            }
            if (!['pre', 'parallel', 'post'].includes(module.disposeStage)) {
                throw new LifecycleContractError(`Lifecycle module ${module.name} has an invalid disposeStage`);
            }
            if (module.disposeStage === 'parallel' &&
                (!Number.isFinite(module.disposeTimeoutMs) || (module.disposeTimeoutMs ?? 0) <= 0)) {
                throw new LifecycleContractError(`Lifecycle module ${module.name} requires a positive disposeTimeoutMs`);
            }
        }
        const storedModule = {
            ...module,
            dependsOn: module.dependsOn ? [...module.dependsOn] : undefined,
        };
        this.modules.push({ index: this.modules.length, module: storedModule });
        this.moduleNames.add(module.name);
    }
    runBeforeReady() {
        if (this.beforeReadyRan) {
            throw new LifecycleContractError('runBeforeReady has already run');
        }
        this.beforeReadyRan = true;
        this.beginStarting();
        for (const owner of this.modules) {
            if (owner.module.phase !== 'beforeReady')
                continue;
            if (this.lifecycleState === 'disposing' || this.lifecycleState === 'disposed')
                break;
            const blocked = this.blockedResult(owner);
            let result;
            if (blocked) {
                result = blocked;
            }
            else {
                const invocation = this.startInit(owner);
                if (!invocation.synchronousResult) {
                    throw new LifecycleContractError(`Lifecycle beforeReady init did not settle synchronously: ${owner.module.name}`);
                }
                result = invocation.synchronousResult;
                if (this.currentInit === invocation.inFlight)
                    this.currentInit = undefined;
            }
            if (this.disposeBarrierClosed)
                break;
            this.recordInitResult(owner, result);
            if (result.status === 'failed' && owner.module.onInitError === 'fatal') {
                throw new LifecycleInitFatalError(owner.module.name, this.initResults, result.error);
            }
        }
        return [...this.initResults];
    }
    runWhenReady() {
        const initContext = initExecution.getStore();
        if (initContext?.kernel === this && initContext.active) {
            if (initContext.onStack) {
                initContext.joinedReadyOnStack = true;
            }
            else {
                throw new LifecycleContractError(`Lifecycle init cannot join its own runWhenReady promise: ${initContext.owner.module.name}`);
            }
        }
        if (this.whenReadyPromise)
            return this.whenReadyPromise;
        this.beginStarting();
        const completion = deferredValue();
        this.whenReadyPromise = completion.promise;
        void this.executeWhenReady().then(completion.resolve, completion.reject);
        return this.whenReadyPromise;
    }
    runBeforeQuit() {
        if (this.beforeQuitRan)
            return;
        this.beforeQuitRan = true;
        for (const owner of this.modules) {
            if (owner.initResult?.status !== 'initialized' || !owner.module.beforeQuit)
                continue;
            try {
                owner.module.beforeQuit();
            }
            catch (error) {
                this.dependencies.logger.error(`Lifecycle beforeQuit failed: ${owner.module.name}`, error);
            }
        }
    }
    disposeAll(options = {}) {
        if (this.disposePromise)
            return this.disposePromise;
        this.lifecycleState = 'disposing';
        const completion = deferredValue();
        this.disposePromise = completion.promise;
        const requestedInFlight = this.currentInit;
        const execute = () => {
            const snapshot = this.modules.filter((owner) => owner.initResult?.status === 'initialized');
            const inFlight = requestedInFlight && requestedInFlight.owner.initResult === undefined
                ? requestedInFlight
                : this.currentInit;
            return this.executeDispose(snapshot, inFlight, options.signal);
        };
        const initContext = initExecution.getStore();
        const deferSnapshot = initContext?.kernel === this &&
            initContext?.onStack === true &&
            (initContext.owner.module.disposeStage === 'pre' ||
                initContext.owner.module.disposeStage === 'post');
        const execution = deferSnapshot ? Promise.resolve().then(execute) : execute();
        void execution.then(completion.resolve, completion.reject);
        return this.disposePromise;
    }
    beginStarting() {
        if (this.lifecycleState === 'registering') {
            this.lifecycleState = 'starting';
            return;
        }
        if (this.lifecycleState !== 'starting') {
            throw new LifecycleContractError(`Cannot start lifecycle modules while state is ${this.lifecycleState}`);
        }
    }
    blockedResult(owner) {
        const blockedBy = (owner.module.dependsOn ?? []).find((dependency) => {
            const dependencyOwner = this.modules.find((candidate) => candidate.module.name === dependency);
            return (dependencyOwner?.initResult?.status === 'failed' ||
                dependencyOwner?.initResult?.status === 'blocked');
        });
        if (!blockedBy)
            return undefined;
        const startedAtMs = this.dependencies.now();
        return {
            name: owner.module.name,
            phase: owner.module.phase,
            status: 'blocked',
            startedAtMs,
            durationMs: 0,
            error: new Error(`Lifecycle init blocked by dependency: ${blockedBy}`),
        };
    }
    async executeWhenReady() {
        for (const owner of this.modules) {
            if (owner.module.phase !== 'whenReady')
                continue;
            if (this.lifecycleState === 'disposing' || this.lifecycleState === 'disposed')
                break;
            const blocked = this.blockedResult(owner);
            if (blocked) {
                this.recordInitResult(owner, blocked);
                continue;
            }
            const invocation = this.startInit(owner);
            let result;
            if (invocation.synchronousResult) {
                result = invocation.synchronousResult;
                if (this.currentInit === invocation.inFlight)
                    this.currentInit = undefined;
            }
            else {
                result = await invocation.inFlight.promise;
                if (this.currentInit === invocation.inFlight)
                    this.currentInit = undefined;
            }
            if (this.disposeBarrierClosed)
                break;
            this.recordInitResult(owner, result);
            if (result.status === 'failed' && owner.module.onInitError === 'fatal') {
                throw new LifecycleInitFatalError(owner.module.name, this.initResults, result.error);
            }
        }
        if (this.lifecycleState === 'starting')
            this.lifecycleState = 'ready';
        return [...this.initResults];
    }
    startInit(owner) {
        const startedAtMs = this.dependencies.now();
        const completion = deferredValue();
        const inFlight = { owner, promise: completion.promise };
        this.currentInit = inFlight;
        const initContext = {
            kernel: this,
            owner,
            active: true,
            onStack: true,
            joinedReadyOnStack: false,
        };
        const settleSynchronously = (result) => {
            initContext.active = false;
            completion.resolve(result);
            return { inFlight, synchronousResult: result };
        };
        try {
            const returned = initExecution.run(initContext, () => {
                try {
                    return owner.module.init();
                }
                finally {
                    initContext.onStack = false;
                }
            });
            if (isThenable(returned)) {
                if (owner.module.phase === 'beforeReady') {
                    initContext.active = false;
                    observeIgnoredThenable(returned);
                    throw new LifecycleContractError(`Lifecycle beforeReady init must be synchronous: ${owner.module.name}`);
                }
                if (initContext.joinedReadyOnStack) {
                    initContext.active = false;
                    observeIgnoredThenable(returned);
                    throw new LifecycleContractError(`Lifecycle init returned a self-referential lifecycle promise: ${owner.module.name}`);
                }
                if (owner.module.disposeStage === 'pre' || owner.module.disposeStage === 'post') {
                    initContext.active = false;
                    observeIgnoredThenable(returned);
                    throw new LifecycleContractError(`Lifecycle init must be synchronous for ${owner.module.disposeStage} disposer owner: ${owner.module.name}`);
                }
                if (isSameThenable(returned, this.whenReadyPromise) ||
                    isSameThenable(returned, this.disposePromise) ||
                    isSameThenable(returned, completion.promise)) {
                    initContext.active = false;
                    observeIgnoredThenable(returned);
                    throw new LifecycleContractError(`Lifecycle init returned a self-referential lifecycle promise: ${owner.module.name}`);
                }
                void Promise.resolve(returned).then(() => {
                    initContext.active = false;
                    completion.resolve(this.initResult(owner, 'initialized', startedAtMs));
                }, (error) => {
                    initContext.active = false;
                    if (!this.disposeBarrierClosed) {
                        this.dependencies.logger.error(`Lifecycle init failed: ${owner.module.name}`, error);
                    }
                    completion.resolve(this.initResult(owner, 'failed', startedAtMs, error));
                });
                return { inFlight };
            }
            return settleSynchronously(this.initResult(owner, 'initialized', startedAtMs));
        }
        catch (error) {
            initContext.active = false;
            initContext.onStack = false;
            if (!this.disposeBarrierClosed) {
                this.dependencies.logger.error(`Lifecycle init failed: ${owner.module.name}`, error);
            }
            return settleSynchronously(this.initResult(owner, 'failed', startedAtMs, error));
        }
    }
    initResult(owner, status, startedAtMs, error) {
        return {
            name: owner.module.name,
            phase: owner.module.phase,
            status,
            startedAtMs,
            durationMs: Math.max(0, this.dependencies.now() - startedAtMs),
            ...(error === undefined ? {} : { error }),
        };
    }
    recordInitResult(owner, result) {
        owner.initResult = result;
        this.initResults.push(result);
    }
    async executeDispose(snapshot, inFlight, signal) {
        const resultByOwner = new Map();
        const pending = new Set();
        const unfinishedDisposeOwners = new Set();
        const unfinishedInitOwners = new Set();
        let barrierClosed = false;
        let aborted = false;
        let inFlightSettled = !inFlight;
        const recordSynchronousStage = (owner, stage) => {
            const result = this.invokeSynchronousDispose(owner, stage);
            resultByOwner.set(owner, result);
        };
        const prepareParallel = (owner) => {
            const operation = this.createParallelDispose(owner, resultByOwner, unfinishedDisposeOwners);
            pending.add(operation);
            void operation.completion.finally(() => pending.delete(operation));
            return operation;
        };
        const snapshotParallel = [];
        for (const owner of snapshot) {
            if (owner.module.dispose && owner.module.disposeStage === 'parallel') {
                snapshotParallel.push(prepareParallel(owner));
            }
        }
        const joinInFlight = async () => {
            if (!inFlight)
                return;
            const result = await inFlight.promise;
            inFlightSettled = true;
            await Promise.resolve();
            if (barrierClosed || result.status !== 'initialized')
                return;
            if (inFlight.owner.module.dispose && inFlight.owner.module.disposeStage === 'parallel') {
                const operation = prepareParallel(inFlight.owner);
                operation.start();
                await operation.completion;
            }
        };
        const abortGate = deferredVoid();
        const onAbort = () => {
            if (barrierClosed)
                return;
            aborted = true;
            barrierClosed = true;
            this.disposeBarrierClosed = true;
            const error = signal ? abortError(signal) : new Error('Lifecycle disposal aborted');
            if (inFlight && !inFlightSettled)
                unfinishedInitOwners.add(inFlight.owner);
            for (const operation of [...pending]) {
                if (!operation.isClosed())
                    operation.close('timed-out', error, true);
            }
            abortGate.resolve();
        };
        for (const owner of snapshot) {
            if (owner.module.dispose && owner.module.disposeStage === 'pre') {
                recordSynchronousStage(owner, 'pre');
            }
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted)
            onAbort();
        for (const operation of snapshotParallel)
            operation.start();
        const allWork = Promise.all([
            ...snapshotParallel.map((operation) => operation.completion),
            joinInFlight(),
        ]).then(() => undefined);
        await Promise.race([allWork, abortGate.promise]);
        barrierClosed = true;
        this.disposeBarrierClosed = true;
        signal?.removeEventListener('abort', onAbort);
        for (const owner of snapshot) {
            if (owner.module.dispose && owner.module.disposeStage === 'post') {
                recordSynchronousStage(owner, 'post');
            }
        }
        this.lifecycleState = 'disposed';
        return {
            results: [...resultByOwner.entries()]
                .sort(([left], [right]) => left.index - right.index)
                .map(([, result]) => result),
            aborted,
            unfinishedInitOwners: [...unfinishedInitOwners]
                .sort((left, right) => left.index - right.index)
                .map((owner) => owner.module.name),
            unfinishedDisposeOwners: [...unfinishedDisposeOwners]
                .sort((left, right) => left.index - right.index)
                .map((owner) => owner.module.name),
        };
    }
    invokeSynchronousDispose(owner, stage) {
        const startedAtMs = this.dependencies.now();
        try {
            const returned = owner.module.dispose?.();
            if (isThenable(returned)) {
                observeIgnoredThenable(returned);
                throw new LifecycleContractError(`Lifecycle ${stage} dispose must be synchronous: ${owner.module.name}`);
            }
            return this.disposeResult(owner, stage, 'disposed', startedAtMs);
        }
        catch (error) {
            this.dependencies.logger.error(`Lifecycle dispose failed: ${owner.module.name}`, error);
            return this.disposeResult(owner, stage, 'failed', startedAtMs, error);
        }
    }
    createParallelDispose(owner, resultByOwner, unfinishedOwners) {
        let startedAtMs;
        const completion = deferredVoid();
        let closed = false;
        let timeout;
        const close = (status, error, unfinished = false) => {
            if (closed)
                return;
            closed = true;
            if (timeout !== undefined)
                this.dependencies.clearTimeout(timeout);
            if (unfinished)
                unfinishedOwners.add(owner);
            const resultStartedAtMs = startedAtMs ?? this.dependencies.now();
            startedAtMs = resultStartedAtMs;
            resultByOwner.set(owner, this.disposeResult(owner, 'parallel', status, resultStartedAtMs, error));
            completion.resolve();
        };
        const start = () => {
            if (closed)
                return;
            startedAtMs = this.dependencies.now();
            try {
                const returned = owner.module.dispose?.();
                if (isThenable(returned)) {
                    if (closed) {
                        observeIgnoredThenable(returned);
                        return;
                    }
                    if (isSameThenable(returned, this.disposePromise) ||
                        isSameThenable(returned, completion.promise)) {
                        observeIgnoredThenable(returned);
                        throw new LifecycleContractError(`Lifecycle dispose returned a self-referential lifecycle promise: ${owner.module.name}`);
                    }
                    const timeoutMs = owner.module.disposeTimeoutMs;
                    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
                        throw new LifecycleContractError(`Lifecycle module ${owner.module.name} requires a positive disposeTimeoutMs`);
                    }
                    void Promise.resolve(returned).then(() => close('disposed'), (error) => {
                        if (closed)
                            return;
                        this.dependencies.logger.error(`Lifecycle dispose failed: ${owner.module.name}`, error);
                        close('failed', error);
                    });
                    if (closed)
                        return;
                    timeout = this.dependencies.setTimeout(() => {
                        if (closed)
                            return;
                        const error = new Error(`Lifecycle dispose timed out: ${owner.module.name}`);
                        this.dependencies.logger.warn(error.message, error);
                        close('timed-out', error, true);
                    }, timeoutMs);
                }
                else {
                    close('disposed');
                }
            }
            catch (error) {
                if (closed)
                    return;
                this.dependencies.logger.error(`Lifecycle dispose failed: ${owner.module.name}`, error);
                close('failed', error);
            }
        };
        return {
            owner,
            completion: completion.promise,
            start,
            close,
            isClosed: () => closed,
        };
    }
    disposeResult(owner, stage, status, startedAtMs, error) {
        return {
            name: owner.module.name,
            stage,
            status,
            startedAtMs,
            durationMs: Math.max(0, this.dependencies.now() - startedAtMs),
            ...(error === undefined ? {} : { error }),
        };
    }
}

