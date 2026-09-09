/** 标识几何与 public/brand/*.svg 严格一致（viewBox 32、双臂 4.6、mask 缺口 6.7、躯干 4.4×10.52）。
 *  同页多次内联时 mask id 会撞车，故按用途取独立前缀，沿用项目既有 vv-weave-* 命名。 */
export function LogoMark({ id = 'lp', size = 26 }: { id?: string; size?: number }) {
  const mid = `vv-weave-${id}`;
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} role="img" aria-label="织雀AI脚本">
      <defs>
        <mask id={mid}>
          <rect width="32" height="32" fill="#fff" />
          <path d="M5 9.22 L19.2 22.77" fill="none" stroke="#000" strokeWidth="6.7" />
        </mask>
      </defs>
      <g fill="none" stroke="#53589a" strokeWidth="4.6">
        <path d="M27 9.22 L12.8 22.77" mask={`url(#${mid})`} />
        <path d="M5 9.22 L19.2 22.77" />
      </g>
      <rect x="13.8" y="10.3" width="4.4" height="10.52" rx="2.2" fill="#1c1c22" />
    </svg>
  );
}

/** 单色版：走 currentColor，随文字色。 */
export function LogoMono({ id = 'lpm', size = 18 }: { id?: string; size?: number }) {
  const mid = `vv-weave-${id}`;
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} fill="currentColor" role="img" aria-label="织雀AI脚本">
      <defs>
        <mask id={mid}>
          <rect width="32" height="32" fill="#fff" />
          <path d="M5 9.22 L19.2 22.77" fill="none" stroke="#000" strokeWidth="6.7" />
        </mask>
      </defs>
      <g fill="none" stroke="currentColor" strokeWidth="4.6">
        <path d="M27 9.22 L12.8 22.77" mask={`url(#${mid})`} />
        <path d="M5 9.22 L19.2 22.77" />
      </g>
      <rect x="13.8" y="10.3" width="4.4" height="10.52" rx="2.2" fill="currentColor" />
    </svg>
  );
}

/** GitHub 标记。lucide v1 起移除品牌图标，故手写官方 mark 路径。 */
export function GithubMark({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.07-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
