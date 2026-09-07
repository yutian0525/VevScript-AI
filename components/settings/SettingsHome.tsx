// components/settings/SettingsHome.tsx
// 设置列表页（spec §1）：四入口卡片，点卡走 onOpen 切二级页。
import { SlidersHorizontal, SquareTerminal, FlaskConical, ChevronRight, Sparkles, ScrollText } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Tooltip } from '../ui/Tooltip';
import { useTruncated } from '../ui/useTruncated';

export type SettingsSub = 'model' | 'prompt' | 'toolbench' | 'scriptdebug' | 'skills';

const ENTRIES: Array<{ key: SettingsSub; title: string; desc: string; Icon: typeof SlidersHorizontal }> = [
  { key: 'model', title: '模型设置', desc: 'AI 服务地址 / API Key / 模型 / 上下文窗口', Icon: SlidersHorizontal },
  { key: 'prompt', title: '系统提示词', desc: '查看并改写内置系统提示词（Markdown）', Icon: ScrollText },
  { key: 'toolbench', title: '工具调试台', desc: '绕过模型，直接对当前页调用 25 个工具', Icon: SquareTerminal },
  { key: 'scriptdebug', title: '脚本运行时调试台', desc: 'GM API 白名单视图 + 经真实桥链路直调', Icon: FlaskConical },
  { key: 'skills', title: '技能管理', desc: '导入 .md 技能，注入会话上下文，斜杠指令调用', Icon: Sparkles },
];

function SettingCard({
  title, desc, Icon, onOpen,
}: { title: string; desc: string; Icon: typeof SlidersHorizontal; onOpen: () => void }) {
  // 只有真被截断才挂 tooltip：短简述不该弹一个和眼前一模一样的提示
  const [descRef, truncated] = useTruncated<HTMLDivElement>(desc);
  return (
    <button className="setting-card" onClick={onOpen}>
      <span className="setting-card__icon"><Icon size={18} strokeWidth={1.8} /></span>
      <span className="setting-card__body">
        <span className="setting-card__title">{title}</span>
        <Tooltip label={desc} disabled={!truncated}>
          <div className="setting-card__desc" ref={descRef}>{desc}</div>
        </Tooltip>
      </span>
      <ChevronRight size={16} className="setting-card__chev" aria-hidden />
    </button>
  );
}

export function SettingsHome({ onOpen }: { onOpen: (sub: SettingsSub) => void }) {
  return (
    <PageShell title="设置" eyebrow="CONFIG">
      {ENTRIES.map(({ key, title, desc, Icon }) => (
        <SettingCard key={key} title={title} desc={desc} Icon={Icon} onOpen={() => onOpen(key)} />
      ))}
    </PageShell>
  );
}
