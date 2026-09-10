// shared/brand.ts
// 品牌口径唯一入口：名称/官网/仓库/反馈地址集中此处，UI 各面（popup、设置关于页、脚本详情页）复用。
// 改口径时联动 CLAUDE.md「slogan 口径联动六处」清单。
export const BRAND = {
  /** 中文全称字标 */
  name: '织雀AI脚本',
  /** 短名（popup 主入口按钮/精简处用） */
  short: '织雀AI',
  /** 拉丁副标（mono 大写渲染） */
  latin: 'Vevscript-ai',
  /** 官网 */
  site: 'https://vevscript.yutkit.com',
  /** 开源仓库 */
  repo: 'https://github.com/yutian0525/VevScript-AI',
  /** 问题反馈（仓库 issues） */
  issues: 'https://github.com/yutian0525/VevScript-AI/issues',
  /** 开源协议（仓库 LICENSE 文件） */
  license: 'https://github.com/yutian0525/VevScript-AI/blob/main/LICENSE',
} as const;
