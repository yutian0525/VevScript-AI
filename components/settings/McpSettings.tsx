// components/settings/McpSettings.tsx
// MCP 服务器设置二级页：增删改 / 启停 / 试连 / 导入导出。
// 能力边界写在页首提示里：浏览器扩展起不了本地进程，只有 http(s) 的 MCP 服务能连。
import { useEffect, useRef, useState } from 'react';
import { Plug, Plus, RefreshCw, Pencil, Trash2, Upload, Download } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Tooltip } from '../ui/Tooltip';
import { useMcp } from '../../stores/mcp';
import { newMcpServer } from '../../storage/mcp';
import type { McpServerConfig, McpStatusItem, McpTransport } from '../../shared/mcp';

const TRANSPORT_LABELS: Record<McpTransport, string> = {
  auto: '自动探测（先 Streamable HTTP，失败回退 HTTP+SSE）',
  streamable: 'Streamable HTTP（2025-06-18）',
  sse: 'HTTP + SSE（2024-11-05）',
};

const STATUS_LABEL: Record<McpStatusItem['status'], string> = {
  connected: '已连接',
  connecting: '连接中',
  idle: '未连接',
  error: '异常',
  disabled: '已禁用',
};

type HeaderRow = { key: string; value: string };

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
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { void refresh(); }, [refresh]);

  const openNew = () => {
    setEditing(newMcpServer());
    setRows([{ key: '', value: '' }]);
    setNotice(null);
  };

  const openEdit = (it: McpStatusItem) => {
    setEditing({
      id: it.id, name: it.name, url: it.url, transport: it.transport,
      enabled: it.enabled, headers: {}, // 头不在状态里下发，编辑时留空以免覆盖成空
    });
    setRows([{ key: '', value: '' }]);
    setNotice(null);
  };

  const submit = async () => {
    if (!editing) return;
    setBusy(true);
    setNotice(null);
    try {
      await save({ ...editing, headers: rowsToHeaders(rows) });
      setEditing(null);
      setNotice({ text: '已保存', kind: 'ok' });
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : String(e), kind: 'err' });
    } finally {
      setBusy(false);
    }
  };

  const testCurrent = async () => {
    if (!editing) return;
    setBusy(true);
    setNotice(null);
    try {
      const r = await test({ ...editing, headers: rowsToHeaders(rows) });
      setNotice({ text: `连接成功：${r.tools} 个工具${r.protocolVersion ? ` · ${r.protocolVersion}` : ''}`, kind: 'ok' });
    } catch (e) {
      setNotice({ text: `连接失败：${e instanceof Error ? e.message : String(e)}`, kind: 'err' });
    } finally {
      setBusy(false);
    }
  };

  const doExport = async () => {
    try {
      const text = await exportJson();
      const url = `data:application/json;charset=utf-8,${encodeURIComponent(text)}`;
      await browser.downloads.download({ url, filename: 'mcp-servers.json', saveAs: true });
      setNotice({ text: '已导出 mcp-servers.json', kind: 'ok' });
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : String(e), kind: 'err' });
    }
  };

  const doImport = async (file: File | undefined) => {
    if (!file) return;
    try {
      const r = await importJson(await file.text());
      const extra = r.warnings.length ? `；${r.warnings.length} 条跳过：${r.warnings[0]}` : '';
      setNotice({ text: `已导入 ${r.imported} 台${extra}`, kind: 'ok' });
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : String(e), kind: 'err' });
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <PageShell title="MCP 服务器" eyebrow="MCP" onBack={onBack}>
      <p className="hint" style={{ marginTop: 0, marginBottom: 14 }}>
        把外部 MCP 服务的工具交给 AI 使用。<strong>只支持 http(s) 的 MCP 服务</strong>——浏览器扩展无法启动本地 stdio 进程，
        <span className="mono">command</span> 形式的配置导入时会被跳过。
      </p>

      <section className="section">
        <div className="mcp__head">
          <h2 className="section__title" style={{ margin: 0 }}>已配置（{items.length}）</h2>
          <div className="mcp__head-actions">
            <Button onClick={() => void refresh()}>刷新</Button>
            <Button variant="primary" onClick={openNew}>
              <Plus size={14} /> 新增
            </Button>
          </div>
        </div>

        {items.length === 0 ? (
          <div className="mcp__empty">
            <Plug size={18} />
            <span>还没有 MCP 服务器。点「新增」填一个 http(s) 地址即可。</span>
          </div>
        ) : (
          <div className="mcp__card">
            {items.map((it) => (
              <div key={it.id} className="mcp__row">
                <span className={`mcp__dot mcp__dot--${it.status}`} aria-hidden />
                <div className="mcp__row-main">
                  <div className="mcp__row-title">
                    <span className="mcp__name">{it.name}</span>
                    <span className="mcp__status">{STATUS_LABEL[it.status]}</span>
                  </div>
                  <Tooltip label={it.url}>
                    <span className="mono mcp__url">{it.url}</span>
                  </Tooltip>
                  {it.status === 'error' && it.error && (
                    <Tooltip label={it.error}>
                      <span className="mcp__err">{it.error}</span>
                    </Tooltip>
                  )}
                  <span className="mcp__meta mono">
                    {it.tools.length} 个工具
                    {it.protocolVersion ? ` · ${it.protocolVersion}` : ''}
                    {it.serverInfo?.name ? ` · ${it.serverInfo.name}` : ''}
                  </span>
                </div>
                <div className="mcp__row-actions">
                  <Tooltip label={it.enabled ? '禁用（不下发工具）' : '启用'}>
                    <button
                      type="button"
                      className={`switch${it.enabled ? ' switch--on' : ''}`}
                      aria-label={it.enabled ? '禁用' : '启用'}
                      aria-pressed={it.enabled}
                      onClick={() => void setEnabled(it.id, !it.enabled)}
                    >
                      <span className="switch__thumb" aria-hidden />
                    </button>
                  </Tooltip>
                  <Tooltip label="重连">
                    <button
                      type="button"
                      className="mcp__iconbtn"
                      aria-label="重连"
                      disabled={!it.enabled}
                      onClick={() => void connect(it.id)}
                    >
                      <RefreshCw size={14} />
                    </button>
                  </Tooltip>
                  <Tooltip label="编辑">
                    <button type="button" className="mcp__iconbtn" aria-label="编辑" onClick={() => openEdit(it)}>
                      <Pencil size={14} />
                    </button>
                  </Tooltip>
                  <Tooltip label="删除">
                    <button type="button" className="mcp__iconbtn mcp__iconbtn--danger" aria-label="删除" onClick={() => void remove(it.id)}>
                      <Trash2 size={14} />
                    </button>
                  </Tooltip>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {editing && (
        <section className="section">
          <h2 className="section__title">{editing.name ? `编辑「${editing.name}」` : '新增 MCP 服务器'}</h2>
          <div className="mcp__card mcp__card--stack">
            <div className="field">
              <label className="field-label">名称</label>
              <Input
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="filesystem"
              />
              <span className="hint">决定工具名前缀（mcp__&lt;名称&gt;__&lt;工具&gt;）。留空或用纯中文会退化成 id。</span>
            </div>
            <div className="field">
              <label className="field-label">服务地址</label>
              <Input
                value={editing.url}
                onChange={(e) => setEditing({ ...editing, url: e.target.value })}
                placeholder="https://mcp.example.com/mcp"
                className="mono-input"
              />
            </div>
            <div className="field">
              <label className="field-label">传输方式</label>
              <select
                className="input"
                value={editing.transport}
                onChange={(e) => setEditing({ ...editing, transport: e.target.value as McpTransport })}
              >
                {(Object.keys(TRANSPORT_LABELS) as McpTransport[]).map((t) => (
                  <option key={t} value={t}>{TRANSPORT_LABELS[t]}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label">自定义请求头（选填）</label>
              {rows.map((r, i) => (
                <div key={i} className="mcp__kv">
                  <Input
                    value={r.key}
                    placeholder="Authorization"
                    className="mcp__kv-key mono-input"
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
                  />
                  <Input
                    value={r.value}
                    placeholder="Bearer sk-…"
                    className="mono-input"
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                  />
                  <button
                    type="button"
                    className="mcp__iconbtn"
                    aria-label="删除该请求头"
                    onClick={() => setRows(rows.length === 1 ? [{ key: '', value: '' }] : rows.filter((_, j) => j !== i))}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              <Button onClick={() => setRows([...rows, { key: '', value: '' }])}>+ 请求头</Button>
              <span className="hint">用于 Bearer token / API Key 等鉴权。值里不能含换行。</span>
            </div>
            <div className="mcp__form-actions">
              <Button variant="primary" onClick={() => void submit()} disabled={busy}>保存</Button>
              <Button onClick={() => void testCurrent()} disabled={busy}>测试连接</Button>
              <Button variant="ghost" onClick={() => setEditing(null)}>取消</Button>
            </div>
          </div>
        </section>
      )}

      <section className="section">
        <h2 className="section__title">导入 / 导出</h2>
        <div className="mcp__form-actions">
          <Button onClick={() => fileRef.current?.click()}>
            <Upload size={14} /> 导入 JSON
          </Button>
          <Button onClick={() => void doExport()} disabled={items.length === 0}>
            <Download size={14} /> 导出 JSON
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => { void doImport(e.target.files?.[0]); }}
          />
        </div>
        <span className="hint">兼容 Claude Desktop 的 <span className="mono">{"{ mcpServers: {...} }"}</span> 格式；stdio（command）条目会被跳过并提示。</span>
      </section>

      {notice && (
        <div className="field" style={{ marginTop: 4 }}>
          <span className={`status-text ${notice.kind === 'ok' ? 'status-text--ok' : 'status-text--err'}`}>
            {notice.text}
          </span>
        </div>
      )}
    </PageShell>
  );
}
