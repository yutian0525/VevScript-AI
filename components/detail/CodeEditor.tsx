// components/detail/CodeEditor.tsx
// CodeMirror 6 封装（2026-09-04）：行号/JS 高亮/语法自动缩进/Ctrl+S 保存。
// 回调经 useRef 转发——extensions 只在挂载时构建一次，防 EditorView 随 render 重建。
import { useEffect, useRef } from 'react';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState, type Extension } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { indentUnit } from '@codemirror/language';
import { indentWithTab } from '@codemirror/commands';

interface Props {
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
  ariaLabel: string;
}

const editorTheme = EditorView.theme(
  {
    '&': { height: '100%', fontSize: '12.5px' },
    '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6', overflow: 'auto' },
    '&.cm-focused': { outline: 'none' },
    '.cm-gutters': { background: 'transparent', border: 'none', color: 'var(--ink-3)' },
    '.cm-activeLine': { background: 'var(--paper)' },
    '.cm-activeLineGutter': { background: 'transparent', color: 'var(--ink-2)' },
    '.cm-content': { caretColor: 'var(--signal)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { background: 'var(--signal-wash)' },
    '.cm-cursor': { borderLeftColor: 'var(--signal)' },
  },
  { dark: false },
);

export function CodeEditor({ value, onChange, onSave, ariaLabel }: Props) {
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
        javascript(),
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
