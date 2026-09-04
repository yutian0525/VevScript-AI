// components/scriptdebug/ScriptDebugPage.tsx
// 脚本运行时调试台（设置二级页，spec §3）：白名单视图 + GM API 列表 + 经真实桥链路直调。
// 直调 api 用点形式短名（SetValue/XmlHttpRequest…），与 wrapper 实际发出形式一致。
import { useEffect, useState } from 'react';
import { ArrowLeft, ChevronRight, Play, Loader2, Globe, Check, X } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { GM_API_REGISTRY } from '../../shared/gm-apis';
import { sendScriptsRequest } from '../../stores/scripts';
import type { DebugExecResponse, GmDebugInfoData } from '../../shared/messages';
import type { ScriptSummary } from '../../shared/types';
import { ResultPanel, type Outcome } from '../debug/ResultPanel';

type CallKind = 'bridge' | 'sw' | 'page';

/** 14 个 GM API 的直调分类 + 点形式短名（spec §3③）。 */
export const CALL: Record<string, { kind: CallKind; short?: string; hint: string }> = {
  // bridge 7：完整真实链路
  GM_setValue: { kind: 'bridge', short: 'SetValue', hint: '["key", "value"]' },
  GM_deleteValue: { kind: 'bridge', short: 'DeleteValue', hint: '["key"]' },
  GM_registerMenuCommand: { kind: 'bridge', short: 'RegisterMenu', hint: '["cmdKey", "菜单名"]' },
  GM_setClipboard: { kind: 'bridge', short: 'SetClipboard', hint: '["要复制的文本"]' },
  GM_notification: { kind: 'bridge', short: 'Notification', hint: '[{"title":"标题","text":"正文"}, "notifId"]' },
  GM_openInTab: { kind: 'bridge', short: 'OpenInTab', hint: '["https://example.com", {"active":true}]' },
  GM_xmlhttpRequest: { kind: 'bridge', short: 'XmlHttpRequest', hint: '[{"url":"https://api.a.com","method":"GET"}]' },
  // SW 有分支 2：经桥调 SW 的 GetValue/ListValues，返回 storage 实时值（非页面快照）
  GM_getValue: { kind: 'sw', short: 'GetValue', hint: '["key", "默认值"]' },
  GM_listValues: { kind: 'sw', short: 'ListValues', hint: '[]' },
  // 页面内 5：不可远程直调（值快照直嵌 / local 完成）
  GM_info: { kind: 'page', hint: '页面内 API（注入期快照）' },
  GM_getResourceText: { kind: 'page', hint: '页面内 API（注入期资源快照）' },
  GM_addStyle: { kind: 'page', hint: '页面内 API（DOM 本地完成）' },
  GM_log: { kind: 'page', hint: '页面内 API（console 本地完成）' },
  GM_addValueChangeListener: { kind: 'page', hint: '页面内 API（本地注册监听）' },
};

const KIND_NOTE: Record<CallKind, string> = {
  bridge: '完整真实链路（token 校验 → grant 白名单 → handleGmCall → @connect 确认流）',
  sw: '经桥调 SW 分支，返回 storage 实时值（非页面快照）',
  page: '页面内 API，不可远程直调（第一版取舍）',
};

function hostOf(url: string): string {
  try { return new URL(url).host || url; } catch { return url || '—'; }
}

