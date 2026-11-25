import { SidebarSectionError, } from '../../service/sidebar-sections/index.js';
const UNAVAILABLE = {
    code: 503,
    key: 'SIDEBAR_SECTIONS_UNAVAILABLE',
    message: 'Sidebar sections are unavailable',
};
export function mountSidebarSectionsRoutes(app, deps) {
    const sections = () => deps.sections;
    app.get('/mavis/api/preferences/sidebar-sections', (c) => {
        const service = sections();
        if (!service)
            return c.json(UNAVAILABLE, 503);
        // `imported` tells the renderer whether the one-time localStorage import
        // still has to run for this data directory.
        return c.json({ ...service.read(), imported: service.isImported() });
    });
    app.post('/mavis/api/preferences/sidebar-sections/create', async (c) => {
        const service = sections();
        if (!service)
            return c.json(UNAVAILABLE, 503);
        return handle(c, async () => {
            const body = await readJsonObject(c.req.raw);
            return service.create({
                name: readString(body.name) ?? '',
                ...(readString(body.id) !== undefined ? { id: readString(body.id) } : {}),
                ...readTarget(body.target),
            });
        });
    });
    app.post('/mavis/api/preferences/sidebar-sections/update', async (c) => {
        const service = sections();
        if (!service)
            return c.json(UNAVAILABLE, 503);
        return handle(c, async () => {
            const body = await readJsonObject(c.req.raw);
            return service.update({
                section: readString(body.section) ?? '',
                ...(typeof body.name === 'string' ? { name: body.name } : {}),
                ...(typeof body.collapsed === 'boolean' ? { collapsed: body.collapsed } : {}),
            });
        });
    });
    app.post('/mavis/api/preferences/sidebar-sections/delete', async (c) => {
        const service = sections();
        if (!service)
            return c.json(UNAVAILABLE, 503);
        return handle(c, async () => {
            const body = await readJsonObject(c.req.raw);
            return service.remove({ section: readString(body.section) ?? '' });
        });
    });
    app.post('/mavis/api/preferences/sidebar-sections/move', async (c) => {
        const service = sections();
        if (!service)
            return c.json(UNAVAILABLE, 503);
        return handle(c, async () => {
            const body = await readJsonObject(c.req.raw);
            return service.move({
                item_type: readItemType(body.item_type),
                id: readString(body.id) ?? '',
                section: readString(body.section) ?? null,
                ...(typeof body.position === 'number' ? { position: body.position } : {}),
            });
        });
    });
    app.post('/mavis/api/preferences/sidebar-sections/order', async (c) => {
        const service = sections();
        if (!service)
            return c.json(UNAVAILABLE, 503);
        return handle(c, async () => {
            const body = await readJsonObject(c.req.raw);
            return service.setSessionOrder({
                section: readString(body.section) ?? '',
                session_ids: readStringArray(body.session_ids),
            });
        });
    });
    app.post('/mavis/api/preferences/sidebar-sections/blocks', async (c) => {
        const service = sections();
        if (!service)
            return c.json(UNAVAILABLE, 503);
        return handle(c, async () => {
            const body = await readJsonObject(c.req.raw);
            return service.setBlockOrder({ order: readStringArray(body.order) });
        });
    });
    /**
     * The 置顶 / 分区 bookkeeping the renderer used to do in its own store: a pin
     * records the section the item left and drops the membership, an unpin puts
     * it back. The Runtime owns the rule so `sidebar_pin` applies the same one.
     */
    app.post('/mavis/api/preferences/sidebar-sections/pin', async (c) => {
        const service = sections();
        if (!service)
            return c.json(UNAVAILABLE, 503);
        return handle(c, async () => {
            const body = await readJsonObject(c.req.raw);
            if (body.rollback === true) {
                return service.rollbackPin({
                    item_type: readItemType(body.item_type),
                    id: readString(body.id) ?? '',
                    section_before: readString(body.section_before) ?? null,
                });
            }
            return service.commitPin({
                item_type: readItemType(body.item_type),
                id: readString(body.id) ?? '',
                pinned: body.pinned === true,
                // Left out entirely when the caller sends no `section_before`: that is
                // "I do not know", which keeps an already recorded restore target.
                ...('section_before' in body
                    ? { section_before: readString(body.section_before) ?? null }
                    : {}),
                ...(typeof body.restore === 'boolean' ? { restore: body.restore } : {}),
            });
        });
    });
    /** One-time import of the renderer's localStorage copy; merge, never replace. */
    app.post('/mavis/api/preferences/sidebar-sections/import', async (c) => {
        const service = sections();
        if (!service)
            return c.json(UNAVAILABLE, 503);
        return handle(c, async () => {
            const body = await readJsonObject(c.req.raw);
            return service.importLocalState(body.state ?? body);
        });
    });
}
async function handle(c, run) {
    try {
        return c.json((await run()));
    }
    catch (error) {
        if (error instanceof SidebarSectionError) {
            return c.json({ code: statusFor(error.code), key: error.code, message: error.message }, statusFor(error.code));
        }
        throw error;
    }
}
function statusFor(code) {
    switch (code) {
        case 'NOT_FOUND':
            return 404;
        case 'INVALID_ARGUMENT':
            return 400;
        case 'CONFLICT':
            return 409;
        default:
            return 500;
    }
}
function readItemType(value) {
    return value === 'project' ? 'project' : 'session';
}
function readString(value) {
    return typeof value === 'string' && value.trim() ? value : undefined;
}
function readStringArray(value) {
    return Array.isArray(value)
        ? value.filter((entry) => typeof entry === 'string')
        : [];
}
function readTarget(value) {
    if (!value || typeof value !== 'object')
        return {};
    const raw = value;
    const sessionId = readString(raw.sessionId);
    if (sessionId)
        return { target: { sessionId } };
    const projectKey = readString(raw.projectKey);
    return projectKey ? { target: { projectKey } } : {};
}
async function readJsonObject(request) {
    try {
        const value = await request.json();
        return value && typeof value === 'object' && !Array.isArray(value)
            ? value
            : {};
    }
    catch {
        return {};
    }
}
//# sourceMappingURL=sidebar-sections.js.map