import { Bookmark, BookmarkCheck, Clock, Lock, RotateCcw } from 'lucide-react';
import { FEED } from '../demo/cards';
import type { PageState } from '../demo/useRunner';

/** 仿真网页：脚本作用的对象。卡片消失/缩略图放大/阅读时长徽标三种结果都落在这里。 */
export function DemoPage({
  page,
  phase,
  onReset,
}: {
  page: PageState;
  phase: 'idle' | 'running' | 'done';
  onReset: () => void;
}) {
  const cards = FEED.filter((c) => !page.gone.includes(c.id));

  return (
    <div className={`web${page.zoom ? ' web--zoom' : ''}`} aria-label="被操控的网页示意">
      <div className="web__bar">
        <span className="web__url">
          <Lock size={10} aria-hidden="true" />
          frontend-weekly.dev
        </span>
        {phase === 'done' && (
          <button type="button" className="web__reset" onClick={onReset}>
            <RotateCcw size={11} aria-hidden="true" />
            还原页面
          </button>
        )}
      </div>

      <div className="web__body">
        <div className="web__masthead">
          {/* 仿真网页里的"标题"不进宿主文档大纲：否则读屏按标题跳转会掉进示意内容，
              且顺序上 H3/H4 出现在首个真 H2 之前，层级读作跳级。整块装置已由 aria-label 交代。 */}
          <div className="web__site">前端周刊</div>
          <span className="web__nav" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </div>

        <div className="feed">
          {cards.map((c) => (
            <article
              key={c.id}
              className={`fcard${page.leaving.includes(c.id) ? ' fcard--out' : ''}`}
              data-slot={c.kind === 'ad' ? 'promo' : 'post'}
            >
              <span className={`thumb thumb--t${c.tone}`} aria-hidden="true" />
              <div className="fcard__body">
                <div className="fcard__t">
                  {page.readBadge && (
                    <span className="rbadge">
                      <Clock size={9} aria-hidden="true" />
                      {c.read}
                    </span>
                  )}
                  {c.title}
                </div>
                <div className="fcard__m">
                  <span>{c.author}</span>
                  <span className="fcard__dot" aria-hidden="true" />
                  <span>{c.time}</span>
                  {c.kind === 'ad' && <span className="fcard__ad">推广</span>}
                </div>
              </div>
              {/* 「稍后读」按钮：直接操控场景里被 click 工具点亮的那个。
                  示意元件，aria-hidden + tabIndex -1，不进宿主页的 Tab 序列。 */}
              <span
                className={`fsave${page.saved.includes(c.id) ? ' fsave--on' : ''}`}
                aria-hidden="true"
              >
                {page.saved.includes(c.id) ? (
                  <BookmarkCheck size={13} />
                ) : (
                  <Bookmark size={13} />
                )}
              </span>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
