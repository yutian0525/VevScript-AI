// vitest.config.ts
import { defineConfig, configDefaults } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  // WxtVitest 返回 Promise<vite.PluginOption[]>，vite 支持在 plugins 数组中内联 Promise
  plugins: [WxtVitest()],
  test: {
    // 排除嵌套 git worktree（.claude/worktrees/*）里的陈旧测试副本——
    // 它们属于其它分支的隔离检出，不应参与主工作树的测试门禁。
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
});
