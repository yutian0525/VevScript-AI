# 织雀AI脚本 · 宣传页

[织雀AI脚本 Vevscript-ai](https://github.com/yutian0525/VevScript-AI) 的宣传页。独立站点，与扩展的 WXT 构建互不干扰（各自 `package.json` / `node_modules` / 产物目录；根 `tsconfig.json` 已把本目录排除在扩展类型检查外）。

**改文案前先读**仓库根 [CLAUDE.md](../CLAUDE.md) 的「宣传页 landing/」一节。两条硬约束容易踩：slogan 有六处联动需一起改；章节顺序必须与 README 一致（先说人话，`#harness` 那节的机件表垫在两条路之后，不许往前挪）。首屏 H1 的 em 那行还有字数上限，加字前先量。

```bash
npm install
npm run dev      # 开发服务器
npm run build    # tsc --noEmit && vite build → dist/
npm run preview  # 预览产物
```

`base: './'`，产物可直接丢到任意静态托管的子路径（含 GitHub Pages 的 `/VevScript-AI/`）。

## 结构

```text
index.html              两条 MiSans <link> 在这里（不在 CSS 里）
src/
  main.tsx              入口
  App.tsx               壳：跳转链接 + 站头 + 路由出口 + 页脚
  router.ts             手写 hash 路由（两个页面不值当引路由库）+ REPO 常量
  styles.css            全部样式（承扩展侧"样式集中在一个文件"的约定）
  pages/Home.tsx        首页
  pages/Docs.tsx        使用文档页（留空态：章节骨架 + 仓库内 md 去处）
  components/
    Chrome.tsx          站头 / 页脚
    Logo.tsx            标识三态（mark / mono / GitHub mark）
    RichText.tsx        把 `反引号` 渲染成 mono 芯片（不用 innerHTML）
    Demo.tsx            首屏签名装置：编排 + 滚入自动播
    DemoPanel.tsx       仿真侧边栏（会话流 / 工具卡 / tag / 输入框）
    DemoPage.tsx        仿真网页（信息流卡片，脚本作用的对象）
  demo/
    cards.ts            仿真信息流数据
    script.ts           三个场景的演出脚本（纯数据 beat 数组）
    useRunner.ts        时间线执行器（timer 统一管控 + 可取消）
public/brand/           标识 SVG（从扩展 public/brand 拷来，保持同源）
```

## 改动前须知

字体、字重 token、44° 编织几何、以及一串已经踩平的排版坑（栅格 `minmax(0,1fr)`、JSX 中文换行多空格、悬停放大方向、仿真标题不进文档大纲等），都记在仓库根 [CLAUDE.md](../CLAUDE.md) 的「宣传页 landing/」一节。动手前先读那一节，能省一遍重复踩坑。
