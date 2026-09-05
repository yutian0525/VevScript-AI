// wxt.config.ts
import { defineConfig } from 'wxt';

export default defineConfig({
  // 扩展页面（popup/sidepanel/script-detail）的 chunk 都是 chrome-extension:// 本地资源，
  // Vite 默认注入的 `<link rel="modulepreload" crossorigin>` 在扩展的隔离世界里会 cross-world
  // 资源不匹配（预加载桶 ≠ 真正 import 时的桶），预加载永远命中不了，几秒后 Chrome 就刷
  // "preloaded but not used" 警告。本地资源无网络延迟，预取零收益，直接关掉最干净。
  vite: () => ({
    build: {
      modulePreload: false,
    },
  }),
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
