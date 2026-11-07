/**
 * Read access to persisted AgentTeam plan records (`<dataDir>/plans/<plan_id>/plan.json`),
 * used by `hasActiveLocalTeamOwner` in `api.ts`.
 */
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
const PLAN_ID_PATTERN = /^plan_[0-9a-f]{8}$/u;
export class LocalTeamPlanStore {
    plansDir;
    constructor(dataDir) {
        this.plansDir = join(dataDir, 'plans');
    }
    async list() {
        await mkdir(this.plansDir, { recursive: true });
        let entries;
        try {
            entries = await readdir(this.plansDir, { withFileTypes: true });
        }
        catch {
            return [];
        }
        const records = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || !PLAN_ID_PATTERN.test(entry.name))
                continue;
            const record = await this.read(entry.name);
            if (record)
                records.push(record);
        }
        return records.sort((a, b) => b.state.updated_at - a.state.updated_at);
    }
    async read(planId) {
        try {
            const parsed = JSON.parse(await readFile(this.recordPath(planId), 'utf-8'));
            if (!parsed || typeof parsed !== 'object')
                return undefined;
            const record = parsed;
            // Normalize legacy `phase: "completed"` — old engine wrote `phase: "completed"`
            // but phase should only be a cycle stage (determining/producing/verifying/evaluating).
            // Plan completion is represented by `status: "completed"`, not phase.
            if (record.state.phase === 'completed' && record.state.status === 'completed') {
                record.state.phase = 'evaluating';
            }
            return record;
        }
        catch {
            return undefined;
        }
    }
    planDir(planId) {
        if (!PLAN_ID_PATTERN.test(planId))
            throw new Error(`Invalid planId: ${planId}`);
        return containedPath(resolve(this.plansDir), planId);
    }
    recordPath(planId) {
        return join(this.planDir(planId), 'plan.json');
    }
}
function containedPath(baseDir, child) {
    const resolvedBase = resolve(baseDir);
    const resolvedChild = resolve(resolvedBase, child);
    if (!isPathInside(resolvedBase, resolvedChild))
        throw new Error(`Invalid path segment: ${child}`);
    return resolvedChild;
}
function isPathInside(baseDir, candidate) {
    const rel = relative(resolve(baseDir), resolve(candidate));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
//# sourceMappingURL=plan-records.js.map