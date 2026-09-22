// components/chat/ChatView.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { Paperclip, Wrench, CircleAlert, Loader2, Check, X, ChevronRight, ChevronDown, Brain, SquarePen, ArrowUp, ArrowDown, Square, ArrowDownToLine } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { Gauge } from '../ui/Gauge';
import { ContextRing } from './ContextRing';
import { Markdown } from './Markdown';
import { ConversationMenu } from './ConversationMenu';
import { SlashMenu } from './SlashMenu';
import { AttachmentChips } from './AttachmentChips';
import { ModeSelect } from './ModeSelect';
import { DeepObserveToggle } from './DeepObserveToggle';
import { ToolConfirmCard, type ConfirmDecision } from './ToolConfirmCard';
import { shouldOpenSlash, handleSlashKey, completeSlash } from './slash';
import { fileToAttachment, MAX_ATTACHMENTS } from './attachments';
import { filterSkills, useSkills } from '../../stores/skills';
import { nextFollow } from './follow';
import { useChat, type ChatItem } from '../../stores/chat';
import { useConversations } from '../../stores/conversations';
import { attachConv, postToAgent } from '../../stores/agent-port-client';
import { getSettings } from '../../storage/settings';
import { getDraft, saveDraft } from '../../storage/composer';
import { resolveContextWindow, DEFAULT_CONTEXT_WINDOW } from '../../agent/model-windows';
import type { PortMsgFromPanel } from '../../shared/messages';
import type { ChatAttachment } from '../../shared/types';

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * 首字前空窗判定：运行中且消息流末尾没有任何可见产出（思考中 / 正文 / 运行中工具卡片 / 确认卡 / 参数进度）。
 * 覆盖三类空窗：发消息后等首字、reasoning 流完等正文、工具跑完等下一轮模型输出。
 * 纯渲染推导，无独立状态——首字到达后条件自然不成立，切标签重连由 attach 回放自动恢复。
 * 确认卡（confirm 态）是可见产出：等用户决策期间「请确认」不能和「AI 正在准备回复」同屏。
 */
function isAwaitingFirstToken(messages: ChatItem[], argsProgress: boolean): boolean {
  const last = messages[messages.length - 1];
  if (!last) return false;
  if (last.role === 'assistant') return false;      // thinking 或正文已在流
  // 工具在跑（running）或正等确认（confirm）：确认卡本身就是可见产出
  if (last.role === 'tool' && (last.status === 'running' || last.status === 'confirm')) return false;
  return !argsProgress;
}

/** 空状态快捷指令（点击填入输入框，不自动发送）。所见即所得：填入 = tag 上展示的完整文案。 */
const HELLO_SUGGESTIONS: { tag?: string; label: string; text: string }[] = [
  { label: '帮我关闭页面上的弹窗', text: '帮我关闭页面上的弹窗' },
  { tag: '/help', label: '你能做什么？', text: '/help 你能做什么？' },
  { tag: '/find-scripts', label: '帮我找一个脚本', text: '/find-scripts 帮我找一个脚本' },
  { tag: '/write-script', label: '帮我写一个脚本', text: '/write-script 帮我写一个脚本' },
];

