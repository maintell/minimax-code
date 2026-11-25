import { isValidModelMenuAdvisor, isAdvisorAction, isAdvisorActionAllowed, isAdvisorUpgradeAllowed } from "./model-menu-advisor";
export function positionModelMenu(anchor, direction, align, measurement, area, horizontalPadding = 16) {
    const { menu, overlay, submenu } = measurement;
    const child = submenu?.child;
    const values = [
        ...Object.values(anchor),
        ...Object.values(menu),
        ...(overlay ? [overlay.width, overlay.height, overlay.bottomInset] : []),
        ...(submenu ? [submenu.width, submenu.height, submenu.top] : []),
        ...(child ? [child.width, child.height, child.top] : []),
        horizontalPadding,
    ];
    if (!values.every(Number.isFinite) ||
        horizontalPadding < 0 ||
        menu.width <= 0 ||
        menu.height <= 0 ||
        menu.width > 2000 ||
        menu.height > 2000 ||
        (overlay &&
            (overlay.width <= 0 ||
                overlay.height <= 0 ||
                overlay.width > 2000 ||
                overlay.height > 2000 ||
                overlay.bottomInset < 0 ||
                overlay.bottomInset >= menu.height)) ||
        (submenu &&
            (submenu.width <= 0 ||
                submenu.height <= 0 ||
                submenu.width > 2000 ||
                submenu.height > 2000)) ||
        (child && (child.width <= 0 || child.height <= 0 || child.width > 2000 || child.height > 2000))) {
        throw new TypeError('Invalid menu geometry');
    }
    const padding = 16;
    const clamp = (value, min, max) => Math.max(min, Math.min(value, Math.max(min, max)));
    const x = clamp(align === 'start' ? anchor.x - 4 : anchor.x + anchor.width - menu.width, area.x + horizontalPadding, area.x + area.width - menu.width - horizontalPadding);
    const y = clamp(direction === 'up' ? anchor.y - menu.height - 4 : anchor.y + anchor.height + 4, area.y + padding, area.y + area.height - menu.height - padding);
    const overlayPosition = overlay
        ? {
            x: clamp(x + (menu.width - overlay.width) / 2, area.x + horizontalPadding, area.x + area.width - overlay.width - horizontalPadding),
            y: clamp(y + menu.height - overlay.height - overlay.bottomInset, area.y + padding, area.y + area.height - overlay.height - padding),
        }
        : undefined;
    const parentX = overlayPosition?.x ?? x;
    const parentY = overlayPosition?.y ?? y;
    const parentWidth = overlay?.width ?? menu.width;
    const subX = submenu && parentX + parentWidth + submenu.width + padding > area.x + area.width
        ? parentX - submenu.width + 4
        : parentX + parentWidth - 4;
    const subY = submenu
        ? clamp(parentY + submenu.top, area.y + padding, area.y + area.height - submenu.height - padding)
        : parentY;
    // A side menu of the side menu keeps cascading the way the first one went, turns when that side
    // has no room, and stays on the display (over its parent) when neither side has.
    let childX = subX;
    let childY = subY;
    if (submenu && child) {
        const rightX = subX + submenu.width - 4;
        const leftX = subX - child.width + 4;
        const fitsRight = rightX + child.width + padding <= area.x + area.width;
        const fitsLeft = leftX - padding >= area.x;
        const preferred = subX < x ? (fitsLeft ? leftX : rightX) : fitsRight ? rightX : leftX;
        childX = clamp(preferred, area.x + horizontalPadding, area.x + area.width - child.width - horizontalPadding);
        childY = clamp(subY + child.top, area.y + padding, area.y + area.height - child.height - padding);
    }
    const boxes = [
        { x, y, width: menu.width, height: menu.height },
        ...(overlay && overlayPosition
            ? [{ ...overlayPosition, width: overlay.width, height: overlay.height }]
            : []),
        ...(submenu ? [{ x: subX, y: subY, width: submenu.width, height: submenu.height }] : []),
        ...(submenu && child
            ? [{ x: childX, y: childY, width: child.width, height: child.height }]
            : []),
    ];
    const menuLeft = Math.min(...boxes.map((box) => box.x));
    const menuRight = Math.max(...boxes.map((box) => box.x + box.width));
    // Preserve the full shadow wherever it fits, trimming only at a display edge.
    const left = menuLeft - Math.min(padding, Math.max(horizontalPadding, menuLeft - area.x));
    const top = Math.min(...boxes.map((box) => box.y)) - padding;
    const right = menuRight + Math.min(padding, Math.max(horizontalPadding, area.x + area.width - menuRight));
    const bottom = Math.max(...boxes.map((box) => box.y + box.height)) + padding;
    const originalLeft = Math.floor(left);
    const originalTop = Math.floor(top);
    const width = Math.ceil(right - originalLeft);
    const height = Math.ceil(bottom - originalTop);
    if (width > area.width || height > area.height) {
        throw new TypeError('Menu exceeds display work area');
    }
    // If neither side fits beside the anchor, translate the whole pair. Preserve
    // its internal geometry so the submenu does not overlap the main menu.
    const bounds = {
        x: clamp(originalLeft, area.x, area.x + area.width - width),
        y: clamp(originalTop, area.y, area.y + area.height - height),
        width,
        height,
    };
    return {
        bounds,
        layout: {
            width: bounds.width,
            height: bounds.height,
            menu: { x: x - originalLeft, y: y - originalTop },
            ...(overlayPosition
                ? { overlay: { x: overlayPosition.x - originalLeft, y: overlayPosition.y - originalTop } }
                : {}),
            ...(submenu
                ? {
                    submenu: {
                        x: subX - originalLeft,
                        y: subY - originalTop,
                        ...(child ? { child: { x: childX - originalLeft, y: childY - originalTop } } : {}),
                    },
                }
                : {}),
        },
    };
}
/**
 * Places a menu whose height animates from `fromHeight` to `measurement.menu.height`. The window
 * covers the menu and its side menus at both heights; the layout positions are for the final
 * height. Without a `fromHeight` (or with the same height) it is {@link positionModelMenu}.
 */
