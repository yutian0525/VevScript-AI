import { Fragment } from 'react';

/** 把 `反引号` 片段渲染成 mono 芯片。
 *  刻意不用 dangerouslySetInnerHTML——扩展端的渲染约定是零 innerHTML，宣传页不该给出反例。 */
export function RichText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/g).map((seg, i) =>
        seg.startsWith('`') && seg.endsWith('`') && seg.length > 2 ? (
          <code key={i}>{seg.slice(1, -1)}</code>
        ) : (
          <Fragment key={i}>{seg}</Fragment>
        ),
      )}
    </>
  );
}
