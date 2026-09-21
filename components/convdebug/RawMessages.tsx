// components/convdebug/RawMessages.tsx
// Task 6 最小占位：只报条数，Task 8 会按相同签名替换成真实消息流实现。
import type { ChatMessage } from '../../agent/provider/types';

export function RawMessages({ messages }: { messages: ChatMessage[] }) {
  return <p className="convdebug__empty">共 {messages.length} 条消息（消息流待实现）</p>;
}
