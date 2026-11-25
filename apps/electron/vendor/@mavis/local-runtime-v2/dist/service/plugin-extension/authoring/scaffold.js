import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeEditorTypes } from './editor-types.js';
/** 1×1 transparent PNG: the reader requires a package icon; authors replace it. */
const ICON_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const RETIRED_RESTRICTIONS = [
    {
        phrases: ['from `onPress` only', 'not from a drawing', 'anything but a drawing'],
        removedErrorCodes: [
            'PROMPT_FILL_NOT_FROM_GESTURE',
            'PROMPT_FILL_IN_RENDER',
            'PROMPT_SUGGEST_IN_RENDER',
            'PROMPT_READ_NOT_FROM_GESTURE',
            'AGENT_SPAWN_IN_RENDER',
        ],
    },
    {
        phrases: [
            'Drawings cannot ask',
            'an ask from a drawing fails with',
            'PERMISSION_REQUIRED without showing a card',
        ],
    },
];
const RETIRED_PHRASES = RETIRED_RESTRICTIONS.flatMap(({ phrases }) => phrases);
const CONSISTENCY_SOURCE_FILE = fileURLToPath(import.meta.url);
function filesUnder(root) {
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
        const file = path.join(root, entry.name);
        if (entry.isDirectory())
            return filesUnder(file);
        return [file];
    });
}
function authorDocFiles(root) {
    return filesUnder(root)
        .filter((file) => path.basename(file) === 'SKILL.md' ||
        (file.includes(`${path.sep}references${path.sep}`) && file.endsWith('.md')) ||
        (file.includes(`${path.sep}examples${path.sep}`) && file.endsWith('.tsx')))
        .sort();
}
function productionSource(root) {
    return filesUnder(root)
        .filter((file) => !file.endsWith('.test.ts') && file !== CONSISTENCY_SOURCE_FILE)
        .sort()
        .map((file) => readFileSync(file, 'utf8'))
        .join('\n');
}
/** @public exercised directly by the colocated unit suite. */
export function checkAuthorDocs(root) {
    const findings = [];
    for (const file of authorDocFiles(root)) {
        const lines = readFileSync(file, 'utf8').split(/\r?\n/u);
        for (const phrase of RETIRED_PHRASES) {
            const line = lines.findIndex((text) => text.includes(phrase));
            if (line !== -1)
                findings.push({ file, line: line + 1, phrase });
        }
    }
    return findings;
}
/** @public exercised directly by the colocated unit suite. */
export function missingRetiredCodes(srcRoots) {
    const source = srcRoots.map((root) => productionSource(root)).join('\n');
    return RETIRED_RESTRICTIONS.flatMap((restriction) => restriction.removedErrorCodes ?? []).filter((code) => source.includes(code));
}
/**
 * `extension init` (one.md §3, §9): the minimal package, a sample test and editor types. An
 * existing package keeps its sources and author config; only editor types and the exact legacy
 * host-generated root config refresh.
 */
export async function scaffoldExtensionPackage(input) {
    const exists = existsSync(path.join(input.directory, '.minimax-plugin', 'plugin.json'));
    const files = [];
    if (!exists) {
        for (const [relative, content] of Object.entries(templateFiles(input))) {
            const target = path.join(input.directory, ...relative.split('/'));
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, content);
            files.push(relative);
        }
    }
    files.push(...(await writeEditorTypes(input.directory)));
    return { mode: exists ? 'update' : 'create', files };
}
/** Single-quoted JS string literal, the quote style of the skill's examples. */
function singleQuoted(text) {
    return `'${JSON.stringify(text).slice(1, -1).replace(/\\"/gu, '"').replace(/'/gu, "\\'")}'`;
}
/**
 * With the title `Counter`, the hooks files are byte for byte the `counter` example of the
 * extension-creator skill (`assets/skills/extension-creator/examples/`); `scaffold.test.ts` holds
 * them together.
 */
function templateFiles(input) {
    const title = singleQuoted(input.title);
    const draft = singleQuoted(`${input.title}: `);
    return {
        '.minimax-plugin/plugin.json': `${JSON.stringify({
            schemaVersion: 1,
            name: input.pluginId,
            displayName: input.title,
            version: '0.1.0',
            description: `${input.title} extension`,
            author: 'MiniMax Code',
            icon: 'icon.png',
            category: 'Other',
            exampleQueries: [],
            apps: [],
            mcpServers: [],
            skills: [],
            hooks: ['hooks/hooks.json'],
        }, null, 2)}\n`,
        'hooks/hooks.json': `${JSON.stringify({ modules: ['./register.tsx'] }, null, 2)}\n`,
        'hooks/state.ts': `import { defineState } from '@minimax/mcode-plugin-extension';

export const state = defineState({ count: { default: 0 } });

// Gives \`ctx.state\` literal keys and value types in the editor.
declare module '@minimax/mcode-plugin-extension' {
  interface ExtensionStateRegistry {
    readonly spec: typeof state.spec;
  }
}
`,
        'hooks/register.tsx': `import type { Register } from '@minimax/mcode-plugin-extension';
import { Box, Button, Text } from '@minimax/mcode-plugin-extension/ui';

export { state } from './state';

export const register: Register = (on) => {
  // One row of the band above the message box. Every plugin that draws \`above-prompt\` is a layer
  // of the same band: \`await next()\` keeps what the plugins after this one drew.
  on('ui.render', { site: 'above-prompt' }, async (ctx, e, next) =>
    Box({
      direction: 'column',
      gap: '1',
      children: [
        Box({
          direction: 'row',
          gap: '2',
          align: 'center',
          children: [
            Text({ size: 'sm', children: \`Pressed \${ctx.state.get('count')} times\` }),
            // The press redraws the band; the \`key\` lets a quick second press reach the new one.
            Button({
              key: 'counter',
              label: ${title},
              icon: 'plus',
              onPress: async () => {
                await ctx.state.set('count', ctx.state.get('count') + 1);
                await ctx.ui.toast(\`Pressed \${ctx.state.get('count')} times\`);
                await ctx.prompt.fill({ text: ${draft} });
              },
            }),
          ],
        }),
        await next(),
      ],
    }),
  );
};
`,
        'hooks/register.test.tsx': `import { expect, find, mount, press, test } from '@minimax/mcode-plugin-extension/testing';

import { register } from './register';

test('counts presses of the band button and fills the composer draft', async () => {
  const site = await mount({ register, site: 'above-prompt' });
  expect(find(site, { text: 'Pressed 0 times' })).toBeDefined();

  await press(site, { label: ${title} });
  await press(site, { label: ${title} });

  expect(site.state()).toEqual({ count: 2 });
  expect(find(site, { text: 'Pressed 2 times' })).toBeDefined();
  expect(site.effects.map((effect) => effect.type)).toEqual([
    'ui.toast',
    'prompt.fill',
    'ui.toast',
    'prompt.fill',
  ]);
});
`,
        'icon.png': ICON_PNG,
    };
}
//# sourceMappingURL=scaffold.js.map