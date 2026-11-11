/**
 * Public update channel: this repository's GitHub Releases.
 *
 * This distribution is packaged by `.github/workflows/desktop-release.yml`, and
 * every `desktop-v<version>` release carries the NSIS installer, its blockmap
 * and the electron-updater channel file `latest.yml`. Public builds therefore
 * read the channel file from that release instead of the upstream CDN, which
 * serves the internal MiniMax builds.
 *
 * Discovery walks the repository's release Atom feed: it needs no GitHub API
 * token and is not subject to the API rate limit. `releases/latest` cannot be
 * used because the same repository also publishes CLI releases (`v*`) whose
 * artifacts do not include `latest.yml`, which would make the check 404.
 */
import { net } from "electron";
import { getCategoryLogger } from "../../utils/logger";
import releaseChannel from "./release-channel.json";
const logger = getCategoryLogger('update');
/** How long one resolution is reused by later checks in this process. */
export const RELEASE_FEED_TTL_MS = 10 * 60 * 1000;
export interface DesktopRelease {
    repository: string;
    tag: string;
    version: string;
    feedUrl: string;
}
interface DesktopReleaseTag {
    tag: string;
    version: string;
    parts: number[];
}
export function getReleaseRepository() {
    return releaseChannel.repository;
}
export function releaseAtomUrl(repository: string) {
    return `https://github.com/${repository}/releases.atom`;
}
/** Generic-provider feed URL for one release; `latest.yml` resolves next to the assets. */
export function releaseFeedUrl(repository: string, tag: string) {
    return `https://github.com/${repository}/releases/download/${tag}`;
}
function compareParts(a: number[], b: number[]) {
    for (let index = 0; index < 3; index += 1) {
        if (a[index] !== b[index])
            return a[index] - b[index];
    }
    return 0;
}
/**
 * Every stable `desktop-v<major>.<minor>.<patch>` tag in a release Atom feed,
 * newest first. Pre-release tags (`-preview.N`, `-test.N`) are skipped, which
 * matches the public channel's `allowPrerelease = false`.
 */
export function parseDesktopReleaseTags(atom: string): DesktopReleaseTag[] {
    const found = new Map<string, DesktopReleaseTag>();
    const pattern = /\/releases\/tag\/([^"<\s]+)/g;
    let match = pattern.exec(atom);
    while (match !== null) {
        const tag = match[1];
        if (tag.startsWith(releaseChannel.tagPrefix)) {
            const version = tag.slice(releaseChannel.tagPrefix.length);
            if (/^\d+\.\d+\.\d+$/.test(version)) {
                found.set(tag, { tag, version, parts: version.split('.').map(Number) });
            }
        }
        match = pattern.exec(atom);
    }
    return [...found.values()].sort((a, b) => compareParts(b.parts, a.parts));
}
/** Resolve the newest published desktop release of the configured repository. */
export async function resolveDesktopRelease(): Promise<DesktopRelease> {
    const repository = getReleaseRepository();
    const url = releaseAtomUrl(repository);
    const response = await net.fetch(url, {
        headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            Pragma: 'no-cache',
        },
    });
    if (!response.ok)
        throw new Error(`UPDATE_FEED_HTTP_${response.status}: ${url}`);
    const latest = parseDesktopReleaseTags(await response.text())[0];
    if (!latest)
        throw new Error(`UPDATE_FEED_EMPTY: no ${releaseChannel.tagPrefix}* release in ${url}`);
    logger.info(`[Updater] 最新发布版本: ${latest.tag} (${repository})`);
    return {
        repository,
        tag: latest.tag,
        version: latest.version,
        feedUrl: releaseFeedUrl(repository, latest.tag),
    };
}
