// components/settings/McpSettings.tsx
// MCP 服务器设置二级页：增删改 / 启停 / 试连 / 导入导出。
//
// 版式语言与存储管理页一致：每个能力域一张卡（--line 描边 + 10px 圆角 + --surface 底），
// 卡内用发丝线分行。MCP 的信息骨架是「一台服务 = 一小块」：
//   头行 = 状态点 + 名称 + 状态胶囊 ｜ 启停开关
//   次行 = 服务地址 + 工具数（点开可看下发的工具名） ｜ 重连 / 编辑 / 删除
// 侧边栏只有 264px，四个控件挤一行会把名称与地址全挤成省略号，所以按「状态」与「操作」分两行放。
//
// 能力边界写在页首提示里：浏览器扩展起不了本地进程，只有 http(s) 的 MCP 服务能连。
import { useEffect, useRef, useState } from 'react';
import { Plug, Plus, RefreshCw, Pencil, Trash2, Upload, Download, X, ChevronDown } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Tooltip } from '../ui/Tooltip';
import { useTruncated } from '../ui/useTruncated';
import { useMcp } from '../../stores/mcp';
import { newMcpServer, getMcpServer } from '../../storage/mcp';
import { mcpTone, MCP_STATUS_LABEL, summarizeMcp } from '../../shared/mcp';
import type { McpServerConfig, McpStatusItem, McpTransport } from '../../shared/mcp';

/** 传输方式：短标签进分段控件（窄栏放不下长文案），完整解释放下方 hint。 */
const TRANSPORT_META: Array<{ value: McpTransport; short: string; desc: string }> = [
  { value: 'auto', short: '自动探测', desc: '先试 Streamable HTTP（2025-06-18），失败自动回退 HTTP+SSE' },
  { value: 'streamable', short: 'Streamable', desc: '只走单端点 Streamable HTTP（2025-06-18）' },
  { value: 'sse', short: 'HTTP+SSE', desc: '只走旧版双端点协议：GET 事件流 + POST /messages（2024-11-05）' },
];

type HeaderRow = { key: string; value: string };
/** 反馈条分槽：保存/试连的结果留在表单里，列表与导入导出的结果留在各自卡片里。 */
type Notice = { text: string; kind: 'ok' | 'err'; scope: 'form' | 'list' | 'io' };

function headersToRows(headers: Record<string, string>): HeaderRow[] {
  const rows = Object.entries(headers ?? {}).map(([key, value]) => ({ key, value }));
  return rows.length ? rows : [{ key: '', value: '' }];
}

