// components/chat/slash.ts
// 斜杠浮层纯逻辑（spec §3）：触发判定 / 键盘导航 / 补全文本，无 React 依赖（可测）。

/** 输入框当前文本是否应打开浮层：/ 开头且尚无空白（附加文本阶段浮层关闭）。 */
export function shouldOpenSlash(input: string): boolean {
  return /^\/\S*$/.test(input);
}

/** 键盘导航：返回新状态；null = 该键不归浮层管（透传 textarea 默认处理）。 */
export function handleSlashKey(
  key: string,
  state: { open: boolean; hi: number; count: number },
): { open: boolean; hi?: number; selected?: boolean } | null {
  if (!state.open || state.count === 0) return null;
  switch (key) {
    case 'ArrowDown':
      return { open: true, hi: (state.hi + 1) % state.count };
    case 'ArrowUp':
      return { open: true, hi: (state.hi - 1 + state.count) % state.count };
    case 'Enter':
    case 'Tab':
      return { open: false, selected: true };
    case 'Escape':
      return { open: false, selected: false };
    default:
      return null;
  }
}

/** 选中候选后的补全文本：/command + 尾随空格（用户继续打附加文本）。 */
export function completeSlash(command: string): string {
  return `/${command} `;
}
