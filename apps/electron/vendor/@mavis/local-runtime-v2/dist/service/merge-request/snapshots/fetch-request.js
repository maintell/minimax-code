import { branchKey } from '../code-host/adapter.js';
import { mergeRequestKey, projectKey } from '../code-host/urls.js';
/** Collects what one round asks each host for. */
export class FetchRequest {
    hosts = new Map();
    add(ref, detail) {
        const project = this.project(ref.platform, ref.host, ref.projectPath);
        project.numbers.add(ref.number);
        if (detail)
            project.detailNumbers.add(ref.number);
    }
    addBranch(repo) {
        if (repo.branch)
            this.project(repo.platform, repo.host, repo.projectPath).branches.add(repo.branch);
    }
    isEmpty() {
        return this.hosts.size === 0;
    }
    /** Every merge request asked about by number. */
    refs() {
        return this.collect((ref, project) => [...project.numbers].map((number) => ({ ...ref, number })));
    }
    /** The merge requests whose jobs and threads are asked for. */
    detailRefs() {
        return this.collect((ref, project) => [...project.detailNumbers].map((number) => ({ ...ref, number })));
    }
    /** branchKey of every branch asked about. */
    branchKeys() {
        return this.collect((ref, project) => [...project.branches].map((branch) => branchKey(projectKey(ref.platform, ref.host, ref.projectPath), branch)));
    }
    collect(pick) {
        const items = [];
        for (const [host, entry] of this.hosts) {
            for (const project of entry.projects.values()) {
                items.push(...pick({ platform: entry.platform, host, projectPath: project.projectPath }, project));
            }
        }
        return items;
    }
    entries() {
        return [...this.hosts].map(([host, entry]) => ({
            host,
            platform: entry.platform,
            queries: [...entry.projects.values()].map((project) => ({
                projectPath: project.projectPath,
                numbers: [...project.numbers],
                detailNumbers: [...project.detailNumbers],
                branches: [...project.branches],
            })),
        }));
    }
    project(platform, host, projectPath) {
        let entry = this.hosts.get(host);
        if (!entry) {
            entry = { platform, projects: new Map() };
            this.hosts.set(host, entry);
        }
        const key = projectPath.toLowerCase();
        let project = entry.projects.get(key);
        if (!project) {
            project = { projectPath, numbers: new Set(), detailNumbers: new Set(), branches: new Set() };
            entry.projects.set(key, project);
        }
        return project;
    }
}
export function sameProject(ref, repo) {
    return (projectKey(ref.platform, ref.host, ref.projectPath) ===
        projectKey(repo.platform, repo.host, repo.projectPath));
}
/** What a panel read asks for: the links, the current branch, and the details of expanded cards. */
export function panelRequest(links, repo, detailRefs) {
    const detailKeys = new Set(detailRefs.map(mergeRequestKey));
    const request = new FetchRequest();
    for (const link of links)
        request.add(link.ref, detailKeys.has(mergeRequestKey(link.ref)));
    if (repo) {
        request.addBranch(repo);
        // The current branch's merge request is not stored; the client knows it from an earlier answer.
        for (const ref of detailRefs)
            if (sameProject(ref, repo))
                request.add(ref, true);
    }
    return request;
}
/** The hosts a Session's merge requests and repository live on. */
export function hostsOf(links, repo) {
    const hosts = new Map();
    if (repo)
        hosts.set(repo.host, repo.platform);
    for (const link of links)
        hosts.set(link.ref.host, link.ref.platform);
    return hosts;
}
//# sourceMappingURL=fetch-request.js.map