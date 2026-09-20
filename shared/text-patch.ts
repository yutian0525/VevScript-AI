// shared/text-patch.ts
// 文本补丁原语（纯函数）：追加到末尾 / 字面量精确替换。
// 脚本池（background/scripts.ts）与技能池（background/skill-writes.ts）共用——两处都是
// 「一份文本为源，分步 append / 精确 replace」的写入模型，只是确认原文的工具名不同。
// 零依赖：shared/ 不得 import background/ 或 agent/。

/** 追加到原文末尾（原文无尾换行时先补一个）。分步写入的主力原语。
 *  !addition 守卫同时挡空串与 null/undefined（模型 JSON 透传），避免静默追加 "null"。 */
export function appendText(text: string, addition: string): string {
  if (!addition) throw new Error('append 不能为空');
  if (text === '' || text.endsWith('\n')) return text + addition;
  return `${text}\n${addition}`;
}

/** old 在 text 中每处出现的 1-based 行号（非重叠，与 split/join 语义一致）。
 *  换行计数增量推进：idx 单调递增，每次只扫上一匹配之后的新片段，不反复 slice+split 全文。 */
function occurrenceLines(text: string, needle: string): number[] {
  const lines: number[] = [];
  let newlines = 0;
  let scanned = 0; // 已完成换行计数的前缀长度
  let idx = text.indexOf(needle);
  while (idx >= 0) {
    for (let i = scanned; i < idx; i++) {
      if (text.charCodeAt(i) === 10) newlines += 1; // '\n'
    }
    scanned = idx;
    lines.push(newlines + 1);
    idx = text.indexOf(needle, idx + needle.length);
  }
  return lines;
}

/** 错误文案里的 old 预览：换行可视化 + 截断，避免把整段代码打进错误消息。 */
function previewNeedle(s: string): string {
  const flat = s.replace(/\n/g, '\\n');
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
}

/**
 * 字面量精确替换（不走正则，避开元字符陷阱）。
 * old 未命中 → throw；命中多处且未传 all → throw 并列出行号；all=true 全替（无需算行号）。
 * confirmHint：未命中时告诉模型该用哪个工具读原文——脚本是 get_script/grep_script，技能是 get_skill。
 */
export function replaceText(
  text: string,
  old: string,
  replacement: string,
  all: boolean,
  confirmHint: string,
): string {
  if (typeof old !== 'string' || !old) throw new Error('replace.old 不能为空'); // 挡 null/undefined 透传
  if (!text.includes(old)) {
    throw new Error(`replace 未找到该文本：「${previewNeedle(old)}」——${confirmHint}`);
  }
  if (all) return text.split(old).join(replacement);
  // 非 all 才需要行号：多处命中时要告诉模型落在哪几行
  const lines = occurrenceLines(text, old);
  if (lines.length > 1) {
    throw new Error(
      `replace.old 命中 ${lines.length} 处（第 ${lines.join('、')} 行）：请加上下文让 old 唯一，或传 all:true 全部替换`,
    );
  }
  const idx = text.indexOf(old);
  return text.slice(0, idx) + replacement + text.slice(idx + old.length);
}
