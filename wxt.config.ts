// wxt.config.ts
import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'AI Browser Extension',
    description: 'AI 驱动的浏览器操控助手',
    // 无 action 键 = 无工具栏图标，setPanelBehavior({openPanelOnActionClick}) 无处挂接，
    // 用户将没有任何入口打开侧边栏
    action: {},
    permissions: ['tabs', 'scripting', 'storage', 'sidePanel', 'webRequest', 'userScripts'],
    host_permissions: ['<all_urls>'],
    side_panel: {
      default_path: 'sidepanel.html',
    },
  },
});
