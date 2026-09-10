// components/settings/AboutPage.tsx
// 关于软件二级页：品牌块（居中）+ 版本 + 官网 / GitHub / 问题反馈外链行。
import { Globe, LifeBuoy, ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { PageShell } from '../ui/PageShell';
import { Brand, GithubMark } from '../ui/Brand';
import { BRAND } from '../../shared/brand';

const LINKS: Array<{ url: string; label: string; hint: string; icon: ReactNode }> = [
  { url: BRAND.site, label: '官方网站', hint: 'vevscript.yutkit.com', icon: <Globe size={17} strokeWidth={1.8} /> },
  { url: BRAND.repo, label: '开源仓库', hint: 'GitHub · yutian0525/VevScript-AI', icon: <GithubMark size={16} /> },
  { url: BRAND.issues, label: '问题反馈', hint: '提交 Issue，报告 bug 或提需求', icon: <LifeBuoy size={17} strokeWidth={1.8} /> },
];

export function AboutPage({ onBack }: { onBack: () => void }) {
  const version = browser.runtime.getManifest().version;
  return (
    <PageShell title="关于软件" eyebrow="ABOUT" onBack={onBack} backLabel="返回设置">
      <div className="about__hero">
        <Brand layout="stacked" size={44} id="about" />
        <div className="about__tagline">在侧边栏说一句话，AI 就在当前网页上替你做完。</div>
        <span className="about__version mono">v{version}</span>
      </div>

      <section className="section">
        <h2 className="section__title">链接</h2>
        <div className="about__links">
          {LINKS.map((l) => (
            <button
              key={l.url}
              type="button"
              className="about__link"
              onClick={() => void browser.tabs.create({ url: l.url })}
            >
              <span className="about__link-icon">{l.icon}</span>
              <span className="about__link-body">
                <span className="about__link-label">{l.label}</span>
                <span className="about__link-hint">{l.hint}</span>
              </span>
              <ExternalLink size={15} className="about__link-ext" aria-hidden />
            </button>
          ))}
        </div>
      </section>
    </PageShell>
  );
}