export function positionResizingModelMenu(anchor, direction, align, measurement, fromHeight, area, horizontalPadding) {
    const target = positionModelMenu(anchor, direction, align, measurement, area, horizontalPadding);
    if (fromHeight === undefined || fromHeight === measurement.menu.height)
        return target;
    const from = positionModelMenu(anchor, direction, align, { ...measurement, menu: { width: measurement.menu.width, height: fromHeight } }, area, horizontalPadding);
    const x = Math.min(target.bounds.x, from.bounds.x);
    const y = Math.min(target.bounds.y, from.bounds.y);
    const width = Math.max(target.bounds.x + target.bounds.width, from.bounds.x + from.bounds.width) - x;
    const height = Math.max(target.bounds.y + target.bounds.height, from.bounds.y + from.bounds.height) - y;
    if (width > area.width || height > area.height) {
        throw new TypeError('Menu exceeds display work area');
    }
    const dx = target.bounds.x - x;
    const dy = target.bounds.y - y;
    const shift = (point) => ({ x: point.x + dx, y: point.y + dy });
    const { overlay, submenu } = target.layout;
    return {
        bounds: { x, y, width, height },
        layout: {
            width,
            height,
            menu: shift(target.layout.menu),
            ...(overlay ? { overlay: shift(overlay) } : {}),
            ...(submenu
                ? {
                    submenu: {
                        ...shift(submenu),
                        ...(submenu.child ? { child: shift(submenu.child) } : {}),
                    },
                }
                : {}),
        },
    };
}
const CARD_LABEL_TONES = ['accent', 'max', 'muted'];
const CARD_PROVIDER_DEFAULT_EFFORT = 'default';
/**
 * The composer card: a described model, an optional label and either effort stops or thinking.
 * Text and stops are limited only by the presentation size, like row labels and effort options,
 * so any card the owner builds from the catalog is accepted.
 */
