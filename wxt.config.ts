// wxt.config.ts
import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'AI Browser Extension',
    description: 'AI 驱动的浏览器操控助手',
    // 工具栏图标点击弹出 popup 浮窗（开侧边栏 / 脚本管理直达 / 当前页运行中脚本菜单触发）。
    // popup 内的「打开侧边栏」按钮走 sidePanel.open，取代旧的 setPanelBehavior 直开。
    action: {
      default_popup: 'popup.html',
    },
    permissions: ['tabs', 'scripting', 'storage', 'sidePanel', 'webRequest', 'userScripts', 'notifications', 'clipboardWrite'],
    host_permissions: ['<all_urls>'],
    side_panel: {
      default_path: 'sidepanel.html',
    },
  },
});
