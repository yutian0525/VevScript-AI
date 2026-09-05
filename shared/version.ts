// 版本号比较（spec §1.5）：按 '.' 分段逐段比；数字段数值比较、非数字段字符串比较；段数不齐短补零。
// 缺失/空串视为 '0'——远端无 @version 时不误报有更新。

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const segs = (v: string): string[] => (v.trim() || '0').split('.');
  const A = segs(a);
  const B = segs(b);
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const x = A[i] ?? '0';
    const y = B[i] ?? '0';
    const nx = Number(x);
    const ny = Number(y);
    let c: -1 | 0 | 1;
    if (x !== '' && y !== '' && Number.isFinite(nx) && Number.isFinite(ny)) {
      c = nx === ny ? 0 : nx > ny ? 1 : -1;
    } else {
      c = x === y ? 0 : x > y ? 1 : -1;
    }
    if (c !== 0) return c;
  }
  return 0;
}
