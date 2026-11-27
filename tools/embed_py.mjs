/* 把 py/main.py 同步进 index.html 的 <script type="text/plain" id="py-src"> 块。
   用法：node tools/embed_py.mjs
   原因：file:// 下不能用 fetch 加载本地 .py，只能内联；但源码真源仍是 py/main.py。 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pyPath = path.join(root, 'py', 'main.py');
const htmlPath = path.join(root, 'index.html');

const py = fs.readFileSync(pyPath, 'utf8');
if (py.includes('</script')) {
  console.error('ERROR: Python 源码含 </script，会截断 HTML 内联块');
  process.exit(1);
}
let html = fs.readFileSync(htmlPath, 'utf8');

const open = '<script type="text/plain" id="py-src">';
const close = '</script>';
const i = html.indexOf(open);
if (i < 0) {
  console.error('ERROR: 未找到 <script id="py-src"> 占位块，请先在 index.html 插入');
  process.exit(1);
}
const bodyStart = i + open.length;
const j = html.indexOf(close, bodyStart);
if (j < 0) {
  console.error('ERROR: 未找到 py-src 块的闭合标签');
  process.exit(1);
}
const before = html.slice(0, bodyStart);
const after = html.slice(j);
const next = before + py + after;
if (next === html) {
  console.log('OK: py-src 已是最新，无需改动');
} else {
  fs.writeFileSync(htmlPath, next);
  console.log('OK: 已把 py/main.py (' + py.split('\n').length + ' 行) 同步进 index.html');
}
