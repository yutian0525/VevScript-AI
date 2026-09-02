// components/chat/ConversationMenu.tsx
// 会话下拉抽屉（设计 §2.2）：新建 + 列表 + 行内重命名 + 删除。
import { useState } from 'react';
import { SquarePen, Trash2, Check, X } from 'lucide-react';
import { useConversations } from '../../stores/conversations';

/** 相对时间（中文）。now 可注入便于测试。 */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return '刚刚';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

export function ConversationMenu() {
  const { list, currentId, menuOpen, setMenuOpen, newConversation, switchTo, rename, remove } = useConversations();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  if (!menuOpen) return null;

  const startRename = (id: string, title: string) => { setEditingId(id); setDraft(title); };
  const commitRename = async (id: string) => { await rename(id, draft); setEditingId(null); };

  return (
    <>
      <div className="convmenu__scrim" onClick={() => setMenuOpen(false)} aria-hidden />
      <div className="convmenu rise" role="menu" aria-label="会话列表">
        <button className="convmenu__new" onClick={() => void newConversation()}>
          <SquarePen size={14} />
          <span>新建会话</span>
        </button>
        <div className="convmenu__list">
          {list.length === 0 && <div className="convmenu__empty">还没有历史会话</div>}
          {list.map((c) => (
            <div key={c.id} className={`convrow${c.id === currentId ? ' convrow--active' : ''}`}>
              {editingId === c.id ? (
                <div className="convrow__edit">
                  <input
                    className="input"
                    value={draft}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void commitRename(c.id); if (e.key === 'Escape') setEditingId(null); }}
                  />
                  <button className="convrow__iconbtn" aria-label="确定" onClick={() => void commitRename(c.id)}><Check size={13} /></button>
                  <button className="convrow__iconbtn" aria-label="取消" onClick={() => setEditingId(null)}><X size={13} /></button>
                </div>
              ) : (
                <>
                  <button className="convrow__main" onClick={() => void switchTo(c.id)}>
                    {c.status === 'running' && <span className="dot dot--running" />}
                    <span className="convrow__title">{c.title}</span>
                    <span className="convrow__time mono">{relativeTime(c.updatedAt)}</span>
                  </button>
                  <div className="convrow__actions">
                    <button className="convrow__iconbtn" aria-label="重命名" onClick={() => startRename(c.id, c.title)}><SquarePen size={13} /></button>
                    <button className="convrow__iconbtn" aria-label="删除" onClick={() => void remove(c.id)}><Trash2 size={13} /></button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
