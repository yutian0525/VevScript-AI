// vitest.config.ts
import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  // WxtVitest 返回 Promise<vite.PluginOption[]>，vite 支持在 plugins 数组中内联 Promise
  plugins: [WxtVitest()],
});
