// Compose the GitHub release notes for a desktop release from
// apps/electron/CHANGELOG.md.
//
// The `Desktop release` workflow publishes exactly the section for the tag's
// version, so the release page and the repository changelog cannot drift, and a
// version without a section fails the build instead of publishing empty notes.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const desktopChangelogPath = path.join(root, 'apps', 'electron', 'CHANGELOG.md');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Return the body of the `## <version>` section, without the heading.
 *
 * The version must not be a prefix of a longer token, so `3.1.14` never selects
 * `3.1.140` or `3.1.14-preview.1`. The body runs until the next level-2
 * heading; level-3 headings (`### Added`, …) are part of the body.
 */
export function releaseNotesFromChangelog(markdown, version) {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n');
  const heading = new RegExp(`^##\\s+${escapeRegExp(version)}(?![\\w.-])`, 'u');
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) {
    throw new Error(`apps/electron/CHANGELOG.md has no "## ${version}" section; add one before tagging.`);
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  const body = lines.slice(start + 1, end).join('\n').trim();
  if (!body) {
    throw new Error(`the "## ${version}" section in apps/electron/CHANGELOG.md is empty.`);
  }
  return body;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, output] = process.argv.slice(2);
  if (!version || !output) {
    console.error('usage: node scripts/desktop-release-notes.mjs <version> <output-file>');
    process.exit(1);
  }
  const notes = releaseNotesFromChangelog(readFileSync(desktopChangelogPath, 'utf8'), version);
  writeFileSync(output, `${notes}\n`, 'utf8');
  console.log(`[release-notes] wrote ${output}`);
}
