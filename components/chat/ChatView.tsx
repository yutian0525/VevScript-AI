// components/chat/ChatView.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { Send, Wrench, CircleAlert, Loader2, Check, X, ChevronRight, ChevronDown, Brain, Square, SquarePen } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { Gauge } from '../ui/Gauge';
import { ContextRing } from './ContextRing';
import { ConversationMenu } from './ConversationMenu';
import { useChat, type ChatItem } from '../../stores/chat';
import { useConversations } from '../../stores/conversations';
import { getSettings } from '../../storage/settings';
import { resolveContextWindow, DEFAULT_CONTEXT_WINDOW } from '../../agent/model-windows';
import type { PortMsgFromPanel, PortMsgToPanel } from '../../shared/messages';

export function ChatView() {
  const { messages, status, pauseReason, applyEvent, promptTokens, compacting } = useChat();
  const { currentId, list, menuOpen, setMenuOpen } = useConversations();
  const [input, setInput] = useState('');
  const [contextWindow, setContextWindow] = useState(DEFAULT_CONTEXT_WINDOW);
  const portRef = useRef<ReturnType<typeof browser.runtime.connect> | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const ensurePort = useCallback(() => {
    if (portRef.current) return portRef.current;
    const port = browser.runtime.connect({ name: 'agent' });
    port.onMessage.addListener((m) => applyEvent(m as PortMsgToPanel));
    port.onDisconnect.addListener(() => {
      void browser.runtime.lastError;
      portRef.current = null;
    });
    portRef.current = port;
    return port;
  }, [applyEvent]);

  useEffect(() => {
    ensurePort();
    return () => { portRef.current?.disconnect(); portRef.current = null; };
  }, [ensurePort]);

  const last = messages[messages.length - 1];
  const scrollKey = `${messages.length}:${last?.text?.length ?? 0}:${last?.reasoning?.length ?? 0}:${last?.status ?? ''}`;
  const firstScroll = useRef(true);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: firstScroll.current ? 'auto' : 'smooth' });
    firstScroll.current = false;
  }, [scrollKey]);

  // 挂载：默认开一个新会话（草稿，不落库）+ 载入会话列表 + 读上下文窗口。
  useEffect(() => {
    void useConversations.getState().refreshList();
    void useConversations.getState().newConversation();
    void getSettings().then((s) => setContextWindow(resolveContextWindow(s.provider.model, s.provider.contextWindow)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function activeTabId(): Promise<number | undefined> {
    let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab) [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.id;
  }

  const postToPort = (msg: PortMsgFromPanel): boolean => {
    try { ensurePort().postMessage(msg); return true; }
    catch {
      portRef.current = null;
      applyEvent({ type: 'error', message: '与后台的连接已断开，请重试（若持续，请重新加载扩展）' });
      return false;
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || status === 'running' || compacting) return;
    const convId = currentId;
    if (!convId) return;
    useChat.getState().setStatus('running');
    const tabId = await activeTabId();
    if (tabId == null) {
      useChat.getState().setStatus('idle');
      applyEvent({ type: 'error', message: '无法获取当前标签页，请先切到一个普通网页标签再试' });
      return;
    }
    useChat.getState().addUserMessage(text);
    setInput('');
    postToPort({ type: 'agent:start', convId, tabId, userMessage: text });
    // 首条消息发出后会话落库 → 刷新列表让其出现在下拉里
    void useConversations.getState().refreshList();
  };

  const resume = async () => {
    if (!currentId) return;
    const tabId = await activeTabId();
    if (tabId == null) return;
    useChat.getState().setStatus('running');
    postToPort({ type: 'agent:resume', convId: currentId, tabId });
  };

  const stop = () => {
    if (!currentId) return;
    useChat.getState().setStatus('idle');
    postToPort({ type: 'agent:stop', convId: currentId });
  };

  const compact = () => {
    if (!currentId || compacting || status === 'running') return;
    postToPort({ type: 'agent:compact', convId: currentId });
  };

  const title = list.find((c) => c.id === currentId)?.title ?? '新会话';
  const lastIdx = messages.length - 1;

  return (
    <PageShell
      title={title}
      eyebrow="AGENT"
      right={<Gauge state={status} />}
      actions={
        <>
          <Button variant="ghost" aria-label="新建会话" onClick={() => void useConversations.getState().newConversation()}>
            <SquarePen size={16} />
          </Button>
          <Button variant="ghost" aria-label="会话列表" aria-expanded={menuOpen} onClick={() => { if (!menuOpen) void useConversations.getState().refreshList(); setMenuOpen(!menuOpen); }}>
            <ChevronDown size={16} />
          </Button>
        </>
      }
    >
      <div className="chat">
        <ConversationMenu />
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
            placeholder={compacting ? '压缩中…' : status === 'running' ? 'AI 执行中…' : '输入指令…'}
            disabled={status === 'running' || compacting}
            rows={2}
          />
          <div className="dock__controls">
            <ContextRing
              used={promptTokens}
              window={contextWindow}
              compacting={compacting}
              disabled={!currentId || messages.length === 0 || status === 'running'}
              onCompact={compact}
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
