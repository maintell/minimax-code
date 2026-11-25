import { createRenderTreeValidator, isHandle, TREE_PROFILE_SPECS, } from '@mavis/shared/plugin-extension';
import { createMatchers } from './expect.js';
import { findNodes } from './query.js';
const DEFAULT_WAIT_MS = 2_000;
const WAIT_INTERVAL_MS = 20;
/** Binds the `/testing` API to a host driver. Host-facing; plugin code never calls it. */
export function createExtensionTesting(driver) {
    const sites = new Map();
    const registered = [];
    const record = (site) => {
        const found = sites.get(site);
        if (!found)
            throw new Error('This site is not mounted (it was unmounted or never mounted).');
        return found;
    };
    const refresh = async (entry) => {
        await entry.driver.settle();
        const render = entry.driver.current();
        validate(entry, render);
        entry.display = render ? await displayTree(entry.options, render, entry.driver.site) : [];
    };
    /** The renderer/host stand-ins a test chose to supply. */
    const optionalFakes = (options) => ({
        ...(options.mcp ? { mcp: options.mcp } : {}),
        ...(options.agent ? { agent: options.agent } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.composer ? { composer: options.composer } : {}),
        ...(options.usage ? { usage: options.usage } : {}),
        ...(options.state ? { state: options.state } : {}),
    });
    const mount = async (input) => {
        const options = 'site' in input ? { ...input, slot: input.site, key: '' } : input;
        const driverSite = await driver.mount({
            register: options.register,
            mods: options.mods ?? [],
            slot: options.slot,
            key: options.key,
            ...('id' in input && input.id !== undefined ? { id: input.id } : {}),
            props: (options.props ?? {}),
            match: options.match ?? {},
            clock: options.clock ?? 'fake',
            ...optionalFakes(options),
        });
        const entry = {
            driver: driverSite,
            options,
            validation: [],
            display: [],
            validatedSeq: undefined,
        };
        const site = {
            slot: options.slot,
            key: options.key,
            tree: () => entry.display,
            state: () => driverSite.state(),
            get diagnostics() {
                return [...driverSite.diagnostics(), ...entry.validation];
            },
            get effects() {
                return driverSite.effects();
            },
            advance: async (ms) => {
                await driverSite.advance(ms);
                await refresh(entry);
            },
        };
        sites.set(site, entry);
        await refresh(entry);
        return site;
    };
    const find = (site, query) => findNodes(record(site).display, query)[0];
    const press = async (site, target, value) => {
        const entry = record(site);
        const found = target && 'node' in target ? target : findNodes(entry.display, target ?? {})[0];
        if (!found)
            throw new Error(`No element matches ${JSON.stringify(target ?? {})}`);
        const render = entry.driver.current();
        if (!render)
            throw new Error('The site has not rendered yet.');
        // Every gesture is sent from the same tree, in order and without waiting in between, as the
        // renderer sends a changed Input's `onInput` right before its `onSubmit`.
        await Promise.all(gesturesFor(found, value).map((gesture) => entry.driver.gesture({ ...gesture, renderSeq: render.renderSeq })));
        await refresh(entry);
    };
    const waitFor = async (assertion, options = {}) => {
        const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_WAIT_MS);
        for (;;) {
            for (const entry of sites.values())
                await refresh(entry);
            try {
                return await assertion();
            }
            catch (error) {
                if (Date.now() >= deadline)
                    throw error;
            }
            await driver.sleep(WAIT_INTERVAL_MS);
        }
    };
    const unmount = async (site) => {
        const entry = sites.get(site);
        if (!entry)
            return;
        sites.delete(site);
        await entry.driver.unmount();
    };
    return {
        mount: mount,
        find,
        findAll: (site, query) => findNodes(record(site).display, query),
        press,
        waitFor,
        completeAgent: async (site, completion) => {
            const entry = record(site);
            await entry.driver.completeAgent(completion);
            await refresh(entry);
        },
        unmount,
        test: (name, fn) => {
            if (typeof name !== 'string' || typeof fn !== 'function') {
                throw new TypeError('test(name, fn) needs a name and a function');
            }
            registered.push({ name, fn });
        },
        expect: createMatchers,
        registered,
        unmountAll: async () => {
            for (const site of [...sites.keys()])
                await unmount(site);
        },
    };
}
/** The tree the renderer validates is the host's, before `core` stands in for the host node. */
function validate(entry, render) {
    if (!render || render.kind !== 'tree' || render.renderSeq === entry.validatedSeq)
        return;
    entry.validatedSeq = render.renderSeq;
    const profile = entry.driver.site.treeProfile;
    const { elements, coreKind } = entry.driver.site;
    const validated = createRenderTreeValidator(TREE_PROFILE_SPECS[profile].limits, {
        coreKind,
        ...(elements ? { elements } : {}),
    }).tree(render.tree);
    if (validated.ok)
        return;
    entry.validation.push({
        code: 'TREE_INVALID',
        message: `${validated.path.join('.') || '(root)'}: ${validated.message}`.slice(0, 2_000),
        fix: 'Return only catalog elements with token props; the renderer falls back on invalid subtrees.',
    });
}
async function displayTree(options, render, site) {
    const core = options.core;
    const coreProps = render.coreProps ?? {};
    const coreTree = async () => {
        if (!core)
            return site.coreKind === 'none' ? [] : { type: 'host' };
        return core({
            slot: options.slot,
            key: options.key,
            surface: 'desktop',
            props: coreProps,
        });
    };
    if (render.kind === 'hostDefault')
        return coreTree();
    if (!core)
        return render.tree;
    return replaceHost(render.tree, await coreTree());
}
function replaceHost(tree, core) {
    const swap = (node) => {
        if (typeof node === 'string')
            return node;
        if (node.type === 'host')
            return core;
        if (!node.children)
            return node;
        return { ...node, children: node.children.flatMap((child) => swap(child)) };
    };
    if (Array.isArray(tree))
        return tree.flatMap((node) => swap(node));
    return swap(tree);
}
function gesturesFor(found, value) {
    const node = found.node;
    if (node.type === 'host')
        throw new Error('The host default view cannot be pressed.');
    const props = node.props;
    const withHandle = (prop, kind, sent) => {
        const handle = props[prop];
        if (!isHandle(handle))
            throw new Error(`<${node.type}> has no ${prop} callback`);
        return {
            kind,
            plugin: handle.plugin,
            handle: handle.handle,
            ...(sent === undefined ? {} : { value: sent }),
        };
    };
    switch (node.type) {
        case 'Button':
            return [withHandle('onPress', 'press', value)];
        case 'Switch':
            return [withHandle('onChange', 'press', value ?? props.checked !== true)];
        case 'Select':
            if (value === undefined)
                throw new Error('press(<Select>) needs the option value');
            return [withHandle('onSelect', 'select', value)];
        case 'Input':
            return inputGesture(props, value, withHandle);
        default:
            throw new Error(`<${node.type}> cannot be pressed`);
    }
}
/**
 * Typing `value` and pressing Enter: a changed text reaches `onInput` first, then `onSubmit`, as
 * the renderer flushes the edit before the submit. Without `onSubmit` only `onInput` runs.
 */
function inputGesture(props, value, withHandle) {
    const sent = value ?? stringOr(props.value);
    if (!isHandle(props.onSubmit))
        return [withHandle('onInput', 'input', sent)];
    const submit = withHandle('onSubmit', 'press', sent);
    const edited = isHandle(props.onInput) && value !== undefined && value !== props.value;
    return edited ? [withHandle('onInput', 'input', sent), submit] : [submit];
}
function stringOr(value) {
    return typeof value === 'string' ? value : '';
}
//# sourceMappingURL=harness.js.map