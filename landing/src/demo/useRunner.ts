import { useCallback, useEffect, useRef, useState } from 'react';
import { SCENARIOS, type Beat, type Scenario } from './script';

/** 会话流里的一条。tool 有自己的状态机（running → ok），文字类有 live 标记控制光标。 */
export type Line =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'reasoning' | 'text'; text: string; live: boolean }
  | { id: string; kind: 'tool'; name: string; args: string; result: string; status: 'running' | 'ok' };

export interface PageState {
  /** 正在淡出（已触发动画，尚未离开布局） */
  leaving: string[];
  /** 已彻底移除 */
  gone: string[];
  zoom: boolean;
  readBadge: boolean;
  /** 被 click 工具点成已收藏的卡片（直接操控场景的结果） */
  saved: string[];
}

const EMPTY_PAGE: PageState = { leaving: [], gone: [], zoom: false, readBadge: false, saved: [] };

/** 逐字节奏。中文一字信息量大，22ms 接近真实流式观感 */
const CHAR_MS = 22;
/** 卡片淡出到彻底抽出布局的间隔，与 CSS 的 .fcard--out 时长对齐 */
const DROP_MS = 460;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useRunner() {
  const [lines, setLines] = useState<Line[]>([]);
  const [page, setPage] = useState<PageState>(EMPTY_PAGE);
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [activeId, setActiveId] = useState<string | null>(null);
  /** {场景, nonce}：nonce 递增让同一 tag 连点也能重跑 */
  const [run, setRun] = useState<{ scenario: Scenario; nonce: number } | null>(null);

  const timers = useRef<number[]>([]);

  const clearTimers = useCallback(() => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
  }, []);

  const start = useCallback(
    (scenario: Scenario) => {
      setRun((prev) => ({ scenario, nonce: (prev?.nonce ?? 0) + 1 }));
    },
    [],
  );

  const reset = useCallback(() => {
    clearTimers();
    setRun(null);
    setLines([]);
    setPage(EMPTY_PAGE);
    setPhase('idle');
    setActiveId(null);
  }, [clearTimers]);

  useEffect(() => {
    if (!run) return;
    const { scenario } = run;
    const reduced = prefersReducedMotion();

    // 新一轮：清掉上一轮的 timer 与画面
    clearTimers();
    setLines([]);
    setPage(EMPTY_PAGE);
    setPhase('running');
    setActiveId(scenario.id);

    const later = (ms: number, fn: () => void) => {
      timers.current.push(window.setTimeout(fn, ms));
    };

    /** 把 text 逐字写进指定行；返回打完所需毫秒 */
    const stream = (base: number, lineId: string, text: string): number => {
      if (reduced) {
        later(base, () => {
          setLines((ls) => ls.map((l) => (l.id === lineId && 'live' in l ? { ...l, text, live: false } : l)));
        });
        return 0;
      }
      const chars = [...text];
      chars.forEach((_, i) => {
        later(base + i * CHAR_MS, () => {
          const slice = chars.slice(0, i + 1).join('');
          setLines((ls) => ls.map((l) => (l.id === lineId && 'live' in l ? { ...l, text: slice } : l)));
        });
      });
      const dur = chars.length * CHAR_MS;
      later(base + dur, () => {
        setLines((ls) => ls.map((l) => (l.id === lineId && 'live' in l ? { ...l, live: false } : l)));
      });
      return dur;
    };

    let endsAt = 0;

    scenario.beats.forEach((beat: Beat, idx) => {
      const lineId = `${scenario.id}-${idx}`;
      const at = reduced ? beat.at * 0.45 : beat.at;

      if (beat.kind === 'user') {
        later(at, () => setLines((ls) => [...ls, { id: lineId, kind: 'user', text: beat.text }]));
        endsAt = Math.max(endsAt, at);
        return;
      }

      if (beat.kind === 'reasoning' || beat.kind === 'text') {
        later(at, () =>
          setLines((ls) => [...ls, { id: lineId, kind: beat.kind, text: '', live: true }]),
        );
        const dur = stream(at, lineId, beat.text);
        endsAt = Math.max(endsAt, at + dur);
        return;
      }

      if (beat.kind === 'tool') {
        later(at, () =>
          setLines((ls) => [
            ...ls,
            { id: lineId, kind: 'tool', name: beat.name, args: beat.args, result: beat.result, status: 'running' },
          ]),
        );
        later(at + beat.dur, () =>
          setLines((ls) => ls.map((l) => (l.id === lineId && l.kind === 'tool' ? { ...l, status: 'ok' } : l))),
        );
        endsAt = Math.max(endsAt, at + beat.dur);
        return;
      }

      // page mutation
      const m = beat.mutation;
      later(at, () => {
        setPage((p) => {
          if (m.type === 'drop') return { ...p, leaving: [...p.leaving, ...m.ids] };
          if (m.type === 'zoom') return { ...p, zoom: true };
          if (m.type === 'read-badge') return { ...p, readBadge: true };
          if (m.type === 'save') return { ...p, saved: [...p.saved, ...m.ids] };
          return EMPTY_PAGE;
        });
      });
      if (m.type === 'drop') {
        // 淡出结束再抽出布局，避免网格瞬间跳位
        later(at + DROP_MS, () => {
          setPage((p) => ({ ...p, gone: [...p.gone, ...m.ids] }));
        });
        endsAt = Math.max(endsAt, at + DROP_MS);
      }
      endsAt = Math.max(endsAt, at);
    });

    later(endsAt + 120, () => setPhase('done'));

    return clearTimers;
  }, [run, clearTimers]);

  // 卸载兜底
  useEffect(() => clearTimers, [clearTimers]);

  return { lines, page, phase, activeId, start, reset, scenarios: SCENARIOS };
}
