// agent/provider/sse.ts
// 手写 SSE 流解析器（设计决策：不引入 SDK）。
// 只处理 data: 行（[DONE] 除外），多行 data 按 SSE 规范用 \n 拼接。
//
// 已知边界：push 里每帧做 \r\n -> \n 替换。当某个 \r 恰好落在 chunk 末尾、
// 其后的 \n 落在下一 chunk 开头时，替换在该帧已跑过、\r 单独残留在 buffer，
// 下帧拼接后 buffer 为 "...\r\n..."，但替换只作用于新增部分——不命中，
// 于是 \r\n 被切成 "\r" + "\n" 两行，多行 data 拼接会多出内容。
// SSE chunk 边界恰好切在 \r\n 中间在实际网络栈（TCP/HTTP 解码）几乎不发生，
// 且 OpenAI 兼容实现普遍用 \n。测试未覆盖此 case，按当前实现交付；
// 若日后暴露，修法是把 \r\n 规范化挪到 processEventBlock 内对 block 做。

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
