// components/detail/DetailTabHeader.tsx
// Tab 节头：h2 主标题 + 可选 mono 弱化后缀 + 灰副题（spec §2）。
export function DetailTabHeader({ title, suffix, hint }: { title: string; suffix?: string; hint: string }) {
  return (
    <div className="detail__thead">
      <h2 className="detail__title">
        {title}
        {suffix != null && <span className="detail__suffix mono">{suffix}</span>}
      </h2>
      <p className="detail__hint">{hint}</p>
    </div>
  );
}
