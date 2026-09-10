// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { waitFor, describeCond } from '../../../content/helpers/wait';
import { StepError } from '../../../content/helpers/step-error';
import { resetUidMap } from '../../../content/snapshot/build';

const catchStepError = async (p: Promise<unknown>): Promise<StepError> => {
  try { await p; throw new Error('expected StepError, but resolved'); }
  catch (e) { if (e instanceof StepError) return e; throw e; }
};

describe('describeCond', () => {
  it('各形式都有可读描述（进 trace 与超时文案）', () => {
    expect(describeCond({ role: 'dialog' })).toContain('出现');
    expect(describeCond({ gone: '.loading' })).toContain('消失');
    expect(describeCond({ idle: 500 })).toBe('网络静默 500ms');
    expect(describeCond(() => true)).toBe('自定义谓词');
  });
});

describe('waitFor（真实时钟）', () => {
  beforeEach(() => { resetUidMap(); document.body.innerHTML = ''; });

  it('locator 条件：元素已存在时立即返回 waited 很小', async () => {
    document.body.innerHTML = '<div role="dialog">弹窗</div>';
    const r = await waitFor({ role: 'dialog' });
    // 500ms 而非 50：jsdom 首次 getComputedStyle 冷启动 ~60ms（探针实测）会算进
    // waited，全量跑时冷启动抖动可达 300ms+。断言的本意是「没进轮询循环」，
    // 轮询起步两轮就要 ~200ms+，500ms 仍有区分力（进了循环必然超它）。
    expect(r.waited).toBeLessThan(500);
  });

  it('gone 条件：元素本来就不存在时立即返回', async () => {
    const r = await waitFor({ gone: '.never-existed' });
    expect(r.waited).toBeLessThan(50);
  });

  it('文本条件（locator 的 text 形式）', async () => {
    document.body.innerHTML = '<div>搜索结果共 20 条</div>';
    await expect(waitFor({ text: '搜索结果' }, { timeout: 2000 })).resolves.toBeDefined();
  });

  it('超时抛 timeout 类 StepError，带条件描述与已等时长', async () => {
    const err = await catchStepError(waitFor({ role: 'dialog' }, { timeout: 300, interval: 50 }));
    expect(err.kind).toBe('timeout');
    expect(String(err.detail.cond)).toContain('dialog');
    expect(Number(err.detail.waited)).toBeGreaterThanOrEqual(300);
    expect(String(err.detail.hint)).toContain('screenshot');
  });

  it('locator 超时时附当前命中数（区分「没渲染」与「渲染了但条件不符」）', async () => {
    document.body.innerHTML = '<div role="alert">别的东西</div>';
    const err = await catchStepError(waitFor({ role: 'dialog' }, { timeout: 300, interval: 50 }));
    expect(err.detail.matched).toBe(0);
  });

  it('谓词条件：返回 true 时结束', async () => {
    let n = 0;
    await expect(waitFor(() => { n += 1; return n >= 3; }, { timeout: 2000, interval: 20 })).resolves.toBeDefined();
  });

  it('谓词条件支持 async', async () => {
    await expect(waitFor(async () => true, { timeout: 1000 })).resolves.toBeDefined();
  });

  it('谓词抛错时转 script-error（不当成「条件未满足」死等）', async () => {
    const err = await catchStepError(waitFor(() => { throw new TypeError('boom'); }, { timeout: 500 }));
    expect(err.kind).toBe('script-error');
    expect(err.message).toContain('boom');
  });

  it('非法 locator 立即转 script-error，不死等到超时', async () => {
    const t0 = Date.now();
    const err = await catchStepError(waitFor('<<bad>>', { timeout: 5000 }));
    expect(err.kind).toBe('script-error');
    expect(Date.now() - t0).toBeLessThan(1000);   // 没等到 5s 超时
  });

  it('idle 条件：资源计数不增后在静默窗口后返回', async () => {
    const r = await waitFor({ idle: 150 }, { timeout: 3000, interval: 50 });
    expect(r.waited).toBeGreaterThanOrEqual(150);
  });

  it('idle 条件：计数增长会重置静默窗口（区分「真静默」与「还在发请求」）', async () => {
    // jsdom 无真实网络，恒静默——上一条用例对「重置逻辑」零区分力（false-guard
    // 删掉 quietSince 更新它照样过）。此用例用 spy 伪造资源流：前 ~450ms 内每次
    // 调用计数 +1（模拟持续请求），之后恒定在停止时刻的值。若重置逻辑正确，
    // 静默窗口只能从最后一次增长起算，waited ≥ 450+200−轮询粒度；若重置丢失
    // （quietSince 只在起点设一次），开头就开始累计静默，waited ≈ idle=200，
    // 远达不到下面的下限。
    let tick = 0;
    const t0 = Date.now();
    const spy = vi.spyOn(performance, 'getEntriesByType').mockImplementation(((type: string) => {
      if (type !== 'resource') return [];
      if (Date.now() - t0 < 450) { tick += 1; return new Array(tick).fill(0); }
      return new Array(tick).fill(0);   // 恒定期：长度冻结在停止增长时的值
    }) as unknown as typeof performance.getEntriesByType);
    const r = await waitFor({ idle: 200 }, { timeout: 5000, interval: 50 });
    spy.mockRestore();
    // 450ms 增长期 + 200ms 静默窗口，留 50ms 轮询粒度余量
    expect(r.waited).toBeGreaterThanOrEqual(600);
  });
});

describe('waitFor（fake timers）', () => {
  beforeEach(() => { resetUidMap(); document.body.innerHTML = ''; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('元素稍后出现时等到它（fake timers 快进）', async () => {
    const p = waitFor({ role: 'dialog' }, { timeout: 5000, interval: 100 });
    setTimeout(() => { document.body.innerHTML = '<div role="dialog">来了</div>'; }, 300);
    await vi.advanceTimersByTimeAsync(500);
    await expect(p).resolves.toBeDefined();
  });

  it('gone 条件：元素消失后返回', async () => {
    document.body.innerHTML = '<div class="loading">加载中</div>';
    const p = waitFor({ gone: '.loading' }, { timeout: 5000, interval: 100 });
    setTimeout(() => { document.body.innerHTML = ''; }, 200);
    await vi.advanceTimersByTimeAsync(400);
    await expect(p).resolves.toBeDefined();
  });
});

describe('waitFor 超时预算（interval clamp）', () => {
  beforeEach(() => { resetUidMap(); document.body.innerHTML = ''; });

  it('interval > timeout 时实际等待不超时预算一个 interval（clamp 到 timeout）', async () => {
    // 审查探针实录：不 clamp 时 waitFor({idle}, {timeout:500, interval:5000}) 超冲到 5001ms
    //（首次 sleep 跳过超时判定）。clamp 后第一次 sleep 即 interval=timeout=500，
    // 超时错误应约在 500ms 抛出而非 5000ms。
    const t0 = Date.now();
    const err = await catchStepError(waitFor({ idle: 2000 }, { timeout: 500, interval: 5000 }));
    expect(err.kind).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
