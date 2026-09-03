// components/settings/SettingsHome.tsx
// 设置列表页（spec §1）：三入口卡片，点卡走 onOpen 切二级页。
import { SlidersHorizontal, SquareTerminal, FlaskConical, ChevronRight } from 'lucide-react';
import { PageShell } from '../ui/PageShell';

export type SettingsSub = 'model' | 'toolbench' | 'scriptdebug';

const ENTRIES: Array<{ key: SettingsSub; title: string; desc: string; Icon: typeof SlidersHorizontal }> = [
  { key: 'model', title: '模型设置', desc: 'AI 服务地址 / API Key / 模型 / 上下文窗口', Icon: SlidersHorizontal },
  { key: 'toolbench', title: '工具调试台', desc: '绕过模型，直接对当前页调用 25 个工具', Icon: SquareTerminal },
  { key: 'scriptdebug', title: '脚本运行时调试台', desc: 'GM API 白名单视图 + 经真实桥链路直调', Icon: FlaskConical },
];

export function SettingsHome({ onOpen }: { onOpen: (sub: SettingsSub) => void }) {
  return (
    <PageShell title="设置" eyebrow="CONFIG">
      {ENTRIES.map(({ key, title, desc, Icon }) => (
        <button key={key} className="setting-card" onClick={() => onOpen(key)}>
          <span className="setting-card__icon"><Icon size={18} strokeWidth={1.8} /></span>
          <span className="setting-card__body">
            <span className="setting-card__title">{title}</span>
            <div className="setting-card__desc">{desc}</div>
          </span>
          <ChevronRight size={16} className="setting-card__chev" aria-hidden />
        </button>
      ))}
    </PageShell>
  );
}
