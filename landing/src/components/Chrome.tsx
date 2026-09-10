import { GithubMark, LogoMark, LogoMono } from './Logo';
import { REPO, type Route } from '../router';

export function Nav({ route }: { route: Route }) {
  return (
    <nav className="nav">
      <div className="shell nav__in">
        <a className="nav__brand" href="#/" aria-label="织雀AI脚本 首页">
          <LogoMark id="nav" size={25} />
          <span className="nav__wordmark">织雀AI脚本</span>
          <span className="nav__sub">Vevscript-ai</span>
        </a>
        <div className="nav__links">
          <a className="nav__link" href="#/" aria-current={route === 'home' ? 'page' : undefined}>
            首页
          </a>
          <a className="nav__link" href="#/docs" aria-current={route === 'docs' ? 'page' : undefined}>
            使用文档
          </a>
          {/* 窄屏只留图标（CSS 隐去 span），故 aria-label 常驻，不靠可见文字承载可访问名 */}
          <a
            className="btn btn--ghost"
            href={REPO}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="在 GitHub 上查看源码"
          >
            <GithubMark size={15} />
            <span>GitHub</span>
          </a>
        </div>
      </div>
    </nav>
  );
}

export function Footer() {
  return (
    <footer className="foot">
      <div className="shell foot__in">
        <span className="foot__brand">
          <LogoMono id="foot" size={17} />
          <span className="foot__t">织雀AI脚本 · Vevscript-ai</span>
        </span>
        <div className="foot__links">
          <a href="#/docs">使用文档</a>
          <a href={REPO} target="_blank" rel="noreferrer noopener">
            源码仓库
          </a>
          <a href={`${REPO}/issues`} target="_blank" rel="noreferrer noopener">
            反馈问题
          </a>
        </div>
      </div>
    </footer>
  );
}
