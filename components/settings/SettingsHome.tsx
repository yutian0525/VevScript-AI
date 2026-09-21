// components/settings/SettingsHome.tsx
// 设置列表页：入口卡片按能力域分组（大标题行划分），点卡走 onOpen 切二级页。
import { SlidersHorizontal, SquareTerminal, FlaskConical, ChevronRight, Sparkles, ScrollText, Brain, ShieldOff, Info } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Tooltip } from '../ui/Tooltip';
import { useTruncated } from '../ui/useTruncated';

export type SettingsSub = 'model' | 'prompt' | 'memory' | 'toolbench' | 'scriptdebug' | 'skills' | 'hookexclusions' | 'about';

type Entry = { key: SettingsSub; title: string; desc: string; Icon: typeof SlidersHorizontal };

// 分组：大标题行划分能力域。每组一个 mono eyebrow + 卡片列表。
const GROUPS: Array<{ label: string; entries: Entry[] }> = [
  {
    label: '模型与会话',
    entries: [
      { key: 'model', title: '模型设置', desc: 'AI 服务地址 / API Key / 模型 / 上下文窗口', Icon: SlidersHorizontal },
      { key: 'prompt', title: '系统提示词', desc: '查看并改写内置系统提示词（Markdown）', Icon: ScrollText },
      { key: 'memory', title: 'AI 记忆', desc: '跨会话长期记忆，AI 自主记录，可人工编辑', Icon: Brain },
      { key: 'skills', title: '技能管理', desc: '导入 .md 技能，注入会话上下文，斜杠指令调用', Icon: Sparkles },
    ],
  },
  {
    label: '隐私与安全',
    entries: [
      { key: 'hookexclusions', title: '敏感站点排除', desc: '风控站（如 Boss直聘）不注入观测 hook，防止被指纹检测拒开', Icon: ShieldOff },
    ],
  },
  {
    label: '开发者工具',
    entries: [
      { key: 'toolbench', title: '工具调试台', desc: '绕过模型，直接对当前页调用全部工具', Icon: SquareTerminal },
      { key: 'scriptdebug', title: '脚本运行时调试台', desc: 'GM API 白名单视图 + 经真实桥链路直调', Icon: FlaskConical },
    ],
  },
  {
    label: '关于',
    entries: [
      { key: 'about', title: '关于软件', desc: '版本信息 / 官网 / 开源仓库 / 问题反馈', Icon: Info },
    ],
  },
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
      {GROUPS.map((group) => (
        <section key={group.label} className="settings-group">
          <h2 className="settings-group__title">{group.label}</h2>
          {group.entries.map(({ key, title, desc, Icon }) => (
            <SettingCard key={key} title={title} desc={desc} Icon={Icon} onOpen={() => onOpen(key)} />
          ))}
        </section>
      ))}
    </PageShell>
  );
}
