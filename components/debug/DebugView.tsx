// components/debug/DebugView.tsx
// 调试台：列出 agent 可用的全部工具，绕过 LLM 直接对当前标签页发起调用测试。
// 走后台 DEBUG_EXEC_TOOL → handleDebugExec → executeTool（与真实链路完全一致）。
import { useEffect, useState } from 'react';
import { ChevronRight, Play, Loader2, Globe } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { TOOL_SCHEMAS } from '../../agent/tools/schemas';
import type { ToolSchema } from '../../agent/provider/types';
import type { DebugExecResponse } from '../../shared/messages';

// 走 content script 的工具（其余走 chrome tabs API）——与 registry.CS_TOOL_MAP 对齐
const CS_TOOLS = new Set(['take_snapshot', 'click', 'fill', 'fill_form', 'hover', 'scroll', 'press_key', 'wait_for']);

interface JsonSchema {
  type?: string;
  description?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

function placeholderFor(s: JsonSchema): unknown {
  if (s.enum?.length) return s.enum[0];
  switch (s.type) {
    case 'number': return 0;
    case 'string': return '';
    case 'boolean': return false;
    case 'array': return [];
    case 'object': return {};
    default: return null;
  }
}

/** 从 schema 的 required 生成参数骨架 JSON（可选参数留空，用户按需补） */
function skeletonOf(params: JsonSchema): string {
  const props = params.properties ?? {};
  const obj: Record<string, unknown> = {};
  for (const key of params.required ?? []) obj[key] = placeholderFor(props[key] ?? {});
  return JSON.stringify(obj, null, 2);
}

async function activeTabId(): Promise<number | undefined> {
  let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id;
}

export function DebugView() {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [targetHost, setTargetHost] = useState<string>('—');

  useEffect(() => {
    const resolve = async () => {
      const id = await activeTabId();
      if (id == null) { setTargetHost('—'); return; }
      const tab = await browser.tabs.get(id).catch(() => undefined);
      try {
        setTargetHost(tab?.url ? new URL(tab.url).host || tab.url : '—');
      } catch {
        setTargetHost(tab?.url ?? '—');
      }
    };
    void resolve();
    const onActivate = () => void resolve();
    browser.tabs.onActivated.addListener(onActivate);
    browser.tabs.onUpdated.addListener(onActivate);
    return () => {
      browser.tabs.onActivated.removeListener(onActivate);
      browser.tabs.onUpdated.removeListener(onActivate);
    };
  }, []);

  return (
    <PageShell
      title="调试台"
      eyebrow="TOOLBENCH"
      right={
        <span className="gauge" title={targetHost}>
          <Globe size={12} color="var(--ink-3)" />
          <span className="gauge__label mono" style={{ maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {targetHost}
          </span>
        </span>
      }
    >
      <div className="hint" style={{ marginBottom: 14 }}>
        直接对当前标签页调用工具，不经模型。共 {TOOL_SCHEMAS.length} 个工具。
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {TOOL_SCHEMAS.map((tool) => (
          <ToolItem
            key={tool.function.name}
            tool={tool}
            open={expanded === tool.function.name}
            onToggle={() => setExpanded((cur) => (cur === tool.function.name ? null : tool.function.name))}
          />
        ))}
      </div>
    </PageShell>
  );
}

type Outcome =
  | { kind: 'bad-args'; message: string }
  | { kind: 'link-error'; message: string }
  | { kind: 'result'; resp: DebugExecResponse };

function ToolItem({ tool, open, onToggle }: { tool: ToolSchema; open: boolean; onToggle: () => void }) {
  const params = tool.function.parameters as JsonSchema;
  const props = params.properties ?? {};
  const required = new Set(params.required ?? []);
  const keys = Object.keys(props);
  const isCs = CS_TOOLS.has(tool.function.name);

  const [argsText, setArgsText] = useState(() => skeletonOf(params));
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const run = async () => {
    let args: Record<string, unknown>;
    try {
      const parsed = argsText.trim() === '' ? {} : JSON.parse(argsText);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('参数必须是 JSON 对象');
      }
      args = parsed as Record<string, unknown>;
    } catch (e) {
      setOutcome({ kind: 'bad-args', message: e instanceof Error ? e.message : String(e) });
      return;
    }
    setRunning(true);
    setOutcome(null);
    const tabId = await activeTabId();
    if (tabId == null) {
      setRunning(false);
      setOutcome({ kind: 'link-error', message: '无法获取当前标签页，请切到普通网页后重试' });
      return;
    }
    try {
      const resp = (await browser.runtime.sendMessage({
        type: 'DEBUG_EXEC_TOOL',
        tabId,
        name: tool.function.name,
        args,
      })) as DebugExecResponse;
      setOutcome({ kind: 'result', resp });
    } catch (e) {
      setOutcome({ kind: 'link-error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <button className="tool-row" aria-expanded={open} onClick={onToggle}>
        <span className="tool-row__head">
          <ChevronRight
            size={13}
            color="var(--ink-3)"
            style={{ transition: 'transform var(--t-fast) var(--ease)', transform: open ? 'rotate(90deg)' : 'none' }}
          />
          <span className="tool-row__name">{tool.function.name}</span>
          <span className={`chip ${isCs ? 'chip--cs' : 'chip--api'}`}>{isCs ? 'PAGE' : 'TABS'}</span>
        </span>
        {!open && <span className="tool-row__desc" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tool.function.description}</span>}
      </button>

      {open && (
        <div className="rise" style={{ padding: '10px 2px 4px' }}>
          <p className="tool-row__desc" style={{ margin: '0 0 10px' }}>{tool.function.description}</p>

          {keys.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div className="token" style={{ marginBottom: 5 }}>PARAMS</div>
              {keys.map((k) => (
                <div className="param" key={k}>
                  <span className="param__key">{k}</span>
                  <span className="param__type">{props[k]?.enum ? props[k]!.enum!.join('|') : props[k]?.type ?? '?'}</span>
                  {required.has(k) && <span className="param__req">*必填</span>}
                  {props[k]?.description && <span className="param__desc">{props[k]!.description}</span>}
                </div>
              ))}
            </div>
          )}

          <div className="token" style={{ marginBottom: 5 }}>ARGS · JSON</div>
          <textarea
            className="textarea mono-input"
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
            spellCheck={false}
            rows={Math.min(8, Math.max(2, argsText.split('\n').length))}
            style={{ marginBottom: 8 }}
          />
          <Button variant="signal" onClick={run} disabled={running}>
            {running ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
            {running ? '执行中…' : '运行'}
          </Button>

          {outcome && <ResultPanel outcome={outcome} />}
        </div>
      )}
    </div>
  );
}

function formatData(data: unknown): string {
  if (data == null) return '(无返回数据)';
  if (typeof data === 'string') return data; // 快照树等长文本直接展示
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

function ResultPanel({ outcome }: { outcome: Outcome }) {
  let ok = false;
  let ms: number | null = null;
  let body: string;

  if (outcome.kind === 'bad-args') {
    body = `参数解析失败：${outcome.message}`;
  } else if (outcome.kind === 'link-error') {
    body = `链路异常：${outcome.message}`;
  } else {
    const { resp } = outcome;
    ms = resp.ms;
    if (!resp.dispatched) {
      body = `链路异常：${resp.error ?? '未知错误'}`;
    } else if (resp.result?.ok) {
      ok = true;
      body = formatData(resp.result.data);
    } else {
      body = resp.result?.error ?? '工具返回失败（无错误信息）';
    }
  }

  return (
    <div className="rise" style={{ marginTop: 12 }}>
      <div className="result-head">
        <span className={`dot dot--${ok ? 'ok' : 'err'}`} />
        <span className={`result-verdict ${ok ? 'result-verdict--ok' : 'result-verdict--err'}`}>
          {ok ? 'OK' : 'ERR'}
        </span>
        {ms != null && <span className="result-ms">{ms} ms</span>}
      </div>
      <div className="well" style={{ maxHeight: 260 }}>{body}</div>
    </div>
  );
}