function rowsToHeaders(rows: HeaderRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (k) out[k] = r.value;
  }
  return out;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function McpSettings({ onBack }: { onBack: () => void }) {
  const items = useMcp((s) => s.items);
  const refresh = useMcp((s) => s.refresh);
  const save = useMcp((s) => s.save);
  const remove = useMcp((s) => s.remove);
  const setEnabled = useMcp((s) => s.setEnabled);
  const connect = useMcp((s) => s.connect);
  const test = useMcp((s) => s.test);
  const importJson = useMcp((s) => s.importJson);
  const exportJson = useMcp((s) => s.exportJson);

  // null = 未打开表单；否则为正在编辑的配置（id 已存在 = 编辑，否则新增）
  const [editing, setEditing] = useState<McpServerConfig | null>(null);
  const [rows, setRows] = useState<HeaderRow[]>([{ key: '', value: '' }]);
  const [busy, setBusy] = useState<'' | 'save' | 'test'>('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { void refresh(); }, [refresh]);

  const doRefresh = async () => {
    setRefreshing(true);
    try { await refresh(); } finally { setRefreshing(false); }
  };

  const openNew = () => {
    setEditing(newMcpServer());
    setRows([{ key: '', value: '' }]);
    setNotice(null);
  };

  const openEdit = async (it: McpStatusItem) => {
    setNotice(null);
    // 状态广播里不含请求头（可能带 bearer 密钥），编辑必须回存储读全量，
    // 否则一保存就把原有鉴权头抹成空。
    const cfg = await getMcpServer(it.id);
    const full: McpServerConfig = cfg ?? {
      id: it.id, name: it.name, url: it.url, transport: it.transport, enabled: it.enabled, headers: {},
    };
    setEditing(full);
    setRows(headersToRows(full.headers));
  };

  const submit = async () => {
    if (!editing) return;
    setBusy('save');
    setNotice(null);
    try {
      await save({ ...editing, name: editing.name.trim(), url: editing.url.trim(), headers: rowsToHeaders(rows) });
      setEditing(null);
      setNotice({ text: '已保存，正在连接…', kind: 'ok', scope: 'list' });
    } catch (e) {
      setNotice({ text: `保存失败：${errText(e)}`, kind: 'err', scope: 'form' });
    } finally {
      setBusy('');
    }
  };

  const testCurrent = async () => {
    if (!editing) return;
    setBusy('test');
    setNotice(null);
    try {
      const r = await test({ ...editing, name: editing.name.trim(), url: editing.url.trim(), headers: rowsToHeaders(rows) });
      setNotice({ text: `连接成功：${r.tools} 个工具${r.protocolVersion ? ` · ${r.protocolVersion}` : ''}`, kind: 'ok', scope: 'form' });
    } catch (e) {
      setNotice({ text: `连接失败：${errText(e)}`, kind: 'err', scope: 'form' });
    } finally {
      setBusy('');
    }
  };

  const doRemove = async (id: string) => {
    setNotice(null);
    try {
      await remove(id);
    } catch (e) {
      setNotice({ text: `删除失败：${errText(e)}`, kind: 'err', scope: 'list' });
    }
  };

  const doExport = async () => {
    setNotice(null);
    try {
      const text = await exportJson();
      const url = `data:application/json;charset=utf-8,${encodeURIComponent(text)}`;
      await browser.downloads.download({ url, filename: 'mcp-servers.json', saveAs: true });
      setNotice({ text: '已导出 mcp-servers.json', kind: 'ok', scope: 'io' });
    } catch (e) {
      setNotice({ text: `导出失败：${errText(e)}`, kind: 'err', scope: 'io' });
    }
  };

  const doImport = async (file: File | undefined) => {
    if (!file) return;
    setNotice(null);
    try {
      const r = await importJson(await file.text());
      const extra = r.warnings.length ? `；${r.warnings.length} 条跳过（${r.warnings[0]}）` : '';
      // 一条都没进来时标红：多半整份配置都是 stdio 条目，绿色的「已导入 0 台」会骗人
      setNotice({ text: `已导入 ${r.imported} 台${extra}`, kind: r.imported === 0 ? 'err' : 'ok', scope: 'io' });
    } catch (e) {
      setNotice({ text: `导入失败：${errText(e)}`, kind: 'err', scope: 'io' });
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const sum = summarizeMcp(items);
  const noticeEl = (scope: Notice['scope']) => (
    notice && notice.scope === scope
      ? <div className={`status-text status-text--${notice.kind}`}>{notice.text}</div>
      : null
  );

  return (
    <PageShell
      title="MCP 服务器"
      eyebrow="MCP"
      onBack={onBack}
      backLabel="返回设置"
      right={(
        <Tooltip label={sum.tip}>
          <span className={`gauge gauge--mcp-${sum.tone}`}>
            <span className={`dot mcp__dot--${sum.tone === 'empty' ? 'idle' : sum.tone}`} aria-hidden />
            <span className="gauge__label">{sum.label}</span>
          </span>
        </Tooltip>
      )}
    >
      {/* 能力边界：先说清「为什么只能填 URL」，否则用户会拿 npx 配置来试 */}
      <div className="mcp__note">
        <Plug size={14} aria-hidden />
        <span>
          浏览器扩展起不了本地进程，只支持 <strong>http(s)</strong> 的 MCP 服务；
          <span className="mono">command</span> 形式的 stdio 配置导入时会被逐条跳过。
        </span>
      </div>

      <section className="section">
        <div className="mcp__bar">
          <h2 className="section__title">
            服务器<span className="mcp__count mono">{items.length}</span>
          </h2>
          <div className="mcp__bar-actions">
            <Tooltip label="刷新状态">
              <Button variant="ghost" className="btn--icon" aria-label="刷新状态" onClick={() => void doRefresh()}>
                <RefreshCw size={14} strokeWidth={1.8} className={refreshing ? 'spin' : undefined} />
              </Button>
            </Tooltip>
            <Button variant="primary" onClick={openNew}>
              <Plus size={14} strokeWidth={2} aria-hidden /> 新增
            </Button>
          </div>
        </div>

        {noticeEl('list')}

        {items.length === 0 ? (
          <div className="mcp__empty">
            <span className="mcp__empty-icon"><Plug size={16} aria-hidden /></span>
            <div className="mcp__empty-body">
              <span className="mcp__empty-title">还没有 MCP 服务器</span>
              <span className="mcp__empty-desc">填一个 http(s) 地址，就能把外部工具交给 AI 调用。</span>
            </div>
            <Button variant="primary" onClick={openNew}><Plus size={14} aria-hidden /> 添加</Button>
          </div>
        ) : (
          <div className="mcp__card">
            {items.map((it) => (
              <ServerRow
                key={it.id}
                it={it}
                onToggle={(next) => void setEnabled(it.id, next)}
                onReconnect={() => void connect(it.id)}
                onEdit={() => void openEdit(it)}
                onRemove={() => void doRemove(it.id)}
              />
            ))}
          </div>
        )}
      </section>

      {editing && (
        <section className="section">
          <div className="mcp__card mcp__card--form">
            <div className="mcp__form-head">
              <span className="token">{editing.name ? '编辑服务器' : '新增服务器'}</span>
              <span className="mcp__form-name">{editing.name || '未命名'}</span>
              <button
                type="button"
                className="mcp__iconbtn"
                aria-label="收起表单"
                onClick={() => { setEditing(null); setNotice(null); }}
              >
                <X size={14} />
              </button>
            </div>

            <div className="field">
              <label className="field-label" htmlFor="mcp-name">名称</label>
              <Input
                id="mcp-name"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="filesystem"
              />
              <span className="hint">
                决定工具名前缀 <span className="mono">mcp__&lt;名称&gt;__&lt;工具&gt;</span>；留空或纯中文会退化成 id。
              </span>
            </div>

            <div className="field">
              <label className="field-label" htmlFor="mcp-url">服务地址</label>
              <Input
                id="mcp-url"
                value={editing.url}
                onChange={(e) => setEditing({ ...editing, url: e.target.value })}
                placeholder="https://mcp.example.com/mcp"
                className="mono-input"
              />
            </div>

            <div className="field">
              <span className="field-label">传输方式</span>
              <div className="mcp__seg" role="radiogroup" aria-label="传输方式">
                {TRANSPORT_META.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    role="radio"
                    aria-checked={editing.transport === t.value}
                    className={`mcp__seg-btn${editing.transport === t.value ? ' mcp__seg-btn--on' : ''}`}
                    onClick={() => setEditing({ ...editing, transport: t.value })}
                  >
                    {t.short}
                  </button>
                ))}
              </div>
              <span className="hint">{TRANSPORT_META.find((t) => t.value === editing.transport)?.desc}</span>
            </div>

            <div className="field">
              <span className="field-label">请求头（鉴权，选填）</span>
              <div className="mcp__kvs">
                {rows.map((r, i) => (
                  <div key={i} className="mcp__kv">
                    <Input
                      value={r.key}
                      placeholder="Authorization"
                      aria-label="请求头名"
                      className="mcp__kv-key mono-input"
                      onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
                    />
                    <Input
                      value={r.value}
                      placeholder="Bearer sk-…"
                      aria-label="请求头值"
                      className="mono-input"
                      onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                    />
                    <Tooltip label="删除该请求头">
                      <button
                        type="button"
                        className="mcp__iconbtn"
                        aria-label="删除该请求头"
                        onClick={() => setRows(rows.length === 1 ? [{ key: '', value: '' }] : rows.filter((_, j) => j !== i))}
                      >
                        <Trash2 size={13} />
                      </button>
                    </Tooltip>
                  </div>
                ))}
              </div>
              <button type="button" className="mcp__addhdr" onClick={() => setRows([...rows, { key: '', value: '' }])}>
                <Plus size={12} aria-hidden /> 添加请求头
              </button>
              <span className="hint">用于 Bearer token / API Key 等鉴权，值里不能含换行。</span>
            </div>

            {noticeEl('form')}

            <div className="mcp__form-actions">
              <Button variant="primary" onClick={() => void submit()} disabled={busy !== ''}>
                {busy === 'save' ? '保存中…' : '保存'}
              </Button>
              <Button onClick={() => void testCurrent()} disabled={busy !== ''}>
                {busy === 'test' ? '测试中…' : '测试连接'}
              </Button>
              <Button variant="ghost" onClick={() => { setEditing(null); setNotice(null); }}>取消</Button>
            </div>
          </div>
        </section>
      )}

      <section className="section">
        <h2 className="section__title">导入 / 导出</h2>
        <div className="mcp__card">
          <div className="mcp__io">
            <div className="mcp__io-main">
              <span className="mcp__io-title">导入 JSON</span>
              <span className="mcp__io-desc">
                兼容 Claude Desktop 的 <span className="mono">{'{ mcpServers: { … } }'}</span>
              </span>
            </div>
            <Button onClick={() => fileRef.current?.click()}>
              <Upload size={14} aria-hidden /> 选择文件
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={(e) => { void doImport(e.target.files?.[0]); }}
            />
          </div>
          <div className="mcp__io">
            <div className="mcp__io-main">
              <span className="mcp__io-title">导出 JSON</span>
              <span className="mcp__io-desc">备份现有配置，含请求头，便于迁移</span>
            </div>
            <Button onClick={() => void doExport()} disabled={items.length === 0}>
              <Download size={14} aria-hidden /> 导出
            </Button>
          </div>
        </div>
        <div className="mcp__io-notice">{noticeEl('io')}</div>
      </section>
    </PageShell>
  );
}

/** 单台服务一块。状态与操作分两行：四个控件挤一行会把名称与地址全挤成省略号。
 *  删除要走「首点武装、再点执行」——与存储管理页清理区同一套交互，5s 自动撤防。 */
function ServerRow({ it, onToggle, onReconnect, onEdit, onRemove }: {
  it: McpStatusItem;
  onToggle: (enabled: boolean) => void;
  onReconnect: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const tone = mcpTone(it.status);
  const [armed, setArmed] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [nameRef, nameTruncated] = useTruncated<HTMLSpanElement>(it.name);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(t);
  }, [armed]);

  const failed = it.status === 'error' && !!it.error;
  const hasTools = it.tools.length > 0;

  return (
    <div className={`mcp__row${it.enabled ? '' : ' mcp__row--off'}`}>
      <div className="mcp__row-title">
        <span className={`dot mcp__dot--${tone}`} aria-hidden />
        <Tooltip label={it.name} disabled={!nameTruncated}>
          <span className="mcp__name" ref={nameRef}>{it.name}</span>
        </Tooltip>
        <span className={`chip mcp__chip--${tone}`}>{MCP_STATUS_LABEL[it.status]}</span>
      </div>

      <Tooltip label={it.enabled ? '禁用（不下发工具）' : '启用'}>
        <button
          type="button"
          className={`switch${it.enabled ? ' switch--on' : ''}`}
          aria-label={it.enabled ? '禁用' : '启用'}
          aria-pressed={it.enabled}
          onClick={() => onToggle(!it.enabled)}
        >
          <span className="switch__thumb" aria-hidden />
        </button>
      </Tooltip>

      {failed ? (
        <div className="mcp__row-sub">
          <Tooltip label={it.error!}>
            <span className="mcp__err">{it.error}</span>
          </Tooltip>
        </div>
      ) : (
        <div className="mcp__row-sub">
          <Tooltip label={it.url} placement="bottom">
            <span className="mcp__url mono">{it.url}</span>
          </Tooltip>
          {hasTools && (
            <button
              type="button"
              className={`mcp__tools-toggle mono${toolsOpen ? ' mcp__tools-toggle--open' : ''}`}
              aria-expanded={toolsOpen}
              onClick={() => setToolsOpen((v) => !v)}
            >
              {it.tools.length} 个工具
              <ChevronDown size={11} aria-hidden />
            </button>
          )}
        </div>
      )}

      <div className="mcp__row-actions">
        <Tooltip label="重连">
          <button
            type="button"
            className="mcp__iconbtn"
            aria-label="重连"
            disabled={!it.enabled || it.status === 'connecting'}
            onClick={onReconnect}
          >
            <RefreshCw size={13} className={it.status === 'connecting' ? 'spin' : undefined} />
          </button>
        </Tooltip>
        <Tooltip label="编辑">
          <button type="button" className="mcp__iconbtn" aria-label="编辑" onClick={onEdit}>
            <Pencil size={13} />
          </button>
        </Tooltip>
        <Tooltip label={armed ? '再点一次即删除' : '删除'}>
          <button
            type="button"
            className={`mcp__iconbtn mcp__iconbtn--danger${armed ? ' mcp__iconbtn--armed' : ''}`}
            aria-label={armed ? '确认删除' : '删除'}
            onClick={() => {
              if (armed) { setArmed(false); onRemove(); } else { setArmed(true); }
            }}
          >
            <Trash2 size={13} />
          </button>
        </Tooltip>
      </div>

      {toolsOpen && (
        <div className="mcp__tools">
          {it.tools.map((t) => (
            <Tooltip key={t.exposedName} label={t.description ?? t.name}>
              <span className="mcp__tool mono">{t.exposedName}</span>
            </Tooltip>
          ))}
        </div>
      )}
    </div>
  );
}
