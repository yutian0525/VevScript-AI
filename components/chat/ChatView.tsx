// components/chat/ChatView.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { Send, Wrench, CircleAlert, Loader2 } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { useChat, type ChatItem } from '../../stores/chat';
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

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

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

  return (
    <PageShell title="会话">
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {messages.length === 0 && (
            <div style={{ color: 'var(--fg-muted)' }}>输入指令让 AI 操作当前页面，例如“帮我点掉 cookie 弹窗”。</div>
          )}
          {messages.map((m, i) => <MessageRow key={i} item={m} />)}
          {status === 'paused' && (
            <div style={{ padding: 10, background: '#fef9c3', borderRadius: 8, fontSize: 13 }}>
              已暂停：{pauseReason}
              <div style={{ marginTop: 8 }}><Button variant="primary" onClick={resume}>继续</Button></div>
            </div>
          )}
          <div ref={endRef} />
        </div>
        <div style={{ display: 'flex', gap: 8, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
            placeholder={status === 'running' ? 'AI 执行中…' : '输入指令…'}
            disabled={status === 'running'}
            rows={2}
            style={{ flex: 1, resize: 'none', padding: 8, borderRadius: 6, border: '1px solid var(--border)', fontSize: 13, fontFamily: 'inherit' }}
          />
          <Button variant="primary" onClick={send} disabled={status === 'running'} aria-label="发送">
            {status === 'running' ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
          </Button>
        </div>
      </div>
    </PageShell>
  );
}

function MessageRow({ item }: { item: ChatItem }) {
  if (item.role === 'user') {
    return <div style={{ alignSelf: 'flex-end', background: '#eff6ff', padding: '8px 12px', borderRadius: 10, maxWidth: '85%', fontSize: 13 }}>{item.text}</div>;
  }
  if (item.role === 'assistant') {
    return <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{item.text}</div>;
  }
  if (item.role === 'error') {
    return <div style={{ display: 'flex', gap: 6, color: '#dc2626', fontSize: 12 }}><CircleAlert size={14} /> {item.text}</div>;
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--fg-muted)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px' }} title={item.args}>
      {item.status === 'running' ? <Loader2 size={13} className="spin" /> : <Wrench size={13} />}
      <span>{item.name}</span>
      {item.status === 'done' && <span style={{ color: item.ok ? '#16a34a' : '#dc2626' }}>· {item.summary}</span>}
    </div>
  );
}
