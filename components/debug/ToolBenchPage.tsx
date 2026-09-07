// components/debug/ToolBenchPage.tsx
// 工具调试台（设置二级页）：按能力域分组列出全部工具（30 个），绕过 LLM 直接对当前标签页调用。
// 走后台 DEBUG_EXEC_TOOL → handleDebugExec → executeTool（与真实链路一致）。
import { useEffect, useState } from 'react';
import { ChevronRight, Play, Loader2, Globe } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { TOOL_SCHEMAS } from '../../agent/tools/schemas';
import type { ToolSchema } from '../../agent/provider/types';
import type { DebugExecResponse } from '../../shared/messages';
import { GROUPS, getTag, CHIP_CLASS, type ToolTag } from './tool-tags';
import { ResultPanel, type Outcome } from './ResultPanel';

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

export function ToolBenchPage({ onBack }: { onBack: () => void }) {
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

  // 按能力域分组（组内保持 TOOL_SCHEMAS 原序）
  const byTag = new Map<ToolTag, ToolSchema[]>();
  for (const t of TOOL_SCHEMAS) {
    const tag = getTag(t.function.name);
    (byTag.get(tag) ?? byTag.set(tag, []).get(tag)!).push(t);
  }

  return (
    <PageShell
      title="工具调试台"
      eyebrow="TOOLBENCH"
      onBack={onBack}
      right={
        <Tooltip label={targetHost}>
          <span className="gauge">
            <Globe size={12} color="var(--ink-3)" />
            <span className="gauge__label mono" style={{ maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {targetHost}
            </span>
          </span>
        </Tooltip>
      }
    >
      <div className="hint" style={{ marginBottom: 14 }}>
        直接对当前标签页调用工具，不经模型。共 {TOOL_SCHEMAS.length} 个工具。
      </div>
      {GROUPS.map((g) => {
        const tools = byTag.get(g.key) ?? [];
        if (tools.length === 0) return null;
        return (
          <section key={g.key} style={{ marginBottom: 18 }}>
            <div className="toolgroup__head mono">── {g.label} {g.key} · {tools.length} ──</div>
            <div className="toolgroup__hint">{g.hint}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {tools.map((tool) => (
                <ToolItem
                  key={tool.function.name}
                  tool={tool}
                  open={expanded === tool.function.name}
                  onToggle={() => setExpanded((cur) => (cur === tool.function.name ? null : tool.function.name))}
                />
              ))}
            </div>
          </section>
        );
      })}
    </PageShell>
  );
}

function ToolItem({ tool, open, onToggle }: { tool: ToolSchema; open: boolean; onToggle: () => void }) {
  const params = tool.function.parameters as JsonSchema;
  const props = params.properties ?? {};
  const required = new Set(params.required ?? []);
  const keys = Object.keys(props);
  const tag = getTag(tool.function.name);

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
        type: 'DEBUG_EXEC_TOOL', tabId, name: tool.function.name, args,
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
          <span className={`chip ${CHIP_CLASS[tag]}`}>{tag}</span>
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
