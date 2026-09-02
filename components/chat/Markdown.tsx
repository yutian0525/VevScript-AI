// components/chat/Markdown.tsx
// assistant 正文的 Markdown 渲染：纯组件，字符串 → React 元素树。
// 安全边界 = react-markdown 默认行为：不渲染原始 HTML、过滤危险 URL scheme、
// img 显式拒绝。项目保持零 dangerouslySetInnerHTML。
//
// 约定：react-markdown 会给每个 components 覆盖组件注入 node prop（hast 元素），
// 自定义覆盖组件【必须】把它从转发 props 里解构掉——否则非法属性 node="[object Object]"
// 会泄漏进 DOM。所有覆盖一律走 `ComponentPropsWithoutRef<'tag'> & ExtraProps` 类型。
import type { ComponentPropsWithoutRef } from 'react';
import { isValidElement } from 'react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';

type CodeProps = ComponentPropsWithoutRef<'code'> & ExtraProps;
type PreProps = ComponentPropsWithoutRef<'pre'> & ExtraProps;

/** 行内代码 / 代码块内代码（pre 内不再套 md-code，由 .md 覆盖样式）。 */
function Code({ node, className, children, ...rest }: CodeProps) {
  return (
    <code className={className ?? 'md-code'} {...rest}>
      {children}
    </code>
  );
}

/** 代码块：复用 .well 井视觉 + 顶部语言标签。语言取 className="language-ts"。 */
function Pre({ node, children, ...rest }: PreProps) {
  // children 是单个 <code className="language-xxx">…</code> 元素；
  // isValidElement 对数组 children 返回 false，此时 lang 取 undefined。
  const lang = isValidElement<{ className?: string }>(children)
    ? children.props.className?.match(/language-([\w+-]+)/)?.[1]
    : undefined;
  return (
    <div className="md-codeblock">
      {lang && <span className="md-codeblock__lang">{lang}</span>}
      <pre className="md-codeblock__pre" {...rest}>
        {children}
      </pre>
    </div>
  );
}

const components: Components = {
  code: Code,
  pre: Pre,
  a: ({ node, ...rest }: ComponentPropsWithoutRef<'a'> & ExtraProps) => (
    <a {...rest} target="_blank" rel="noreferrer noopener" />
  ),
  table: ({ node, ...rest }: ComponentPropsWithoutRef<'table'> & ExtraProps) => (
    <div className="md-table-scroll">
      <table {...rest} />
    </div>
  ),
  img: () => null,
};

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  // 流式 caret 走 CSS 伪元素 .md > :last-child::after（Task 3 提供），
  // 由 streaming 修饰类 md--live 驱动，紧跟末字符而非独立 span 游离在块级内容下方。
  return (
    <div className={`md${streaming ? ' md--live' : ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
