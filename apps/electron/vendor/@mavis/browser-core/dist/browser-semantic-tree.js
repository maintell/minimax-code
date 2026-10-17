import { CanonicalNodeRegistry } from './browser-semantic-registry.js';
export { CanonicalNodeRegistry } from './browser-semantic-registry.js';
export { serializeSemanticTreePage } from './browser-semantic-serializer.js';
const STRUCTURAL_ROLES = new Set([
    'document',
    'main',
    'navigation',
    'region',
    'article',
    'form',
    'dialog',
    'alertdialog',
    'heading',
    'list',
    'listitem',
    'table',
    'row',
    'cell',
    'columnheader',
    'rowheader',
    'group',
]);
const TEXT_CONTEXT_ROLES = new Set([
    'paragraph',
    'label',
    'caption',
    'note',
    'status',
    'alert',
    'description',
]);
const DESCENDANT_TEXT_EXCLUDED_ROLES = new Set([
    'document',
    'main',
    'navigation',
    'region',
    'article',
    'form',
    'dialog',
    'alertdialog',
    'list',
    'table',
    'row',
    'group',
]);
const TAG_ROLES = {
    '#document': 'document',
    main: 'main',
    nav: 'navigation',
    section: 'region',
    article: 'article',
    form: 'form',
    dialog: 'dialog',
    h1: 'heading',
    h2: 'heading',
    h3: 'heading',
    h4: 'heading',
    h5: 'heading',
    h6: 'heading',
    ul: 'list',
    ol: 'list',
    li: 'listitem',
    table: 'table',
    tr: 'row',
    td: 'cell',
    th: 'columnheader',
    p: 'paragraph',
    label: 'label',
    caption: 'caption',
    button: 'button',
    a: 'link',
    textarea: 'textbox',
    select: 'combobox',
    option: 'option',
};
const AX_STATE_PROPERTIES = new Set([
    'busy',
    'checked',
    'disabled',
    'editable',
    'expanded',
    'focusable',
    'focused',
    'invalid',
    'multiline',
    'multiselectable',
    'pressed',
    'readonly',
    'required',
    'selected',
]);
function attributes(node) {
    const values = node?.attributes ?? [];
    const result = {};
    for (let index = 0; index + 1 < values.length; index += 2) {
        const key = values[index];
        const value = values[index + 1];
        if (key)
            result[key.toLowerCase()] = value ?? '';
    }
    return result;
}
function cleanText(value, maxLength = 300) {
    if (typeof value !== 'string')
        return '';
    return value.replace(/\s+/gu, ' ').trim().slice(0, maxLength);
}
function descendantText(node, maxLength = 300) {
    if (!node)
        return '';
    let result = '';
    const visit = (current) => {
        if (result.length >= maxLength)
            return;
        if (current.nodeType === 3 && current.nodeValue) {
            result += ` ${current.nodeValue}`;
            return;
        }
        for (const child of current.children ?? [])
            visit(child);
        for (const shadowRoot of current.shadowRoots ?? [])
            visit(shadowRoot);
        if (current.contentDocument)
            visit(current.contentDocument);
    };
    visit(node);
    return cleanText(result, maxLength);
}
function axPropertyValue(node, name) {
    return node?.properties?.find((property) => property.name === name)?.value?.value;
}
function semanticRole(node, semanticSource) {
    const axRole = cleanText(semanticSource?.ax?.role?.value ?? node.ax?.role?.value, 80).toLowerCase();
    if (axRole && axRole !== 'none' && axRole !== 'generic')
        return axRole;
    const targetRole = cleanText(node.target?.type, 80).toLowerCase();
    if (targetRole && targetRole !== 'none' && targetRole !== 'generic')
        return targetRole;
    const domAttributes = attributes(semanticSource?.dom ?? node.dom);
    const explicitRole = cleanText(domAttributes.role, 80).toLowerCase();
    if (explicitRole && explicitRole !== 'none' && explicitRole !== 'generic')
        return explicitRole;
    const tag = (semanticSource?.dom?.nodeName ??
        node.dom?.nodeName ??
        node.target?.tag ??
        '').toLowerCase();
    if (tag === 'input') {
        const inputType = (domAttributes.type ?? node.target?.attributes.type ?? 'text').toLowerCase();
        if (inputType === 'checkbox' || inputType === 'radio')
            return inputType;
        if (inputType === 'submit' || inputType === 'button' || inputType === 'reset')
            return 'button';
        return 'textbox';
    }
    return TAG_ROLES[tag] ?? 'generic';
}
function semanticName(node, semanticSource, role) {
    const source = semanticSource ?? node;
    const sourceAttributes = attributes(source.dom);
    const targetAttributes = node.target?.attributes ?? {};
    const mayUseDescendantText = !DESCENDANT_TEXT_EXCLUDED_ROLES.has(role);
    return cleanText(source.ax?.name?.value ??
        node.ax?.name?.value ??
        node.target?.text ??
        sourceAttributes['aria-label'] ??
        targetAttributes['aria-label'] ??
        sourceAttributes.title ??
        targetAttributes.title ??
        sourceAttributes.placeholder ??
        targetAttributes.placeholder ??
        sourceAttributes.alt ??
        targetAttributes.alt ??
        (mayUseDescendantText ? descendantText(source.dom ?? node.dom) : ''));
}
function semanticDescription(node, semanticSource) {
    return cleanText(semanticSource?.ax?.description?.value ?? node.ax?.description?.value);
}
function headingLevel(node, semanticSource) {
    const axLevel = axPropertyValue(semanticSource?.ax ?? node.ax, 'level');
    if (typeof axLevel === 'number' && Number.isFinite(axLevel) && axLevel > 0)
        return axLevel;
    const tag = (semanticSource?.dom?.nodeName ?? node.dom?.nodeName ?? '').toLowerCase();
    const match = /^h([1-6])$/u.exec(tag);
    return match ? Number(match[1]) : undefined;
}
function semanticState(node, semanticSource) {
    const state = {};
    const axNode = semanticSource?.ax ?? node.ax;
    for (const property of axNode?.properties ?? []) {
        if (!AX_STATE_PROPERTIES.has(property.name))
            continue;
        const value = property.value?.value;
        if (typeof value === 'boolean' || typeof value === 'string')
            state[property.name] = value;
    }
    const targetAttributes = node.target?.attributes ?? {};
    for (const [attribute, key] of [
        ['aria-expanded', 'expanded'],
        ['aria-selected', 'selected'],
        ['aria-checked', 'checked'],
        ['aria-pressed', 'pressed'],
        ['aria-invalid', 'invalid'],
        ['aria-required', 'required'],
    ]) {
        const value = targetAttributes[attribute];
        if (value === 'true' || value === 'false')
            state[key] = value === 'true';
        else if (value)
            state[key] = value;
    }
    return Object.keys(state).length > 0 ? state : undefined;
}
function isMeaningfulNode(role, name, description, state, actionable) {
    if (actionable)
        return true;
    if (STRUCTURAL_ROLES.has(role))
        return role !== 'group' || Boolean(name);
    if (TEXT_CONTEXT_ROLES.has(role))
        return Boolean(name || description);
    return Boolean(state) && role !== 'generic';
}
function isSemanticallyHidden(node) {
    if (node.target)
        return false;
    const domAttributes = attributes(node.dom);
    if ('hidden' in domAttributes || domAttributes['aria-hidden'] === 'true')
        return true;
    if (node.dom?.nodeName?.toLowerCase() === 'input' &&
        domAttributes.type?.toLowerCase() === 'hidden') {
        return true;
    }
    const styles = node.layout?.computedStyles;
    return (styles?.display === 'none' ||
        styles?.visibility === 'hidden' ||
        Number.parseFloat(styles?.opacity ?? '1') <= 0);
}
export function buildSemanticPageTree(input) {
    const registry = new CanonicalNodeRegistry(input.mainFrameId);
    if (input.domRoot)
        registry.addDOMTree(input.domRoot);
    registry.addSnapshotRecords(input.snapshotLookup ?? new Map());
    registry.addAXTree(input.axNodes ?? []);
    registry.addInteractiveElements(input.interactiveElements ?? []);
    const canonicalNodes = registry.values();
    const aliasedSemanticSources = new Set(canonicalNodes
        .map((node) => node.semanticSourceKey)
        .filter((key) => typeof key === 'string'));
    const semanticByKey = new Map();
    let collapsedCount = 0;
    for (const canonical of canonicalNodes) {
        if (canonical.dom?.nodeType === 3 || canonical.dom?.nodeType === 8)
            continue;
        if (canonical.ax?.ignored && !canonical.target)
            continue;
        if (isSemanticallyHidden(canonical))
            continue;
        if (aliasedSemanticSources.has(canonical.key) && !canonical.target)
            continue;
        const semanticSource = canonical.semanticSourceKey
            ? registry.get(canonical.semanticSourceKey)
            : undefined;
        const role = semanticRole(canonical, semanticSource);
        const name = semanticName(canonical, semanticSource, role);
        const description = semanticDescription(canonical, semanticSource);
        const state = semanticState(canonical, semanticSource);
        if (!isMeaningfulNode(role, name, description, state, Boolean(canonical.target))) {
            collapsedCount += 1;
            continue;
        }
        const level = role === 'heading' ? headingLevel(canonical, semanticSource) : undefined;
        const provenance = new Set(canonical.provenance);
        for (const source of semanticSource?.provenance ?? [])
            provenance.add(source);
        semanticByKey.set(canonical.key, {
            id: canonical.key,
            role,
            ...(name ? { name } : {}),
            ...(description ? { text: description } : {}),
            ...(level ? { level } : {}),
            ...(state ? { state } : {}),
            ...(canonical.target
                ? {
                    targetKey: canonical.key,
                    rect: { ...canonical.target.boundingBox },
                    coordinateSpace: canonical.target.coordinateSpace === 'unavailable'
                        ? 'unavailable'
                        : 'main-frame-viewport',
                    ...(canonical.target.inputStrategy
                        ? { inputStrategy: canonical.target.inputStrategy }
                        : {}),
                }
                : {}),
            provenance: [...provenance],
            children: [],
        });
    }
    const roots = [];
    const nearestSemanticParent = (canonical) => {
        const visited = new Set();
        // DOM ancestry preserves concrete region/form ownership. AX remains the fallback for
        // semantic-only nodes and relationships that have no DOM-backed parent.
        let parentKey = canonical.domParentKey ?? canonical.axParentKey;
        while (parentKey && !visited.has(parentKey)) {
            visited.add(parentKey);
            const semantic = semanticByKey.get(parentKey);
            if (semantic)
                return semantic;
            const parent = registry.get(parentKey);
            parentKey = parent?.domParentKey ?? parent?.axParentKey;
        }
        return undefined;
    };
    for (const canonical of canonicalNodes) {
        const semantic = semanticByKey.get(canonical.key);
        if (!semantic)
            continue;
        const parent = nearestSemanticParent(canonical);
        if (parent && parent !== semantic)
            parent.children.push(semantic);
        else
            roots.push(semantic);
    }
    const semanticNodeCount = semanticByKey.size;
    const actionableCount = [...semanticByKey.values()].filter((node) => node.targetKey).length;
    return {
        version: 1,
        roots,
        stats: {
            canonicalNodeCount: canonicalNodes.length,
            semanticNodeCount,
            actionableCount,
            semanticOnlyCount: semanticNodeCount - actionableCount,
            collapsedCount,
        },
        truncated: false,
    };
}
//# sourceMappingURL=browser-semantic-tree.js.map