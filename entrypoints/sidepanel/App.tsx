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

export default function App() {
  const { page, setPage } = useUi();

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <nav
        style={{
          width: 48,
          borderRight: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          paddingTop: 12,
          gap: 4,
          flexShrink: 0,
        }}
      >
        {NAV.map(({ page: p, label, Icon }) => (
          <button
            key={p}
            title={label}
            aria-label={label}
            onClick={() => setPage(p)}
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              border: 'none',
              background: page === p ? '#eff6ff' : 'transparent',
              color: page === p ? 'var(--accent)' : 'var(--fg-muted)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
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
