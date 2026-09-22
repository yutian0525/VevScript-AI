// components/settings/AboutPage.tsx
// 关于软件二级页：品牌块（居中）+ 更新区块 + 官网 / GitHub / 问题反馈 / 协议外链行。
// 更新区块消费 background/ext-update.ts 的检查状态：手动「检查更新」+ 新版引导卡
//（纯自分发下替换本体必然人工：下载 zip → 解压覆盖原目录 → chrome://extensions 刷新）。
import { useEffect, useState } from 'react';
import { Download, RefreshCw, LifeBuoy, ExternalLink, Scale, Globe } from 'lucide-react';
import type { ReactNode } from 'react';
import { PageShell } from '../ui/PageShell';
import { Brand, GithubMark } from '../ui/Brand';
import { BRAND } from '../../shared/brand';
import { sendExtUpdateRequest } from '../../stores/ui';
import type { ExtUpdateState } from '../../shared/types';
import type { ExtUpdateStateEvent } from '../../shared/messages';

const LINKS: Array<{ url: string; label: string; hint: string; icon: ReactNode }> = [
  { url: BRAND.site, label: '官方网站', hint: 'vevscript.yutkit.com', icon: <Globe size={17} strokeWidth={1.8} /> },
  { url: BRAND.repo, label: '开源仓库', hint: 'GitHub · yutian0525/VevScript-AI', icon: <GithubMark size={16} /> },
  { url: BRAND.issues, label: '问题反馈', hint: '提交 Issue，报告 bug 或提需求', icon: <LifeBuoy size={17} strokeWidth={1.8} /> },
  { url: BRAND.license, label: '开源协议', hint: 'MIT License', icon: <Scale size={17} strokeWidth={1.8} /> },
];

export function AboutPage({ onBack }: { onBack: () => void }) {
  const version = browser.runtime.getManifest().version;
  const [update, setUpdate] = useState<ExtUpdateState | null>(null);
  const [checking, setChecking] = useState(false);

  // 挂载读当前状态 + 订阅广播（后台节流检查在页面开着时也能把状态推过来）
  useEffect(() => {
    void sendExtUpdateRequest<{ ok: boolean; data?: ExtUpdateState | null }>({ type: 'EXT_UPDATE_GET' })
      .then((resp) => { if (resp?.ok) setUpdate(resp.data ?? null); })
      .catch(() => {});
    const onMessage = (msg: unknown) => {
      if ((msg as { type?: string })?.type === 'EXT_UPDATE_STATE') {
        setUpdate((msg as ExtUpdateStateEvent).update);
      }
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, []);

  const check = async () => {
    setChecking(true);
    try {
      const resp = await sendExtUpdateRequest<{ ok: boolean; data?: ExtUpdateState }>({ type: 'EXT_UPDATE_CHECK' });
      if (resp?.ok) setUpdate(resp.data ?? null);
    } finally {
      setChecking(false);
    }
  };

  const download = () => {
    if (update?.zipUrl) void browser.downloads.download({ url: update.zipUrl });
  };

  return (
    <PageShell title="关于软件" eyebrow="ABOUT" onBack={onBack} backLabel="返回设置">
      <div className="about__hero">
        <Brand layout="stacked" size={44} id="about" />
        <div className="about__tagline">在侧边栏说一句话，AI 就在当前网页上替你做完。</div>
        <span className="about__version mono">v{version}</span>
      </div>

      <section className="section">
        <h2 className="section__title">更新</h2>
        <div className="about__update">
          {update?.status === 'available' ? (
            <div className="about__update-card">
              <div className="about__update-head">
                <span className="about__update-ver mono">v{update.remoteVersion} 可更新</span>
                <button type="button" className="btn btn--signal" onClick={download}>
                  <Download size={14} strokeWidth={1.8} aria-hidden /> 下载新版
                </button>
              </div>
              {update.notes ? <div className="about__update-notes">{update.notes}</div> : null}
              <ol className="about__update-steps">
                <li>解压后<strong>覆盖原扩展目录</strong>（目录不能挪位置，路径即扩展身份）</li>
                <li>打开 <span className="mono">chrome://extensions</span>，点本扩展卡片上的「刷新」</li>
                <li>回到本页，版本号即变为新版</li>
              </ol>
            </div>
          ) : (
            <div className="about__update-line">
              <span className="mono">v{version}</span>
              <span>
                {update == null
                  ? '尚未检查过更新'
                  : update.status === 'error'
                    ? `检查失败：${update.message ?? '未知原因'}`
                    : '已是最新版本'}
              </span>
            </div>
          )}
          <div className="about__update-actions">
            <button type="button" className="btn" onClick={() => void check()} disabled={checking}>
              <RefreshCw size={14} strokeWidth={1.8} aria-hidden className={checking ? 'spin' : undefined} /> {checking ? '检查中…' : '检查更新'}
            </button>
            {update != null && (
              <span className="about__update-time">上次检查 {new Date(update.checkedAt).toLocaleString()}</span>
            )}
          </div>
        </div>
      </section>

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
