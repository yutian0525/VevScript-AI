// agent/provider/sse.ts
// 手写 SSE 流解析器（设计决策：不引入 SDK）。
// 只处理 data: 行（[DONE] 除外），多行 data 按 SSE 规范用 \n 拼接。
//
// CRLF 边界说明：\r\n -> \n 替换每次 push 都作用于「整个累积 buffer」，
// 因此某个 \r 落在 chunk 末尾、其后的 \n 落在下一 chunk 开头时，
// 残留的 \r 会在下一次 push 的全量替换中被一并规范化。
// flush() + CRLF 路径同样安全：残留块中间的 \r\n 已被之前的 push 替换掉，
// 块尾若残留单独的 \r 则被 flush 的 trim() 去除。
// 不受支持（有意不做）：单独 CR（\r 不带 \n）作为换行符——OpenAI 兼容
// 流只用 \n 或 \r\n，超出该场景的输入不在支持范围内。

export function createSseParser(onData: (data: string) => void) {
  let buffer = '';

  function processEventBlock(block: string) {
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      // event:/id:/retry:/注释行 忽略
    }
    if (dataLines.length > 0) {
      const data = dataLines.join('\n');
      if (data !== '[DONE]') onData(data);
    }
  }

  return {
    push(chunk: string) {
      buffer += chunk;
      buffer = buffer.replace(/\r\n/g, '\n');
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        processEventBlock(block);
      }
    },
    /** 流结束时处理残留 buffer（部分实现最后事件后无空行） */
    flush() {
      const rest = buffer.trim();
      buffer = '';
      if (rest) processEventBlock(rest);
    },
  };
}
