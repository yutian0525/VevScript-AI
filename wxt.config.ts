// wxt.config.ts
import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'AI Browser Extension',
    description: 'AI 驱动的浏览器操控助手',
    permissions: ['tabs', 'scripting', 'storage', 'sidePanel', 'webRequest'],
    host_permissions: ['<all_urls>'],
    side_panel: {
      default_path: 'sidepanel.html',
    },
  },
});
