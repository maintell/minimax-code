import { desc } from 'drizzle-orm';
import { bunnySpaces } from '../../../infra/db/schema/bunny-store.js';
import { spaceDisplayName } from '../../session-system/index.js';
function workline(space) {
    return {
        id: space.id,
        name: spaceDisplayName(space),
        goal: space.objective,
        system: space.id === 'default',
        projects: space.projects,
        context: space.context,
        createdAt: space.createdAtMs,
        updatedAt: space.updatedAtMs,
    };
}
/** Spaces live in the Bunny database only. */
export async function readBunnyWorklines(db) {
    return db
        .select()
        .from(bunnySpaces)
        .orderBy(desc(bunnySpaces.createdAtMs), bunnySpaces.id)
        .all()
        .map(workline);
}
/** Bunny and mavis space share the artifact catalog's space owner. */
export class BunnyWorklineService {
    library;
    changed;
    constructor(library, changed) {
        this.library = library;
        this.changed = changed;
    }
    async list() {
        return this.library.summary().spaces.map(workline);
    }
    directory(id) {
        return this.library.directory(id);
    }
    sessionSpace(sessionId) {
        return this.library.sessionSpace(sessionId);
    }
    async get(id) {
        const detail = this.library.getSpace(id);
        const context = this.library.readContext(id);
        return {
            space: workline(detail.space),
            directory: context.directory,
            context: { summary: context.summary, revision: context.revision, source: context.source },
            sessions: detail.sessions,
        };
    }
    /** The space's context.md: `<goal>` mirrors the space goal, `<summary>` is Bunny's. */
    readContext(id) {
        return this.library.readContext(id);
    }
    writeContext(id, input) {
        return this.library.writeContext({ id, ...input });
    }
    async create(input) {
        return this.publish((await this.library.saveSpace({ ...input, objective: input.goal })).space);
    }
    async update(id, input) {
        const current = this.library.getSpace(id).space;
        const saved = await this.library.saveSpace({
            ...input,
            id,
            name: input.name ?? current.name,
            objective: input.goal,
        });
        return this.publish(saved.space);
    }
    async linkSession(id, sessionId) {
        this.library.linkSession({ id, sessionId });
    }
    publish(space) {
        const value = workline(space);
        try {
            this.changed(value);
        }
        catch {
            /* durable state already committed */
        }
        return value;
    }
}
//# sourceMappingURL=workline.service.js.map