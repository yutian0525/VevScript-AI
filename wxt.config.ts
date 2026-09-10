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
    name: '织雀AI脚本 Vevscript-ai',
    description: '在侧边栏说一句话，AI 就在当前网页上替你做完。常做的事，写成用户脚本以后自动跑。',
    // 工具栏图标点击弹出 popup 浮窗（开侧边栏 / 脚本管理直达 / 当前页运行中脚本菜单触发）。
    // popup 内的「打开侧边栏」按钮走 sidePanel.open，取代旧的 setPanelBehavior 直开。
    action: {
      default_popup: 'popup.html',
    },
    permissions: ['tabs', 'scripting', 'storage', 'sidePanel', 'webRequest', 'userScripts', 'notifications', 'clipboardWrite', 'offscreen', 'downloads', 'cookies', 'webNavigation'],
    host_permissions: ['<all_urls>'],
    side_panel: {
      default_path: 'sidepanel.html',
    },
  },
});
