import { useEffect, useRef } from 'react';
import { DemoPanel } from './DemoPanel';
import { DemoPage } from './DemoPage';
import { useRunner } from '../demo/useRunner';

/** 首屏签名装置：左侧仿真侧边栏 + 右侧被操控的网页。
 *  滚入视口自动跑第一条，之后由用户点 tag 主导——首访者不点也能看到一次完整因果。 */
export function Demo() {
  const { lines, page, phase, activeId, start, reset, scenarios } = useRunner();
  const convTitle = scenarios.find((s) => s.id === activeId)?.title ?? '新会话';
  const hostRef = useRef<HTMLDivElement>(null);
  const fired = useRef(false);

  useEffect(() => {
    const el = hostRef.current;
    const first = scenarios[0];
    if (!el || !first) return;
    if (!('IntersectionObserver' in window)) {
      start(first);
      fired.current = true;
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && !fired.current) {
            fired.current = true;
            start(first);
            io.disconnect();
          }
        }
      },
      // 阈值放低：窄屏下装置竖排后很高，0.45 需要滚很久才满足，首访者可能一直看不到它跑
      { threshold: 0.2 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [scenarios, start]);

  return (
    <div className="demo" ref={hostRef}>
      <DemoPanel
        lines={lines}
        scenarios={scenarios}
        activeId={activeId}
        phase={phase}
        onPick={start}
        convTitle={convTitle}
      />
      <DemoPage page={page} phase={phase} onReset={reset} />
    </div>
  );
}
