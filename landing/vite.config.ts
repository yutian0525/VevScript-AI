import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 宣传页是独立站点，与扩展的 WXT 构建完全隔离（各自 package.json / node_modules / 产物目录）。
// base 用相对路径：产物可直接丢到任意子路径（GitHub Pages 的 /VevScript-AI/ 也能开）。
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: 'dist', assetsDir: 'assets' },
});
