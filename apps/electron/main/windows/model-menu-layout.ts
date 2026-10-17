export function positionModelMenu(anchor, direction, align, measurement, area) {
    const { menu, submenu } = measurement;
    const values = [
        ...Object.values(anchor),
        ...Object.values(menu),
        ...Object.values(submenu ?? {}),
    ];
    if (!values.every(Number.isFinite) ||
        menu.width <= 0 ||
        menu.height <= 0 ||
        menu.width > 2000 ||
        menu.height > 2000 ||
        (submenu &&
            (submenu.width <= 0 || submenu.height <= 0 || submenu.width > 2000 || submenu.height > 2000))) {
        throw new TypeError('Invalid menu geometry');
    }
    const padding = 16;
    const clamp = (value, min, max) => Math.max(min, Math.min(value, Math.max(min, max)));
    const x = clamp(align === 'start' ? anchor.x - 4 : anchor.x + anchor.width - menu.width, area.x + padding, area.x + area.width - menu.width - padding);
    const y = clamp(direction === 'up' ? anchor.y - menu.height - 4 : anchor.y + anchor.height + 4, area.y + padding, area.y + area.height - menu.height - padding);
    const subX = submenu && x + menu.width + submenu.width + padding > area.x + area.width
        ? x - submenu.width + 4
        : x + menu.width - 4;
    const subY = submenu
        ? clamp(y + submenu.top, area.y + padding, area.y + area.height - submenu.height - padding)
        : y;
    const left = Math.min(x, submenu ? subX : x) - padding;
    const top = Math.min(y, subY) - padding;
    const right = Math.max(x + menu.width, submenu ? subX + submenu.width : x + menu.width) + padding;
    const bottom = Math.max(y + menu.height, submenu ? subY + submenu.height : y + menu.height) + padding;
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
            ...(submenu ? { submenu: { x: subX - originalLeft, y: subY - originalTop } } : {}),
        },
    };
}
export function isModelMenuActionAllowed(data, action) {
    if (!action || typeof action !== 'object')
        return false;
    if (action.type === 'auto')
        return Boolean(data.auto);
    if (action.type === 'source')
        return Boolean(data.source && !data.source.disabled);
    const row = data.rows.find((row) => row.key === ('key' in action ? action.key : undefined));
    if (!row || row.disabled)
        return false;
    switch (action.type) {
        case 'select':
            return !row.zoom;
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
