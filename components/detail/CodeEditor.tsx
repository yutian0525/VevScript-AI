// components/detail/CodeEditor.tsx
// CodeMirror 6 封装（2026-09-04）：行号/JS 高亮/语法自动缩进/Ctrl+S 保存。
// 回调经 useRef 转发——extensions 只在挂载时构建一次，防 EditorView 随 render 重建。
import { useEffect, useRef } from 'react';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState, type Extension } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import { indentUnit } from '@codemirror/language';
import { indentWithTab } from '@codemirror/commands';

interface Props {
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
  ariaLabel: string;
  /** 语法高亮语言。挂载时决定，不支持运行时切换（extensions 只构建一次）。默认 javascript。 */
  language?: 'javascript' | 'markdown';
}

const editorTheme = EditorView.theme(
  {
    '&': { height: '100%', fontSize: '12.5px' },
    '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6', overflow: 'auto' },
    '&.cm-focused': { outline: 'none' },
    '.cm-gutters': { background: 'transparent', border: 'none', color: 'var(--ink-3)' },
    // 配置一·当前行整行高亮：淡信号晕染（全宽），与选中那片浓实心分层
    '.cm-activeLine': { background: 'color-mix(in srgb, var(--signal) 8%, transparent)' },
    '.cm-activeLineGutter': { background: 'color-mix(in srgb, var(--signal) 12%, transparent)', color: 'var(--signal-ink)' },
    '.cm-content': { caretColor: 'var(--signal)' },
    // 配置二·选中背景：实心信号色（全局 ::selection 已把选中文字染白，白字须压在够深的实心底才清晰）。
    // 失焦淡一档、聚焦全实心。行内选中与跨行选中在 CM 里共用此类，无法仅靠 CSS 区分。
    '.cm-selectionBackground': { background: 'color-mix(in srgb, var(--signal) 62%, var(--surface))' },
    '&.cm-focused .cm-selectionBackground': { background: 'var(--signal)' },
    '.cm-cursor': { borderLeftColor: 'var(--signal)' },
    // 同名高亮（选中词后其他同名词）：只描边 + 极淡填充，与选中态（实心一片）视觉分离，不夺文字对比
    '.cm-selectionMatch': {
      background: 'color-mix(in srgb, var(--signal) 8%, transparent)',
      outline: '1px solid color-mix(in srgb, var(--signal) 40%, transparent)',
      borderRadius: '2px',
    },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      background: 'transparent', outline: '1px solid var(--signal)', borderRadius: '2px',
    },
    // 滚动条：常驻可见（覆盖全局「hover 才显形」的过淡规则）
    '.cm-scroller::-webkit-scrollbar': { width: '12px', height: '12px' },
    '.cm-scroller::-webkit-scrollbar-thumb': {
      background: 'var(--line-strong)', borderRadius: '6px',
      border: '3px solid var(--sunken)', backgroundClip: 'padding-box',
    },
    '.cm-scroller:hover::-webkit-scrollbar-thumb, .cm-scroller::-webkit-scrollbar-thumb:hover': {
      background: 'var(--ink-3)', backgroundClip: 'padding-box',
    },
    '.cm-scroller::-webkit-scrollbar-track': { background: 'transparent' },
  },
  { dark: false },
);

export function CodeEditor({ value, onChange, onSave, ariaLabel, language = 'javascript' }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // 最新回调放 ref：updateListener/keymap 闭包捕获 ref，不捕获过期 props
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  // 挂载：创建 EditorView（一次）
  useEffect(() => {
    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        language === 'markdown' ? markdown() : javascript(),
        EditorView.lineWrapping,
        indentUnit.of('  '),
        keymap.of([
          indentWithTab,
          { key: 'Mod-s', preventDefault: true, run: () => { onSaveRef.current(); return true; } },
        ]),
        EditorView.updateListener.of((v) => {
          if (v.docChanged) onChangeRef.current(v.state.doc.toString());
        }),
        editorTheme,
      ] as Extension[],
    });
    const view = new EditorView({ state, parent: hostRef.current! });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
    // 初始 doc 取挂载时的 value 即可，后续同步走下方 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部 value 变化（脚本切换/导入/保存回传）→ 全量替换 doc，光标收敛文件头
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
        selection: { anchor: 0 },
      });
    }
  }, [value]);

  return <div ref={hostRef} className="detail-code__host" role="textbox" aria-label={ariaLabel} aria-multiline="true" />;
}
