// components/chat/SlashMenu.tsx
// 斜杠浮层展示组件（spec §3）：候选列表 + 高亮 + 点击补全。键盘导航在 ChatView（slash.ts 纯函数）。
import { useEffect, useRef } from 'react';
import type { SkillSummary } from '../../shared/types';

export function SlashMenu({ candidates, hi, onSelect }: {
  candidates: SkillSummary[];
  hi: number;
  onSelect: (command: string) => void;
}) {
  const hiRef = useRef<HTMLButtonElement | null>(null);

  // 高亮项滚入视野（block:nearest 不牵动外层滚动祖先）
  useEffect(() => {
    hiRef.current?.scrollIntoView({ block: 'nearest' });
  }, [hi]);

  return (
    <div className="slash-menu" role="listbox" aria-label="技能候选">
      {candidates.map((s, i) => (
        <button
          key={s.id}
          ref={i === hi ? hiRef : undefined}
          type="button"
          role="option"
          aria-selected={i === hi}
          className={`slash-menu__item${i === hi ? ' slash-menu__item--hi' : ''}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSelect(s.command)}
        >
          <span className="slash-menu__cmd mono">/{s.command}</span>
          <span className="slash-menu__name">{s.name}</span>
          {s.description && <span className="slash-menu__desc">{s.description}</span>}
        </button>
      ))}
    </div>
  );
}
