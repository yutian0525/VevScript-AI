import { ArrowRight, Construction } from 'lucide-react';
import { GithubMark } from '../components/Logo';
import { REPO } from '../router';

/** 文档页当前留空。空态不装作有内容，而是给出目录骨架（说明规划）+ 现成的去处（仓库里的 md）。 */
export function Docs() {
  return (
    <div className="shell docs">
      <div className="docs__grid">
        <div>
          <span className="eyebrow">Documentation</span>
          <h1 className="h-section docs__h" style={{ marginTop: 14 }}>
            使用文档
          </h1>
          <p className="lede" style={{ maxWidth: '58ch' }}>
            这里会放完整的上手教程、GM_* API 参考和排查手册。现在还没搬过来——仓库里已经有能用的版本，先去那边看。
          </p>

          <div className="empty">
            <span className="empty__badge">
              <Construction aria-hidden="true" />
              正在编写
            </span>
            <h2 className="h-card empty__t">这一页还是空的</h2>
            <p className="empty__d">
              文档正在从仓库的 Markdown 整理成网页版。在那之前，<code className="code-inline">README.md</code> 覆盖安装与配置，<code className="code-inline">docs/gm-api.md</code> 是完整的 GM_* API 参考，<code className="code-inline">docs/使用指南.md</code> 有冒烟清单和故障排查。
            </p>
            <div className="empty__actions">
              <a
                className="btn btn--primary"
                href={`${REPO}#readme`}
                target="_blank"
                rel="noreferrer noopener"
              >
                <GithubMark size={15} />
                看仓库文档
              </a>
              <a className="btn btn--ghost" href="#/">
                回首页看演示
                <ArrowRight aria-hidden="true" />
              </a>
            </div>
          </div>

          <ul className="toc" style={{ marginTop: 34 }}>
            {CHAPTERS.map((c, i) => (
              <li key={c}>
                <span className="toc__n">{String(i + 1).padStart(2, '0')}</span>
                <span style={{ flex: 1 }}>{c}</span>
                <span className="toc__s">待写</span>
              </li>
            ))}
          </ul>
        </div>

        <aside className="docs__aside">
          <span className="eyebrow">先读哪一份</span>
          <p>
            只想跑起来 → 仓库 README 的「快速开始」。
            <br />
            <br />
            要写脚本用 GM_* → <code className="code-inline">docs/gm-api.md</code>，29 个函数 grant 逐条带签名和示例。
            <br />
            <br />
            装完不工作 → <code className="code-inline">docs/使用指南.md</code> 末尾的故障排查。
          </p>
        </aside>
      </div>
    </div>
  );
}

const CHAPTERS = [
  '安装与加载扩展',
  '配置模型（Base URL / Key / 上下文窗口）',
  '让 AI 写第一个脚本',
  '脚本池：启停、编辑、导入导出、更新检查',
  'GM_* API 参考',
  '@connect 与跨域授权',
  '技能与斜杠指令',
  '页面观测与敏感站点排除',
  '两台调试台',
  '故障排查',
];
