// hooks/register.tsx
import type { Register } from '@minimax/mcode-plugin-extension';
import { Box, Button } from '@minimax/mcode-plugin-extension/ui';

export { state } from './state';

export const register: Register = (on) => {
  on('ui.render', { site: 'above-prompt' }, async (ctx, e, next) =>
    Box({
      direction: 'column',
      gap: '1',
      children: [
        Box({
          direction: 'row',
          gap: '2',
          children: [
            Button({
              key: 'board',
              label: 'Jira 看板',
              icon: 'kanban',
              onPress: async () => {
                // jira 是本包 jira.mcp.json 声明的 server
                const { content } = await ctx.mcp.call('jira', 'search', {
                  jql: 'assignee = currentUser()',
                });
                await ctx.state.set('n', (ctx.state.get('n') ?? 0) + 1);
                await ctx.ui.toast(`${content.length} 个 Issue`);
              },
            }),
            Button({
              key: 'new-issue',
              label: '新建 Issue',
              icon: 'plus',
              onPress: async () => {
                await ctx.prompt.fill({ text: '新建 Jira Issue：' });
              },
            }),
          ],
        }),
        await next(),
      ],
    }),
  );
  on('turn.complete', (ctx) => ctx.ui.invalidate());
};
