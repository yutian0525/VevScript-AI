// components/chat/ChatView.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { Send, Wrench, CircleAlert, Loader2, Check, X, ChevronRight, Brain, Square } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { Gauge } from '../ui/Gauge';
import { useChat, type ChatItem } from '../../stores/chat';
import { getSession } from '../../storage/sessions';
import type { PortMsgFromPanel, PortMsgToPanel } from '../../shared/messages';

export function ChatView() {
  const { messages, status, pauseReason, addUserMessage, applyEvent } = useChat();
  const [input, setInput] = useState('');
  const portRef = useRef<ReturnType<typeof browser.runtime.connect> | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // 惰性建立/复用 Port：MV3 service worker 空闲会被杀导致 port 断开，
  // 这里在每次使用前确保有活 port，断开后自动重连（下次 connect 会唤醒 SW）。
  const ensurePort = useCallback(() => {
    if (portRef.current) return portRef.current;
    const port = browser.runtime.connect({ name: 'agent' });
    port.onMessage.addListener((m) => applyEvent(m as PortMsgToPanel));
    port.onDisconnect.addListener(() => {
      // 读掉 lastError 抑制 "Unchecked runtime.lastError" 噪声；置空以便下次重连
      void browser.runtime.lastError;
      portRef.current = null;
    });
    portRef.current = port;
    return port;
  }, [applyEvent]);

  useEffect(() => {
    ensurePort();
    return () => {
      portRef.current?.disconnect();
      portRef.current = null;
    };
  }, [ensurePort]);

  // 只在「有新消息 / 流式增量 / 工具状态变化」时滚到底；展开·收起（只改 expanded）不触发——
  // 否则点开工具详情会因 toggleExpand 新建 messages 引用而被拽到底部。
  const last = messages[messages.length - 1];
  const scrollKey = `${messages.length}:${last?.text?.length ?? 0}:${last?.reasoning?.length ?? 0}:${last?.status ?? ''}`;
  // 首次滚动（挂载/切回会话 tab 时列表已满）用 auto 瞬时到底，避免从顶部平滑滚一段；
  // 之后的流式增量才用 smooth 平滑跟随。
  const firstScroll = useRef(true);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: firstScroll.current ? 'auto' : 'smooth' });
    firstScroll.current = false;
  }, [scrollKey]);

  // 挂载恢复：store 为空时，从当前 tab 的 storage 读历史渲染（含思考折叠、工具卡片）。
  // 只读 storage 渲染，不接管运行中 loop 的事件流（重连归 Phase 5）。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (useChat.getState().messages.length > 0) return;
      const tabId = await activeTabId();
      if (tabId == null || cancelled) return;
      const session = await getSession(tabId);
      if (cancelled || useChat.getState().messages.length > 0) return;
      if (session.messages.length > 0) useChat.getState().loadFromStorage(session.messages);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function activeTabId(): Promise<number | undefined> {
    // 侧边栏里 currentWindow 有时取不到；退化到 lastFocusedWindow 兜底。
    let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab) [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.id;
  }

  // 经活 port 发送；port 已死（SW 被杀）时同步抛错，捕获后重置 port + 回退状态并提示。
  const postToPort = (msg: PortMsgFromPanel): boolean => {
    try {
      ensurePort().postMessage(msg);
      return true;
    } catch {
      portRef.current = null;
      applyEvent({ type: 'error', message: '与后台的连接已断开，请重试（若持续，请重新加载扩展）' });
      return false;
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || status === 'running') return;
    useChat.getState().setStatus('running'); // 乐观置 running，关闭 await 期间的并发窗口
    const tabId = await activeTabId();
    if (tabId == null) {
      // 拿不到标签页不再静默——给用户明确提示（而非"发了没反应"）
      useChat.getState().setStatus('idle');
      applyEvent({ type: 'error', message: '无法获取当前标签页，请先切到一个普通网页标签再试' });
      return;
    }
    console.debug('[chat] send agent:start', { tabId, text });
    addUserMessage(text);
    setInput('');
    postToPort({ type: 'agent:start', tabId, userMessage: text });
  };

  const resume = async () => {
    const tabId = await activeTabId();
    if (tabId == null) return;
    useChat.getState().setStatus('running');
    postToPort({ type: 'agent:resume', tabId });
  };

  const stop = async () => {
    const tabId = await activeTabId();
    if (tabId == null) return;
    // 乐观回到 idle 给即时反馈；后台 loop 收到 abort 后在下个检查点干净退出
    useChat.getState().setStatus('idle');
    postToPort({ type: 'agent:stop', tabId });
  };

  const lastIdx = messages.length - 1;

  return (
    <PageShell title="会话" eyebrow="AGENT" right={<Gauge state={status} />}>
      <div className="chat">
        <div className="chat__log">
          {messages.length === 0 && (
            <div className="chat__empty">
              输入指令，让 AI 操作当前页面。
              <br />
              例如“帮我点掉 cookie 弹窗”。
            </div>
          )}
          {messages.map((m, i) => (
            <MessageRow key={i} index={i} item={m} streaming={status === 'running' && i === lastIdx} />
          ))}
          {status === 'paused' && (
            <div className="pausebar rise">
              <div style={{ marginBottom: 8 }}>
                <span className="token" style={{ color: 'var(--warn)' }}>PAUSED</span> {pauseReason}
              </div>
              <Button variant="signal" onClick={resume}>继续</Button>
            </div>
          )}
          <div ref={endRef} />
        </div>
        <div className="dock">
          <textarea
            className="textarea"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
            placeholder={status === 'running' ? 'AI 执行中…' : '输入指令…'}
            disabled={status === 'running'}
            rows={2}
          />
          {status === 'running' ? (
            <Button variant="signal" className="dock__send" onClick={stop} aria-label="停止">
              <Square size={15} fill="currentColor" />
            </Button>
          ) : (
            <Button variant="signal" className="dock__send" onClick={send} aria-label="发送">
              <Send size={16} />
            </Button>
          )}
        </div>
      </div>
    </PageShell>
  );
}