export function ChatView() {
  const { messages, status, pauseReason, applyEvent, promptTokens, compacting, argsProgress } = useChat();
  const { currentId, list, menuOpen, setMenuOpen } = useConversations();
  const [input, setInput] = useState('');
  const [draftReady, setDraftReady] = useState(false);
  const [contextWindow, setContextWindow] = useState(DEFAULT_CONTEXT_WINDOW);
  const [follow, setFollow] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [slashHi, setSlashHi] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachError, setAttachError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const skillList = useSkills((s) => s.list);
  const refreshSkills = useSkills((s) => s.refresh);
  // 上一次的 scrollTop：用来判滚动方向（见 ./follow.ts）
  const prevTopRef = useRef(0);

  // 挂载：恢复上次会话（浏览器重启后 session 指针已失效 → init 内自动开新会话）+ 读上下文窗口 + 拉技能列表。
  useEffect(() => {
    void useConversations.getState().init();
    void getSettings().then((s) => setContextWindow(resolveContextWindow(s.provider.model, s.provider.contextWindow)));
    void refreshSkills();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 会话变化（含挂载后 init 落定）→ 附着到后台：拿权威运行态 + 补发未落库的流式尾巴。
  // 端口不可用（扩展刚重载等）时把 running 落回 idle，避免输入框永久禁用。
  useEffect(() => {
    if (!currentId) return;
    if (!attachConv(currentId)) useChat.getState().setStatus('idle');
  }, [currentId]);

  // 切会话：重置跟随（新会话的内容一律先贴底）+ 清空未发送的附件暂存
  useEffect(() => { setFollow(true); prevTopRef.current = 0; setAttachments([]); setAttachError(''); }, [currentId]);

  // 草稿恢复：侧边栏切标签会被销毁重建，只活在 useState 里的未发送内容会丢（见 storage/composer.ts）。
  // 恢复完成才置 draftReady——先恢复后回写，否则挂载时的空值会把已存草稿抹掉。
  useEffect(() => {
    let alive = true;
    void getDraft().then((d) => {
      if (!alive) return;
      if (d) setInput((cur) => cur || d); // 恢复前用户已敲字则以用户为准
      setDraftReady(true);
    });
    return () => { alive = false; };
  }, []);

  // 草稿回写：每次变更即落 session 区，不等防抖——切标签随时可能销毁本文档，晚一步就丢。
  useEffect(() => {
    if (!draftReady) return;
    void saveDraft(input);
  }, [draftReady, input]);

  // 直接滚容器而非 sentinel.scrollIntoView：落点精确到底、不牵动外层滚动祖先。
  const scrollToBottom = useCallback((smooth: boolean) => {
    const el = logRef.current;
    if (!el) return;
    const top = el.scrollHeight;
    if (smooth && !prefersReducedMotion() && typeof el.scrollTo === 'function') {
      el.scrollTo({ top, behavior: 'smooth' });
    } else {
      el.scrollTop = top;
    }
  }, []);

  // 用户上滚 → 关跟随（露出「回到底部」悬浮钮）；滚回底部 → 自动重开。
  // 判定按方向而非绝对位置，否则程序化滚动的中间帧会把跟随自己关掉（见 ./follow.ts）。
  const onLogScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    const m = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    setFollow((f) => nextFollow(prevTopRef.current, m, f));
    prevTopRef.current = el.scrollTop;
  }, []);

  const last = messages[messages.length - 1];
  // argsProgress 计入 key：进度条出现/增长时若用户贴底则保持贴底（含 name，防新工具 bytes 重置时不触发）
  const scrollKey = `${messages.length}:${last?.text?.length ?? 0}:${last?.reasoning?.length ?? 0}:${last?.status ?? ''}:${argsProgress ? `${argsProgress.name}:${argsProgress.bytes}` : ''}`;
  useEffect(() => {
    // 跟随中才自动贴底。流式期间一律瞬时滚动：smooth 的中间态会被 scroll 监听误判成用户上滚。
    if (!follow) return;
    scrollToBottom(false);
    // follow 不入依赖：重开跟随的那一刻不补滚（用户可能还在惯性滚动中），等下一次内容变化再贴底
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey, scrollToBottom]);

  async function activeTabId(): Promise<number | undefined> {
    let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab) [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.id;
  }

  const postToPort = (msg: PortMsgFromPanel): boolean => {
    if (postToAgent(msg)) return true;
    applyEvent({ type: 'error', message: '与后台的连接已断开，请重试（若持续，请重新加载扩展）' });
    return false;
  };

  // 追加文件到暂存区：分类 → 读取/压缩 → 去超限，逐条汇报错误。
  const addFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setAttachError('');
    const errors: string[] = [];
    const accepted: ChatAttachment[] = [];
    let remaining = MAX_ATTACHMENTS - attachments.length;
    for (const file of files) {
      if (remaining <= 0) { errors.push(`最多 ${MAX_ATTACHMENTS} 个附件，其余已忽略`); break; }
      const r = await fileToAttachment(file);
      if ('error' in r) { errors.push(r.error); continue; }
      accepted.push(r);
      remaining -= 1;
    }
    if (accepted.length) setAttachments((prev) => [...prev, ...accepted]);
    if (errors.length) setAttachError(errors.join('；'));
  }, [attachments.length]);

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // 允许再次选同名文件
    void addFiles(files);
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return; // 纯文本粘贴走默认行为
    e.preventDefault();
    void addFiles(files);
  };

  const removeAttachment = (index: number) => setAttachments((prev) => prev.filter((_, i) => i !== index));

  const send = async () => {
    const text = input.trim();
    const atts = attachments;
    if ((!text && atts.length === 0) || status === 'running' || compacting) return;
    const convId = currentId;
    if (!convId) return;
    useChat.getState().setStatus('running');
    const tabId = await activeTabId();
    if (tabId == null) {
      useChat.getState().setStatus('idle');
      applyEvent({ type: 'error', message: '无法获取当前标签页，请先切到一个普通网页标签再试' });
      return;
    }
    useChat.getState().addUserMessage(text, atts);
    setInput('');
    setAttachments([]);
    setAttachError('');
    postToPort({ type: 'agent:start', convId, tabId, userMessage: text, attachments: atts.length ? atts : undefined, mode: useChat.getState().mode });
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

  const onConfirm = (callId: string, decision: ConfirmDecision) => {
    if (!currentId) return;
    postToPort({ type: 'agent:confirm', convId: currentId, callId, decision });
  };

  const title = list.find((c) => c.id === currentId)?.title ?? '新会话';
  const lastIdx = messages.length - 1;

  const hasInput = input.trim().length > 0 || attachments.length > 0;
  const attachDisabled = status === 'running' || compacting || attachments.length >= MAX_ATTACHMENTS;

  // 斜杠浮层候选与可见性（spec §3）：/ 开头且尚无空白时触发，Esc 临时关闭（slashDismissed）。
  // 候选在计算处统一截断 8 条——浮层渲染与键盘导航（count）共用同一数组，防高亮索引逃出可见窗口。
  const slashCandidates = slashDismissed
    ? []
    : filterSkills(skillList, input.startsWith('/') ? input.slice(1) : '').slice(0, 8);
  const slashVisible = !slashDismissed && shouldOpenSlash(input) && slashCandidates.length > 0;
  const slashHiSafe = Math.min(slashHi, Math.max(0, slashCandidates.length - 1));
  const selectSlash = (cmd: string) => {
    setInput(completeSlash(cmd));
    setSlashDismissed(false);
    void textareaRef.current?.focus();
  };

  return (
    <PageShell
      title={title}
      eyebrow="AGENT"
      right={<Gauge state={status} />}
      actions={
        <>
          <Tooltip label="新建会话">
            <Button variant="ghost" className="btn--icon" aria-label="新建会话" onClick={() => void useConversations.getState().newConversation()}>
              <SquarePen size={16} />
            </Button>
          </Tooltip>
          <Tooltip label="会话列表" disabled={menuOpen}>
            <Button variant="ghost" className="btn--icon" aria-label="会话列表" aria-expanded={menuOpen} onClick={() => { if (!menuOpen) void useConversations.getState().refreshList(); setMenuOpen(!menuOpen); }}>
              <ChevronDown size={16} />
            </Button>
          </Tooltip>
        </>
      }
    >
      <div className="chat">
        <ConversationMenu />
        <div className="chat__stage">
          <div className="chat__log" ref={logRef} onScroll={onLogScroll}>
            {messages.length === 0 && (
              <div className="chat__hello">
                <div className="chat__hello-title">Hi</div>
                <div className="chat__hello-sub">需要我帮你做些什么？</div>
                <div className="chat__hello-tags">
                  {HELLO_SUGGESTIONS.map((s) => (
                    <button
                      key={s.text}
                      type="button"
                      className="chat__hello-tag"
                      onClick={() => {
                        setInput(s.text);
                        textareaRef.current?.focus();
                      }}
                    >
                      {s.tag ? <span className="mono chat__hello-tagcmd">{s.tag}</span> : null}
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <MessageRow key={i} index={i} item={m} streaming={status === 'running' && i === lastIdx} onConfirm={onConfirm} />
            ))}
            {status === 'running' && isAwaitingFirstToken(messages, !!argsProgress) && (
              <div className="chat-pending rise" aria-label="AI 正在准备回复">
                <span className="chat-pending__bar" />
                <span className="chat-pending__bar" />
                <span className="chat-pending__bar" />
              </div>
            )}
            {argsProgress && status === 'running' && (
              <div className="argsprog rise">
                <span className="mono argsprog__name">{argsProgress.name}</span>
                <span className="argsprog__text">正在生成参数…</span>
                <span className="mono argsprog__size">{formatBytes(argsProgress.bytes)}</span>
              </div>
            )}
            {status === 'paused' && (
              <div className="pausebar rise">
                <div style={{ marginBottom: 8 }}>
                  <span className="token" style={{ color: 'var(--warn)' }}>PAUSED</span> {pauseReason || '已暂停'}
                </div>
                <Button variant="signal" onClick={resume}>继续</Button>
              </div>
            )}
          </div>
          {!follow && messages.length > 0 && (
            <Tooltip label="滚动到底部">
              <button
                type="button"
                className="chat__tobottom"
                // 流式中用瞬时：smooth 的下落会被下一次增量的瞬时贴底截断，不如一步到位
                onClick={() => { setFollow(true); scrollToBottom(status !== 'running'); }}
                aria-label="滚动到底部"
              >
                <ArrowDownToLine size={15} />
              </button>
            </Tooltip>
          )}
        </div>
        <div className="composer">
          {attachments.length > 0 && (
            <AttachmentChips items={attachments} onRemove={removeAttachment} />
          )}
          {attachError && (
            <div className="composer__attach-err">
              <CircleAlert size={12} />
              <span>{attachError}</span>
            </div>
          )}
          <div className="composer__wrap">
            {slashVisible && (
              <SlashMenu
                candidates={slashCandidates}
                hi={slashHiSafe}
                onSelect={selectSlash}
              />
            )}
            <textarea
              ref={textareaRef}
              className="composer__input"
              value={input}
              onChange={(e) => { setInput(e.target.value); setSlashDismissed(false); setSlashHi(0); }}
              onPaste={onPaste}
              onKeyDown={(e) => {
                if (slashVisible) {
                  const next = handleSlashKey(e.key, { open: true, hi: slashHiSafe, count: slashCandidates.length });
                  if (next) {
                    e.preventDefault();
                    if (next.selected) {
                      selectSlash(slashCandidates[next.hi ?? slashHiSafe]!.command);
                    } else if (typeof next.hi === 'number') {
                      setSlashHi(next.hi);
                    } else {
                      setSlashDismissed(true);
                    }
                    return;
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
              }}
              placeholder={compacting ? '压缩中…' : status === 'running' ? 'AI 执行中…' : '输入指令，让 AI 操作页面…'}
              disabled={status === 'running' || compacting}
              rows={2}
            />
          </div>
          <div className="composer__bar">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,text/*,.md,.markdown,.json,.csv,.tsv,.log,.xml,.yaml,.yml,.js,.jsx,.ts,.tsx,.py,.go,.rs,.java,.c,.h,.cpp,.css,.html,.sh,.sql,.toml,.ini"
              style={{ display: 'none' }}
              onChange={onPickFiles}
            />
            <Tooltip label={attachments.length >= MAX_ATTACHMENTS ? `最多 ${MAX_ATTACHMENTS} 个附件` : '上传附件（文本 / 图片，也可 Ctrl+V 粘贴）'}>
              <button
                type="button"
                className="composer__attach"
                disabled={attachDisabled}
                aria-label="上传附件"
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip size={16} />
              </button>
            </Tooltip>
            <DeepObserveToggle disabled={status === 'running'} />
            <div className="composer__actions">
              <ModeSelect disabled={status === 'running' ? false : compacting} />
              <ContextRing
                used={promptTokens}
                windowSize={contextWindow}
                compacting={compacting}
                disabled={!currentId || messages.length === 0 || status === 'running'}
                onCompact={compact}
              />
              {status === 'running' ? (
                <button type="button" className="composer__send" onClick={stop} aria-label="停止执行">
                  <Square size={13} fill="currentColor" />
                </button>
              ) : (
                <button
                  type="button"
                  className="composer__send"
                  onClick={() => void send()}
                  disabled={!hasInput || compacting}
                  aria-label="发送"
                >
                  <ArrowUp size={17} strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </PageShell>
  );
}

function MessageRow({ item, index, streaming, onConfirm }: { item: ChatItem; index: number; streaming: boolean; onConfirm?: (callId: string, decision: ConfirmDecision) => void }) {
  const toggleExpand = useChat((s) => s.toggleExpand);

  if (item.role === 'user') {
    return (
      <div className="msg-user rise">
        {item.attachments && item.attachments.length > 0 && (
          <AttachmentChips items={item.attachments} />
        )}
        {item.text ? <div className="msg-user__text">{item.text}</div> : null}
      </div>
    );
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
          <div className="msg-assistant">
            <Markdown text={item.text} streaming={streaming && !item.thinking} />
          </div>
        )}
        {item.usage && (item.usage.prompt != null || item.usage.completion != null) && (
          <div className="msg-usage mono">
            {item.usage.prompt != null && (<><ArrowUp size={10} />{formatTokens(item.usage.prompt)}</>)}
            {item.usage.completion != null && (<><ArrowDown size={10} />{formatTokens(item.usage.completion)}</>)}
          </div>
        )}
      </div>
    );
  }
  // tool
  if (item.status === 'confirm') {
    return (
      <div className="rise">
        <ToolConfirmCard
          name={item.name ?? ''}
          args={item.args ? formatArgs(item.args) : undefined}
          until={item.confirmUntil ?? Date.now()}
          onDecide={(d) => { if (item.callId) onConfirm?.(item.callId, d); }}
        />
      </div>
    );
  }
  const state = item.status === 'running' ? 'running' : item.ok ? 'ok' : 'err';
  const canExpand = item.status === 'done';
  const open = !!item.expanded;
  return (
    <div className="rise">
      <Tooltip label={item.args} disabled={!item.args}>
      <button
        className={`toolcard toolcard--btn toolcard--${state}`}
        aria-expanded={canExpand ? open : undefined}
        onClick={() => canExpand && toggleExpand(index)}
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
      </Tooltip>
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
  const bodyRef = useRef<HTMLDivElement>(null);
  // 吸附意图：仅由用户滚动改变（内容增长不触发 scroll 事件，故不会误关）。
  // 这样一旦吸底就持续跟随流式；用户上滚查看即脱离，滚回底部又重新吸附。
  const stickRef = useRef(true);
  useEffect(() => {
    if (!live) return;
    const el = bodyRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [live, item.reasoning]);
  function onBodyScroll(): void {
    const el = bodyRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
  }
  return (
    <div className={`think${live ? ' think--live' : ''}`}>
      <button className="think__toggle" aria-expanded={open} onClick={onToggle}>
        {live ? <Loader2 size={12} className="spin" /> : <Brain size={12} />}
        <ChevronRight size={12} className={`think__chev${open ? ' think__chev--open' : ''}`} />
        <span>{live ? '思考中…' : '已思考'}</span>
      </button>
      {open && item.reasoning && (
        <div ref={bodyRef} className="think__body" onScroll={onBodyScroll}>{item.reasoning}</div>
      )}
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

/** token 数格式化：>=1000 显示 xk，否则原样。 */
function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** 参数进度的体积显示：<1KB 显示字节，否则一位小数的 KB。 */
function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}
