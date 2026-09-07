// entrypoints/sidepanel/App.tsx
import { useEffect } from 'react';
import { storage } from 'wxt/utils/storage';
import { MessageSquare, Puzzle, Settings as SettingsIcon } from 'lucide-react';
import { useUi, type Page } from '../../stores/ui';
import { ChatView } from '../../components/chat/ChatView';
import { ScriptsView } from '../../components/scripts/ScriptsView';
import { SettingsView } from '../../components/settings/SettingsView';
import { Tooltip } from '../../components/ui/Tooltip';
import type { UiNavNotification } from '../../shared/messages';

/** 消费 popup 落下的待航标记：侧边栏挂载时切到目标页，然后清除（一次性）。 */
async function consumePendingView(): Promise<void> {
  const pending = await storage.getItem<Page>('session:ui:pendingView');
  if (pending) {
    await storage.removeItem('session:ui:pendingView');
    useUi.getState().setPage(pending);
  }
}

const NAV: Array<{ page: Page; label: string; Icon: typeof MessageSquare }> = [
  { page: 'chat', label: '会话', Icon: MessageSquare },
  { page: 'scripts', label: '脚本池', Icon: Puzzle },
  { page: 'settings', label: '设置', Icon: SettingsIcon },
];

const PITCH = 42; // 每个导航按钮的纵向节距（40 高 + 2 gap）

export default function App() {
  const { page, setPage } = useUi();
  const activeIndex = NAV.findIndex((n) => n.page === page);

  // popup → 侧边栏跨面导航：挂载消费待航标记（侧边栏刚被 popup 唤起时）+ 实时监听 UI_NAV（侧边栏已开时）。
  useEffect(() => {
    void consumePendingView().catch(() => {}); // storage.session 某些环境不可用，容错
    const onMessage = (msg: unknown) => {
      const m = msg as { type?: string };
      if (m?.type === 'UI_NAV') {
        useUi.getState().setPage((msg as UiNavNotification).view);
        void storage.removeItem('session:ui:pendingView').catch(() => {}); // 双通道任一生效都清标记，防陈旧
      }
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, []);

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <nav className="railnav" aria-label="主导航">
        <span
          className="railnav__marker"
          style={{ ['--i' as string]: activeIndex, ['--pitch' as string]: `${PITCH}px` }}
          aria-hidden
        />
        {NAV.map(({ page: p, label, Icon }) => (
          <Tooltip key={p} label={label} placement="right">
            <button
              className="railnav__btn"
              aria-label={label}
              aria-current={page === p}
              onClick={() => setPage(p)}
            >
              <Icon size={18} strokeWidth={1.8} />
            </button>
          </Tooltip>
        ))}
      </nav>
      <main style={{ flex: 1, minWidth: 0, height: '100%' }}>
        <div className="view-swap" key={page}>
          {page === 'chat' && <ChatView />}
          {page === 'scripts' && <ScriptsView />}
          {page === 'settings' && <SettingsView />}
        </div>
      </main>
    </div>
  );
}