export function ScriptDebugPage({ onBack }: { onBack: () => void }) {
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  const [scriptId, setScriptId] = useState<string>('');
  const [info, setInfo] = useState<GmDebugInfoData | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const resp = await sendScriptsRequest<{ ok: boolean; data?: { scripts: ScriptSummary[] } }>({ type: 'SCRIPTS_LIST' });
        if (cancelled) return;
        const list = resp.data?.scripts ?? [];
        setScripts(list);
        if (list.length > 0 && list[0]) setScriptId(list[0].id);
      } catch {
        if (!cancelled) setScripts([]); // 传输异常维持空态（脚本池为空文案）
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!scriptId) { setInfo(null); return; }
    void (async () => {
      try {
        const resp = await sendScriptsRequest<{ ok: boolean; data?: GmDebugInfoData }>({ type: 'GM_DEBUG_INFO', scriptId });
        if (!cancelled) setInfo(resp.data ?? null);
      } catch {
        if (!cancelled) setInfo(null); // SW 死亡等传输异常：置空回显，不停「加载中」
      }
    })();
    return () => { cancelled = true; };
  }, [scriptId]);

  const targetHost = info ? hostOf(info.tabUrl) : '—';

  return (
    <PageShell
      title="脚本运行时调试台"
      eyebrow="SCRIPTDEBUG"
      right={
        <span className="gauge" title={info?.tabUrl}>
          <Globe size={12} color="var(--ink-3)" />
          <span className="gauge__label mono" style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{targetHost}</span>
        </span>
      }
      actions={<Button variant="ghost" onClick={onBack} aria-label="返回"><ArrowLeft size={14} /></Button>}
    >
      {scripts.length === 0 ? (
        <div className="chat__empty">脚本池为空——先在脚本池新建或导入脚本</div>
      ) : (
        <>
          <div className="field">
            <label className="field-label">目标脚本</label>
            <select className="input" value={scriptId} onChange={(e) => setScriptId(e.target.value)}>
              {scripts.map((s) => <option key={s.id} value={s.id}>{s.name}{s.enabled ? '' : '（已禁用）'}</option>)}
            </select>
          </div>

          <section style={{ marginBottom: 18 }}>
            <div className="toolgroup__head mono">── 白名单视图 ──</div>
            {info == null ? (
              <div className="hint">加载中…</div>
            ) : (
              <div className="gm-whitelist">
                <div className="gm-whitelist__row">
                  <span className={`dot dot--${info.injected ? 'ok' : 'err'}`} />
                  注入态：{info.injected ? '已注入目标页（可直调 bridge/SW 类）' : '未注入目标页（切到 @match 命中的页再调）'}
                </div>
                <div style={{ marginTop: 6 }}>@grant supported：</div>
                {info.grantSupported.length === 0 ? <div className="gm-api-note">（无）</div> :
                  info.grantSupported.map((g) => <div key={g} className="gm-whitelist__row" style={{ color: 'var(--ink-2)' }}><Check size={11} aria-hidden /> {g}</div>)}
                {info.grantUnsupported.length > 0 && (
                  <>
                    <div style={{ marginTop: 6 }}>@grant unsupported（注入期即被拒装）：</div>
                    {info.grantUnsupported.map((g) => <div key={g} className="gm-whitelist__row" style={{ color: 'var(--warn)' }}><X size={11} aria-hidden /> {g}</div>)}
                  </>
                )}
                <div style={{ marginTop: 6 }}>@connect：{info.connects.length > 0 ? info.connects.join('  ') : '（无——仅 self/子域放行，其余弹确认）'}</div>
                <div style={{ marginTop: 2 }}>始终允许主机：{info.alwaysAllow.length > 0 ? info.alwaysAllow.join('  ') : '（无）'}</div>
                <div className="gm-api-note" style={{ margin: '6px 0 0 0' }}>
                  matchConnect 三分支：self/子域放行；列了不中 → DENY；未列 → 查始终允许库，否则弹确认卡。
                </div>
              </div>
            )}
          </section>

          <section>
            <div className="toolgroup__head mono">── GM API 列表 · {Object.keys(GM_API_REGISTRY).length} ──</div>
            <div className="toolgroup__hint">bridge/SW 类可展开填 JSON params 直调；页面内 API 置灰。</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {Object.keys(GM_API_REGISTRY).map((name) => (
                <GmApiRow key={name} name={name} scriptId={scriptId} injected={info?.injected ?? false} />
              ))}
            </div>
          </section>
        </>
      )}
    </PageShell>
  );
}

function GmApiRow({ name, scriptId, injected }: { name: string; scriptId: string; injected: boolean }) {
  const def = GM_API_REGISTRY[name]!;
  const call = CALL[name]!;
  const impl = def.impl.toUpperCase(); // SNAPSHOT / LOCAL / BRIDGE
  const callable = call.kind !== 'page';

  const [open, setOpen] = useState(false);
  const [argsText, setArgsText] = useState(call.hint.startsWith('[') ? call.hint : '[]');
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const run = async () => {
    let params: unknown[];
    try {
      const parsed = argsText.trim() === '' ? [] : JSON.parse(argsText);
      if (!Array.isArray(parsed)) throw new Error('params 必须是 JSON 数组，如 ["key", "value"]');
      params = parsed;
    } catch (e) {
      setOutcome({ kind: 'bad-args', message: e instanceof Error ? e.message : String(e) });
      return;
    }
    setRunning(true);
    setOutcome(null);
    try {
      const resp = await sendScriptsRequest<DebugExecResponse>({ type: 'GM_DEBUG_CALL', scriptId, api: call.short!, params });
      setOutcome({ kind: 'result', resp });
    } catch (e) {
      setOutcome({ kind: 'link-error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className={`gm-api-row${callable ? '' : ' is-disabled'}`}>
      <button className="tool-row" aria-expanded={open} disabled={!callable} onClick={() => callable && setOpen((v) => !v)}>
        <span className="tool-row__head">
          {callable && (
            <ChevronRight size={13} color="var(--ink-3)" style={{ transition: 'transform var(--t-fast) var(--ease)', transform: open ? 'rotate(90deg)' : 'none' }} />
          )}
          <span className="tool-row__name">{name}</span>
          {def.promiseForm && <span className="param__type" style={{ fontSize: 10 }}>Promise</span>}
          <span className={`chip ${call.kind === 'bridge' ? 'chip--net' : call.kind === 'sw' ? 'chip--page' : 'chip--tabs'}`}>{impl}</span>
        </span>
      </button>
      {!callable && <div className="gm-api-note">{call.hint}</div>}
      {open && callable && (
        <div className="rise" style={{ padding: '10px 2px 4px' }}>
          <div className="gm-api-note" style={{ margin: '0 0 8px 0' }}>{KIND_NOTE[call.kind]}</div>
          {!injected && <div className="scripts-warnline">脚本未注入目标页——直调会因查不到 token 报错。</div>}
          <div className="token" style={{ marginBottom: 5 }}>PARAMS · JSON 数组（短名 {call.short}）</div>
          <textarea
            className="textarea mono-input"
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
            spellCheck={false}
            rows={2}
            style={{ marginBottom: 8 }}
          />
          <Button variant="signal" onClick={run} disabled={running || !scriptId}>
            {running ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
            {running ? '执行中…' : '直调'}
          </Button>
          {outcome && <ResultPanel outcome={outcome} />}
        </div>
      )}
    </div>
  );
}
