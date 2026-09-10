import { useEffect, useRef } from 'react';
import { ArrowUp, BrainCircuit, Check, ChevronDown, LoaderCircle } from 'lucide-react';
import { LogoMark } from './Logo';
import type { Line } from '../demo/useRunner';
import type { Scenario } from '../demo/script';

/** 仿真侧边栏：产品真实布局的等比缩影（页眉会话抽屉 + 会话流 + tag + 输入框）。
 *  这是示意装置，不是可用产品，所以 tag 是唯一入口，输入框不收键入。 */
export function DemoPanel({
  lines,
  scenarios,
  activeId,
  phase,
  onPick,
  convTitle,
}: {
  lines: Line[];
  scenarios: Scenario[];
  activeId: string | null;
  convTitle: string;
  phase: 'idle' | 'running' | 'done';
  onPick: (s: Scenario) => void;
}) {
  const streamRef = useRef<HTMLDivElement>(null);

  // 流式期间一律瞬时贴底：smooth 的中间态会和"用户上滚"混淆（产品里踩过同一个坑）
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className="panel" aria-label="织雀AI脚本 侧边栏示意">
      <header className="panel__head">
        <LogoMark id="panel" size={17} />
        <span className="panel__title">织雀</span>
        <button type="button" className="panel__conv" tabIndex={-1} aria-hidden="true">
          {convTitle}
          <ChevronDown size={12} aria-hidden="true" />
        </button>
        <span className="panel__ring" aria-hidden="true">
          <svg viewBox="0 0 20 20" width="15" height="15">
            <circle cx="10" cy="10" r="8" fill="none" stroke="var(--line-strong)" strokeWidth="2.4" />
            <circle
              cx="10"
              cy="10"
              r="8"
              fill="none"
              stroke="var(--signal)"
              strokeWidth="2.4"
              strokeDasharray="50.3"
              strokeDashoffset="38"
              strokeLinecap="round"
              transform="rotate(-90 10 10)"
            />
          </svg>
        </span>
      </header>

      <div className="panel__stream" ref={streamRef} aria-live="polite" aria-relevant="additions">
        {lines.length === 0 && (
          <p className="panel__hint">点下面任意一句，看它怎么把需求变成脚本。</p>
        )}
        {lines.map((l) => (
          <StreamLine key={l.id} line={l} />
        ))}
      </div>

      <div className="panel__foot">
        <div className="panel__tags" role="group" aria-label="示例需求">
          {scenarios.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`ptag${activeId === s.id ? ' ptag--on' : ''}`}
              aria-pressed={activeId === s.id}
              onClick={() => onPick(s)}
            >
              {s.tag}
            </button>
          ))}
        </div>
        <div className="panel__input">
          <span className="panel__ph">
            {phase === 'running' ? '正在执行…' : '说一句需求，回车发送'}
          </span>
          <span className="panel__send" aria-hidden="true">
            <ArrowUp size={13} />
          </span>
        </div>
      </div>
    </div>
  );
}

function StreamLine({ line }: { line: Line }) {
  if (line.kind === 'user') {
    return <div className="bub bub--user">{line.text}</div>;
  }
  if (line.kind === 'reasoning') {
    return (
      <div className={`think${line.live ? ' think--live' : ''}`}>
        <BrainCircuit size={12} className="think__i" aria-hidden="true" />
        <span>{line.text}</span>
      </div>
    );
  }
  if (line.kind === 'tool') {
    return (
      <div className={`tcard tcard--${line.status}`}>
        <div className="tcard__top">
          <span className="tcard__name">{line.name}</span>
          <span className="tcard__st" aria-label={line.status === 'ok' ? '完成' : '执行中'}>
            {line.status === 'ok' ? (
              <Check size={12} aria-hidden="true" />
            ) : (
              <LoaderCircle size={12} className="spin" aria-hidden="true" />
            )}
          </span>
        </div>
        <div className="tcard__args">{line.args}</div>
        {line.status === 'ok' && <div className="tcard__res">{line.result}</div>}
      </div>
    );
  }
  // assistant 正文：`code` 渲染成 mono 芯片，与产品的 Markdown 行内码同构
  return (
    <div className={`bub bub--ai${line.live ? ' bub--live' : ''}`}>
      {line.text.split(/(`[^`]+`)/g).map((seg, i) =>
        seg.startsWith('`') && seg.endsWith('`') && seg.length > 2 ? (
          <code key={i}>{seg.slice(1, -1)}</code>
        ) : (
          <span key={i}>{seg}</span>
        ),
      )}
    </div>
  );
}
