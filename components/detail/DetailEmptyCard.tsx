// components/detail/DetailEmptyCard.tsx
// 左对齐空态卡：浅底圆角卡 + 图标 + 主文案 + 副文案（spec §2）。
import type { LucideIcon } from 'lucide-react';

export function DetailEmptyCard({ icon: Icon, title, hint }: { icon: LucideIcon; title: string; hint: string }) {
  return (
    <div className="detail__empty">
      <span className="detail__empty-icon"><Icon size={16} aria-hidden /></span>
      <span className="detail__empty-title">{title}</span>
      <span className="detail__empty-hint">{hint}</span>
    </div>
  );
}
