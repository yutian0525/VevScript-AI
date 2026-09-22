// components/convdebug/RawMessages.tsx
// 原始消息流（spec §6.4）：逐条渲染，user/assistant 走 Markdown，tool 与 toolCalls 走等宽折叠块。
// 不追求与聊天界面像素级一致，只求可读；trace 被裁剪后这里是唯一的完整历史。
import type { ChatMessage } from '../../agent/provider/types';
import { Markdown } from '../chat/Markdown';
import { toMessageRows, type MessageRow } from './convdebug-utils';

const ROLE_LABEL: Record<MessageRow['role'], string> = {
  system: 'system',
  user: 'user',
  assistant: 'assistant',
  tool: 'tool',
};

export function RawMessages({ messages }: { messages: ChatMessage[] }) {
  const rows = toMessageRows(messages);
  if (rows.length === 0) return <p className="convdebug__empty">这个会话还没有消息</p>;

  return (
    <div className="convdebug-msgs">
      {rows.map((r) => (
        <article key={r.key} className={`convdebug-msg convdebug-msg--${r.role}`}>
          <header className="convdebug-msg__role mono">
            {ROLE_LABEL[r.role]}
            {r.name ? ` · ${r.name}` : ''}
          </header>

          {r.reasoning && (
            <details className="convdebug-msg__fold">
              <summary className="mono">reasoning</summary>
              <pre className="convdebug-msg__pre">{r.reasoning}</pre>
            </details>
          )}

          {r.text && (r.role === 'user' || r.role === 'assistant'
            ? <Markdown text={r.text} />
            : <pre className="convdebug-msg__pre">{r.text}</pre>)}

          {r.toolCalls?.map((tc, i) => (
            <details key={i} className="convdebug-msg__fold">
              <summary className="mono">调用 {tc.name}</summary>
              <pre className="convdebug-msg__pre">{tc.args}</pre>
            </details>
          ))}
        </article>
      ))}
    </div>
  );
}
