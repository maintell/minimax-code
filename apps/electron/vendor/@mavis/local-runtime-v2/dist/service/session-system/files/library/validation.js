import path from 'node:path';
import { ARTIFACT_EXTENSIONS } from '../repo/artifact-catalog.js';
import { ArtifactCatalogError } from './errors.js';
const COLORS = new Set(['blue', 'purple', 'pink', 'green', 'orange']);
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
export function spaceChanges(input, current) {
    const name = input.name.trim();
    if (!name || name.length > 80)
        throw new ArtifactCatalogError('Space name must contain 1–80 characters');
    const base = current ?? { color: 'blue', objective: '' };
    const color = input.color ?? base.color;
    if (!COLORS.has(color))
        throw new ArtifactCatalogError('Invalid space color');
    const objective = input.objective ?? base.objective;
    if (objective.length > 10000)
        throw new ArtifactCatalogError('Brief fields exceed 10000 characters');
    return { name, color, objective, ...worklineChanges(input, current) };
}
function worklineChanges(input, current) {
    const base = current ?? { context: [], projects: [] };
    const context = validateContext(input.context ?? base.context);
    const projects = validateProjects(input.projects ?? base.projects);
    return { context, projects };
}
function validateContext(context) {
    if (!Array.isArray(context) ||
        context.some((item) => !item.id || !item.name || !item.path || !['file', 'folder'].includes(item.kind)))
        throw new ArtifactCatalogError('Invalid workline context');
    return context;
}
function validateProjects(projects) {
    if (!Array.isArray(projects) || projects.some((item) => typeof item !== 'string' || !item.trim()))
        throw new ArtifactCatalogError('Invalid workline projects');
    return projects;
}
function importName(input) {
    const name = input.trim();
    if (!name ||
        name.length > 255 ||
        name === '.' ||
        name === '..' ||
        /[<>:"/\\|?*\x00-\x1f]/u.test(name) ||
        /[. ]$/u.test(name) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name))
        throw new ArtifactCatalogError('Invalid file name');
    return name;
}
export function importContents(input) {
    const name = importName(input.name);
    if (input.contentBase64.length > Math.ceil(MAX_IMPORT_BYTES / 3) * 4 ||
        /[^A-Za-z0-9+/=]/u.test(input.contentBase64))
        throw new ArtifactCatalogError('File must be valid base64 and no larger than 20 MiB');
    const data = Buffer.from(input.contentBase64, 'base64');
    if (data.toString('base64') !== input.contentBase64)
        throw new ArtifactCatalogError('Invalid base64 content');
    if (data.length > MAX_IMPORT_BYTES)
        throw new ArtifactCatalogError('File exceeds 20 MiB');
    const extension = path.extname(name).slice(1).toLowerCase();
    const category = Object.entries(ARTIFACT_EXTENSIONS).find(([, extensions]) => extensions.includes(extension))?.[0] ?? 'other';
    return { name, data, category };
}
//# sourceMappingURL=validation.js.map