function MessageRow({ item, index, streaming }: { item: ChatItem; index: number; streaming: boolean }) {
  const toggleExpand = useChat((s) => s.toggleExpand);

  if (item.role === 'user') {
    return <div className="msg-user rise">{item.text}</div>;
  }
  if (item.role === 'error') {
    return (
      <div className="msg-error rise">
        <CircleAlert size={15} />
        <span>{item.text}</span>
      </div>
    );
  }
  if (item.role === 'assistant') {
    return (
      <div className="rise">
        {item.reasoning != null && (
          <ReasoningBlock item={item} onToggle={() => toggleExpand(index)} />
        )}
        {item.text != null && (
          <div className={`msg-assistant${streaming && !item.thinking ? ' caret' : ''}`}>{item.text}</div>
        )}
      </div>
    );
  }
  // tool
  const state = item.status === 'running' ? 'running' : item.ok ? 'ok' : 'err';
  const canExpand = item.status === 'done';
  const open = !!item.expanded;
  return (
    <div className="rise">
      <button
        className={`toolcard toolcard--btn toolcard--${state}`}
        aria-expanded={canExpand ? open : undefined}
        onClick={() => canExpand && toggleExpand(index)}
        title={item.args}
      >
        <span className="toolcard__icon">
          {item.status === 'running' ? (
            <Loader2 size={13} className="spin" />
          ) : item.ok ? (
            <Check size={13} color="var(--ok)" />
          ) : (
            <X size={13} color="var(--err)" />
          )}
        </span>
        <span className="toolcard__name">{item.name}</span>
        {item.status === 'done' && item.summary && (
          <span className={`toolcard__summary${item.ok ? '' : ' toolcard__summary--err'}`}>· {item.summary}</span>
        )}
        {item.status === 'running' ? (
          <Wrench size={11} color="var(--ink-3)" style={{ marginLeft: 'auto' }} />
        ) : (
          <ChevronRight size={13} className={`toolcard__chev${open ? ' toolcard__chev--open' : ''}`} />
        )}
      </button>
      {open && canExpand && (
        <div className="toolcard__detail rise">
          {item.args && (
            <>
              <span className="token">ARGS</span>
              <div className="well" style={{ maxHeight: 160 }}>{formatArgs(item.args)}</div>
            </>
          )}
          {item.output && (
            <>
              <span className="token">OUTPUT</span>
              <div className="well" style={{ maxHeight: 260 }}>{item.output}</div>
            </>
          )}
          {item.image && (
            <>
              <span className="token">SCREENSHOT</span>
              <img className="toolcard__shot" src={item.image} alt="页面截图" />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ReasoningBlock({ item, onToggle }: { item: ChatItem; onToggle: () => void }) {
  // 思考中默认展开；出正文后（thinking=false）默认收起。用户手动 expanded 优先。
  const live = !!item.thinking;
  const open = item.expanded ?? live;
  return (
    <div className={`think${live ? ' think--live' : ''}`}>
      <button className="think__toggle" aria-expanded={open} onClick={onToggle}>
        {live ? <Loader2 size={12} className="spin" /> : <Brain size={12} />}
        <ChevronRight size={12} className={`think__chev${open ? ' think__chev--open' : ''}`} />
        <span>{live ? '思考中…' : '已思考'}</span>
      </button>
      {open && item.reasoning && <div className="think__body">{item.reasoning}</div>}
    </div>
  );
}

/** 工具参数：尽量格式化为多行 JSON，非法 JSON 原样返回。 */
function formatArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}
