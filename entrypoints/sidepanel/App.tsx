// entrypoints/sidepanel/App.tsx
import { MessageSquare, Puzzle, Settings as SettingsIcon } from 'lucide-react';
import { useUi, type Page } from '../../stores/ui';
import { ChatView } from '../../components/chat/ChatView';
import { ScriptsView } from '../../components/scripts/ScriptsView';
import { SettingsView } from '../../components/settings/SettingsView';

const NAV: Array<{ page: Page; label: string; Icon: typeof MessageSquare }> = [
  { page: 'chat', label: '会话', Icon: MessageSquare },
  { page: 'scripts', label: '脚本池', Icon: Puzzle },
  { page: 'settings', label: '设置', Icon: SettingsIcon },
];

const PITCH = 42; // 每个导航按钮的纵向节距（40 高 + 2 gap）

export default function App() {
  const { page, setPage } = useUi();
  const activeIndex = NAV.findIndex((n) => n.page === page);

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <nav className="railnav" aria-label="主导航">
        <span
          className="railnav__marker"
          style={{ ['--i' as string]: activeIndex, ['--pitch' as string]: `${PITCH}px` }}
          aria-hidden
        />
        {NAV.map(({ page: p, label, Icon }) => (
          <button
            key={p}
            className="railnav__btn"
            title={label}
            aria-label={label}
            aria-current={page === p}
            onClick={() => setPage(p)}
          >
            <Icon size={18} strokeWidth={1.8} />
          </button>
        ))}
      </nav>
      <main style={{ flex: 1, minWidth: 0, height: '100%' }}>
        {page === 'chat' && <ChatView />}
        {page === 'scripts' && <ScriptsView />}
        {page === 'settings' && <SettingsView />}
      </main>
    </div>
  );
}
