// agent/provider/think-splitter.ts
// 流式拆分 content 里的 <think>...</think>：标签内→reasoning，标签外→text。
// 部分中转/本地模型不吐独立的 reasoning_content 字段，而是把思考混在 content 里用
// <think></think> 包裹。标签可能被切在不同 SSE chunk 里（如 "<thi" + "nk>"），
// 故需跨 chunk 维护状态 + 回退可能的半截标签。
//
// 每次 streamChat 调用创建一个实例（状态存活于单次请求内）。对不含 <think> 的普通
// 内容零副作用：整段作为 text 透传（仅在以 '<' 结尾时把可能的半截标签延后一 chunk）。

const OPEN = '<think>';
const CLOSE = '</think>';

export interface ThinkSink {
  reasoning: (text: string) => void;
  text: (text: string) => void;
}

export function createThinkSplitter(sink: ThinkSink) {
  let inThink = false;
  let buf = '';

  /** buf 末尾中「可能是 tag 前缀」的最长长度（半截标签，需留到下个 chunk）。 */
  function heldBackLen(tag: string): number {
    const max = Math.min(buf.length, tag.length - 1);
    for (let k = max; k > 0; k -= 1) {
      if (buf.slice(buf.length - k) === tag.slice(0, k)) return k;
    }
    return 0;
  }

  function emit(text: string) {
    if (!text) return;
    if (inThink) sink.reasoning(text);
    else sink.text(text);
  }

  function pump() {
    for (;;) {
      const tag = inThink ? CLOSE : OPEN;
      const idx = buf.indexOf(tag);
      if (idx === -1) {
        // 无完整标签：吐出除「可能半截标签」外的部分，半截留到下个 chunk
        const hold = heldBackLen(tag);
        emit(buf.slice(0, buf.length - hold));
        buf = buf.slice(buf.length - hold);
        return;
      }
      emit(buf.slice(0, idx)); // 标签前的文本按当前区段归类
      buf = buf.slice(idx + tag.length);
      inThink = !inThink; // 切换区段
    }
  }

  return {
    /** 喂入一段 content 增量。 */
    push(delta: string) {
      if (!delta) return;
      buf += delta;
      pump();
    },
    /** 流结束：残留（含未闭合标签）按当前区段原样吐出。 */
    flush() {
      emit(buf);
      buf = '';
    },
  };
}
