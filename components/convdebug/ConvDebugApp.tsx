// components/convdebug/ConvDebugApp.tsx
// 会话调试页壳（spec §6）：左列表 + 右详情，?convId= 深链，storage.watch 自动跟随。
// 数据直接 import storage/*（扩展页面读 chrome.storage 无障碍，先例见 ChatView/MemoryPage）。
import { useEffect, useMemo, useState } from 'react';
import { storage } from 'wxt/utils/storage';
import { Activity } from 'lucide-react';
import { listConversations, getConversation, type Conversation, type ConversationMeta } from '../../storage/conversations';
import { readTraces, type ConvTraceStore } from '../../storage/traces';
import { firstKeptTurn, formatRelativeTime, isMissingConversation, isTrimmed } from './convdebug-utils';
import { TurnTimeline } from './TurnTimeline';
import { RawMessages } from './RawMessages';

type DetailView = 'timeline' | 'messages';

const INDEX_KEY = 'local:conv-index';
const traceKey = (id: string) => `local:conv:${id}:trace` as const;
const convKey = (id: string) => `local:conv:${id}` as const;
const EMPTY_TRACES: ConvTraceStore = { seq: 0, turns: [] };

export function ConvDebugApp({ initialConvId }: { initialConvId: string }) {
  const [list, setList] = useState<ConversationMeta[]>([]);
  const [convId, setConvId] = useState(initialConvId);
  const [conv, setConv] = useState<Conversation | null>(null);
  const [traces, setTraces] = useState<ConvTraceStore>(EMPTY_TRACES);
  const [view, setView] = useState<DetailView>('timeline');
  const [follow, setFollow] = useState(true);

  // 会话列表：挂载读一次，清单变更靠 watch 兜
  useEffect(() => {
    const load = async () => {
      const l = await listConversations();
      setList(l);
      // 深链缺省：没指定就选最近一个
      setConvId((cur) => cur || (l[0]?.id ?? ''));
    };
    void load();
    return storage.watch(INDEX_KEY, () => void load());
  }, []);

  // 详情：convId / follow 变化重读；跟随开启时 watch 该会话的 conv + trace key
  useEffect(() => {
    if (!convId) {
      setConv(null);
      setTraces(EMPTY_TRACES);
      return;
    }
    let alive = true;
    const load = async () => {
      const [c, t] = await Promise.all([getConversation(convId), readTraces(convId)]);
      if (!alive) return;
      setConv(c);
      setTraces(t);
    };
    void load();
    if (!follow) return () => { alive = false; };
    const unwatchConv = storage.watch(convKey(convId), () => void load());
    const unwatchTrace = storage.watch(traceKey(convId), () => void load());
    return () => { alive = false; unwatchConv(); unwatchTrace(); };
  }, [convId, follow]);

  const select = (id: string) => {
    setConvId(id);
    // replaceState 而非 push：切会话不该堆返回历史
    history.replaceState(null, '', `?convId=${encodeURIComponent(id)}`);
  };

  const missing = conv != null && isMissingConversation(conv);
  const trimmed = isTrimmed(traces);
  const selectedMeta = useMemo(() => list.find((m) => m.id === convId), [list, convId]);

  return (
    <div className="convdebug">
      <header className="convdebug__bar">
        <span className="convdebug__brand">
          <Activity size={16} strokeWidth={1.8} aria-hidden />
          会话调试
        </span>
        <label className="convdebug__follow">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          自动跟随
        </label>
      </header>

      <div className="convdebug__body">
        <aside className="convdebug__list" aria-label="会话列表">
          {list.length === 0 && <p className="convdebug__empty">还没有任何会话</p>}
          {list.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`convdebug-item${m.id === convId ? ' convdebug-item--active' : ''}`}
              onClick={() => select(m.id)}
            >
              <span className="convdebug-item__title">{m.title}</span>
              <span className="convdebug-item__meta mono">
                {formatRelativeTime(m.updatedAt)} · {m.status}
              </span>
            </button>
          ))}
        </aside>

        <main className="convdebug__detail">
          {!convId ? (
            <p className="convdebug__empty">从左侧选一个会话</p>
          ) : missing ? (
            <p className="convdebug__empty">会话不存在或已删除</p>
          ) : (
            <>
              <div className="convdebug__head">
                <h1 className="convdebug__title">{conv?.title ?? selectedMeta?.title ?? ''}</h1>
                <span className="convdebug__meta mono">
                  {conv?.status ?? '—'} · {conv?.messages.length ?? 0} 消息 · {traces.turns.length} 轮
                </span>
                <div className="convdebug__views">
                  <button
                    type="button"
                    className={`btn${view === 'timeline' ? ' btn--primary' : ''}`}
                    onClick={() => setView('timeline')}
                  >
                    轮次时间线
                  </button>
                  <button
                    type="button"
                    className={`btn${view === 'messages' ? ' btn--primary' : ''}`}
                    onClick={() => setView('messages')}
                  >
                    原始消息流
                  </button>
                </div>
              </div>

              {trimmed && (
                <p className="convdebug__note mono">
                  trace 仅保留最近 {traces.turns.length} 轮（第 {firstKeptTurn(traces)}–{traces.seq} 轮），更早的轮次请查看原始消息流
                </p>
              )}

              {/* key=convId：切会话时整体重挂载时间线。toggled 以裸轮次号为键，
                  两个会话的轮次都从 1 起号，不重挂载就会串扰（A 里收起的第 5 轮
                  会让 B 的第 5 轮也呈收起态，违反「最近一轮默认展开」）。
                  消息视图同理：行 key 是 `${i}-${role}`（见 convdebug-utils），
                  两个会话都以 0-system/1-user 开头，reconcile 会复用同一批
                  <details> 节点——而 open 是非受控 DOM 态，React 不会重置它。
                  两个分支各自带 key，重挂载键只覆盖自己那棵子树。 */}
              {view === 'timeline'
                ? <TurnTimeline key={convId} turns={traces.turns} />
                : <RawMessages key={convId} messages={conv?.messages ?? []} />}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