export function isValidModelMenuCard(card) {
    if (!card ||
        typeof card !== 'object' ||
        typeof card.key !== 'string' ||
        typeof card.modelName !== 'string')
        return false;
    if (card.label !== undefined &&
        (!card.label ||
            typeof card.label.text !== 'string' ||
            !CARD_LABEL_TONES.includes(card.label.tone)))
        return false;
    if (card.thinking !== undefined &&
        (!card.key || !card.thinking || typeof card.thinking.checked !== 'boolean'))
        return false;
    const effort = card.effort;
    if (effort === undefined)
        return true;
    return Boolean(card.key &&
        effort &&
        Array.isArray(effort.stops) &&
        // Offer at least two choices, counting the provider default when supported.
        effort.stops.length >= (effort.defaultSlot === true ? 1 : 2) &&
        effort.stops.every((stop) => typeof stop === 'string' && stop.length > 0) &&
        new Set(effort.stops).size === effort.stops.length &&
        typeof effort.defaultSlot === 'boolean' &&
        (effort.stops.includes(effort.value) ||
            (effort.defaultSlot && effort.value === CARD_PROVIDER_DEFAULT_EFFORT)) &&
        typeof effort.disabled === 'boolean' &&
        Number.isSafeInteger(effort.revision) &&
        effort.revision >= 0);
}
/**
 * The presentation the popup renders: an advisor row it cannot render is left out, and a card it
 * cannot render is left out, so the menu opens without the advisor row, or as the list, instead of
 * refusing to open. Either part on a non-model menu stays for the validation to refuse.
 */
export function withRenderableModelMenu(data) {
    if (!data || typeof data !== 'object' || data.kind !== undefined)
        return data;
    const dropAdvisor = data.advisor !== undefined && !isValidModelMenuAdvisor(data.advisor);
    const dropCard = data.card !== undefined && !isValidModelMenuCard(data.card);
    if (!dropAdvisor && !dropCard)
        return data;
    const renderable = { ...data };
    if (dropAdvisor)
        delete renderable.advisor;
    if (dropCard)
        delete renderable.card;
    return renderable;
}
export function isModelMenuActionAllowed(data, action) {
    if (!action || typeof action !== 'object')
        return false;
    if (isAdvisorAction(action))
        return isAdvisorActionAllowed(data, action);
    if (action.type === 'upgrade' && isAdvisorUpgradeAllowed(data, action.key))
        return true;
    if (action.type === 'tab-menu-hover')
        return data.kind === 'panel-tabs' && typeof action.inside === 'boolean';
    if (action.type === 'card-list') {
        if (data.kind !== undefined || !data.card)
            return false;
        // Only a card with an Advisor row can open the advisor list.
        return action.list === 'advisor'
            ? Boolean(data.advisor)
            : action.list === 'models' || action.list === null;
    }
    if (action.type === 'auto')
        return Boolean(data.auto);
    if (action.type === 'source')
        return Boolean(data.source && !data.source.disabled);
    if (action.type === 'reorganize')
        return data.panelAdd?.mode === 'menu';
    if (action.type === 'reorganize-done')
        return data.panelAdd?.mode === 'edit';
    if (action.type === 'card-effort' || action.type === 'card-thinking') {
        // Card actions only name the model the current card describes.
        const card = data.card;
        if (!card?.key || data.kind !== undefined || action.key !== card.key)
            return false;
        if (action.type === 'card-thinking')
            return Boolean(card.thinking);
        if (!card.effort || card.effort.disabled)
            return false;
        return (typeof action.value === 'string' &&
            (card.effort.stops.includes(action.value) ||
                (card.effort.defaultSlot && action.value === CARD_PROVIDER_DEFAULT_EFFORT)));
    }
    const row = data.rows.find((row) => row.key === ('key' in action ? action.key : undefined));
    if (!row || row.disabled)
        return false;
    switch (action.type) {
        case 'close-tab':
            return data.kind === 'panel-tabs';
        case 'reorder-tab':
            return (data.kind === 'panel-tabs' &&
                action.key !== action.overKey &&
                data.rows.some((candidate) => candidate.key === action.overKey && !candidate.disabled));
        case 'select':
            return !row.zoom && data.panelAdd?.mode !== 'edit' && row.access !== 'upgrade';
        case 'upgrade':
            return data.kind === undefined && row.access === 'upgrade';
        case 'toggle-pin':
            return data.panelAdd?.mode === 'edit';
        case 'zoom':
            if (data.kind !== 'browser-more' || !row.zoom)
                return false;
            return ((action.operation === 'in' && row.zoom.factor < 3) ||
                (action.operation === 'out' && row.zoom.factor > 0.25) ||
                (action.operation === 'reset' && Math.round(row.zoom.factor * 100) !== 100));
        case 'thinking':
            return typeof row.thinking === 'boolean';
        case 'context':
            return Boolean(row.context && !row.context.disabled && row.context.options.includes(action.value));
        case 'effort':
            return Boolean(row.effort && !row.effort.disabled && row.effort.options.includes(action.value));
        default:
            return false;
    }
}
