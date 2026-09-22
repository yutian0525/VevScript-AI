// components/convdebug/TurnTimeline.tsx
// 轮次时间线（spec §6.3）：一轮一个折叠块，头部是元数据，展开是上下文/LLM/工具/压缩四段。
import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { TurnTrace } from '../../storage/traces';
import { formatChars, formatMs, formatTokens, outcomeClass } from './convdebug-utils';

export function TurnTimeline({ turns }: { turns: TurnTrace[] }) {
  // 只记「用户手动改过」的轮次，最近一轮的默认展开由 lastTurn 推导——
  // 这样 turns 异步到达后默认展开仍然生效，不需要 effect 补状态。
  const lastTurn = turns[turns.length - 1]?.turn;
  const [toggled, setToggled] = useState<Record<number, boolean>>({});
  const isOpen = (t: number) => toggled[t] ?? (t === lastTurn);

  if (turns.length === 0) {
    return <p className="convdebug__empty">这个会话还没有 loop 记录（trace 从本功能上线后开始记录）</p>;
  }

  return (
    <div className="convdebug-timeline">
      {turns.map((t) => {
        const expanded = isOpen(t.turn);
        return (
          <section key={t.turn} className={`convdebug-turn ${outcomeClass(t.outcome)}`}>
            <button
              type="button"
              className="convdebug-turn__head"
              aria-expanded={expanded}
              onClick={() => setToggled((s) => ({ ...s, [t.turn]: !expanded }))}
            >
              <ChevronRight
                size={14}
                className={`convdebug-turn__chev${expanded ? ' convdebug-turn__chev--open' : ''}`}
                aria-hidden
              />
              <span className="convdebug-turn__no mono">#{t.turn}</span>
              <span className="convdebug-turn__stat mono">{formatMs(t.endedAt - t.startedAt)}</span>
              <span className="convdebug-turn__stat mono">LLM {formatMs(t.llm.ms)}</span>
              <span className="convdebug-turn__stat mono">
                {formatTokens(t.llm.usage?.promptTokens, t.llm.usage?.completionTokens)}
              </span>
              <span className="convdebug-turn__stat mono">{t.tools.length} 工具</span>
              <span className="convdebug-turn__outcome mono">{t.outcome}</span>
            </button>

            {expanded && (
              <div className="convdebug-turn__body">
                <dl className="convdebug-grid">
                  <dt>上下文</dt>
                  <dd className="mono">
                    {t.context.messageCount} 条 · {formatChars(t.context.chars)} · 摘要{' '}
                    {t.context.hasSummary ? formatChars(t.context.summaryChars) : '无'} · 技能 {t.context.skillCount} · 系统提示词{' '}
                    {formatChars(t.context.systemPromptChars)}
                  </dd>
                  <dt>页面</dt>
                  <dd className="mono">{t.context.pageUrl || '—'}</dd>
                  <dt>模式</dt>
                  <dd className="mono">{t.mode ?? '—'} · tab {t.tabId}</dd>
                  <dt>LLM</dt>
                  <dd className="mono">
                    TTFT {t.llm.firstTokenMs != null ? formatMs(t.llm.firstTokenMs) : '—'} · {t.llm.finishReason || '—'} · 正文{' '}
                    {formatChars(t.llm.textChars)} · reasoning {formatChars(t.llm.reasoningChars)}
                  </dd>
                  {t.llm.error && (
                    <>
                      <dt>错误</dt>
                      <dd className="mono convdebug-bad">{t.llm.error}</dd>
                    </>
                  )}
                  {t.compact && (
                    <>
                      <dt>压缩</dt>
                      <dd className="mono">
                        {formatMs(t.compact.ms)} · {t.compact.ok ? '成功' : '未生效'}
                        {t.compact.newPromptTokens != null ? ` · 压缩后 ${t.compact.newPromptTokens} tok` : ''}
                      </dd>
                    </>
                  )}
                  {t.guardReason && (
                    <>
                      <dt>熔断</dt>
                      <dd className="mono convdebug-bad">{t.guardReason}</dd>
                    </>
                  )}
                </dl>

                {t.tools.length > 0 && (
                  <table className="convdebug-tools">
                    <thead>
                      <tr>
                        <th>工具</th>
                        <th>参数</th>
                        <th>耗时</th>
                        <th>结果</th>
                      </tr>
                    </thead>
                    <tbody>
                      {t.tools.map((tool) => (
                        <tr key={tool.callId} className={tool.ok ? '' : 'convdebug-bad'}>
                          <td className="mono">
                            {tool.name}
                            {tool.confirm && <span title={`确认 ${tool.confirm}`}>·{tool.confirm}</span>}
                          </td>
                          <td className="mono">{tool.argsBytes}B</td>
                          <td className="mono">{formatMs(tool.ms)}</td>
                          <td>{tool.ok ? tool.summary : (tool.error ?? tool.summary)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
