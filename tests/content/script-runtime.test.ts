// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { scriptRunner, HELPER_GLOBAL } from '../../content/script-runtime';
import { createHelpers } from '../../content/helpers/index';
import { resetUidMap } from '../../content/snapshot/build';

/** 模拟 content script 的启动安装。 */
function install(): void {
  (globalThis as Record<string, unknown>)[HELPER_GLOBAL] = createHelpers;
}

describe('scriptRunner', () => {
  beforeEach(() => {
    resetUidMap();
    document.body.innerHTML = '';
    delete (globalThis as Record<string, unknown>)[HELPER_GLOBAL];
  });

  it('helper 未安装时降级执行：原生脚本照常跑通（MAIN world 的正常用法）', async () => {
    document.title = '测试页';
    const r = await scriptRunner('return document.title;');
    expect(r.ok).toBe(true);
    expect(r.data).toBe('测试页');
  });

  it('helper 缺失时调用 helper 报 script-error 且 hint 引导 MAIN/isolated', async () => {
    const r = await scriptRunner('await $("button");');
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('script-error');
    expect(r.hint).toContain('MAIN');
    expect(r.hint).toContain('isolated');
  });

  it('helper 缺失时 log 仍可用（埋点收进 logs，脚本不因埋点炸掉）', async () => {
    const r = await scriptRunner('log("a", 1, { b: 2 }); return "done";');
    expect(r.ok).toBe(true);
    expect(r.data).toBe('done');
    expect(r.logs).toEqual(['a 1 {"b":2}']);
  });

  it('helper 未安装时报可读错误（不是 undefined is not a function）', async () => {
    const r = await scriptRunner('await $("button");');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('helper');
    expect(r.error).toContain('不可用');
  });

  it('执行脚本并返回 data + trace + logs', async () => {
    install();
    document.body.innerHTML = '<button>确定</button>';
    const r = await scriptRunner(`
      const btn = $({ role: 'button', text: '确定' });
      await click(btn);
      log('点完了');
      return text(btn);
    `);
    expect(r.ok).toBe(true);
    expect(r.data).toBe('确定');
    expect(r.logs).toEqual(['点完了']);
    expect(r.trace).toHaveLength(2);
    expect(r.trace![0]).toMatchObject({ i: 1, op: '$' });
    expect(r.trace![1]).toMatchObject({ i: 2, op: 'click' });
  });

  it('脚本可用 await（包成 async 函数体）', async () => {
    install();
    const r = await scriptRunner('await new Promise(res => setTimeout(res, 1)); return 42;');
    expect(r.ok).toBe(true);
    expect(r.data).toBe(42);
  });

  it('无 return 时 data 为 undefined 且仍 ok', async () => {
    install();
    const r = await scriptRunner('log("只埋点");');
    expect(r.ok).toBe(true);
    expect(r.data).toBeUndefined();
  });

  it('StepError 转结构化失败：kind + failedAt + 前序 trace', async () => {
    install();
    document.body.innerHTML = '<button>甲</button><a class="next-page">下一页 ›</a>';
    const r = await scriptRunner(`
      await click($({ text: '甲' }));
      await click($({ role: 'button', text: '下一页' }));
    `);
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('locator-miss');
    expect(r.failedAt).toMatchObject({ i: 3, op: '$' });
    expect(r.failedAt!.relaxed).toBeDefined();
    expect(r.failedAt!.nearMiss).toHaveLength(1);
    expect(r.hint).toContain('下一页 ›');
    expect(r.trace).toHaveLength(2);   // 失败前两步保留
  });

  it('语法错误转 script-error 并带原始信息', async () => {
    install();
    const r = await scriptRunner('const x = ;');
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('script-error');
    expect(r.error).toMatch(/SyntaxError/);
  });

  it('未定义函数转 script-error；名字不在 helper 清单内时 hint 引导 load_skill', async () => {
    install();
    const r = await scriptRunner('await $x("//button");');
    expect(r.kind).toBe('script-error');
    expect(r.hint).toContain('load_skill');
    expect(r.hint).toContain('$x');
  });

  it('未定义名字恰好是 helper 之一时不给 load_skill 提示（说明是别的问题）', async () => {
    install();
    // 块级作用域遮蔽 helper 名再调用：等价于 plan 的 let click 意图，
    // 但与 AsyncFunction 参数名不冲突（plan 原文 new Function 参数下会 SyntaxError）。
    const r = await scriptRunner('{ let click; await click(document.body); }');
    expect(r.kind).toBe('script-error');
    expect(r.hint ?? '').not.toContain('load_skill');
  });

  it('返回 DOM 节点转 script-error 并引导取 text(el)', async () => {
    install();
    document.body.innerHTML = '<button>x</button>';
    const r = await scriptRunner('return $({ role: "button" });');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('text(el)');
  });

  it('data 超限截断并给 dataTruncated', async () => {
    install();
    const r = await scriptRunner('return Array.from({length: 5000}, (_, i) => ({ t: "标题" + i, u: "/p/" + i }));');
    expect(r.ok).toBe(true);
    expect(r.dataTruncated!.total).toBe(5000);
    expect(r.dataTruncated!.returned).toBeLessThan(5000);
  });

  it('trace 超 50 步折叠', async () => {
    install();
    document.body.innerHTML = '<button>x</button>';
    const r = await scriptRunner('for (let i = 0; i < 60; i++) { $$({ role: "button" }); } return 1;');
    expect(r.trace!.length).toBe(31);
    expect(r.trace!.some((t) => 'collapsed' in (t as object))).toBe(true);
  });

  it('logs 超 30 条丢最早的并标注', async () => {
    install();
    const r = await scriptRunner('for (let i = 0; i < 40; i++) log("L" + i); return 1;');
    expect(r.logs!.length).toBe(30);
    expect(r.logsDropped).toBe(10);
  });

  it('回传 url；未导航时无 urlFrom', async () => {
    install();
    const r = await scriptRunner('return 1;');
    expect(r.url).toBe(location.href);
    expect(r.urlFrom).toBeUndefined();
  });

  it('非 Error 抛出物（页面常抛 Event/DOMException）也归一化成可读文本', async () => {
    install();
    const r = await scriptRunner('throw new DOMException("tainted", "SecurityError");');
    expect(r.kind).toBe('script-error');
    expect(r.error).toContain('SecurityError');
  });

  it('elapsed 有值', async () => {
    install();
    const r = await scriptRunner('return 1;');
    expect(typeof r.elapsed).toBe('number');
  });
});
