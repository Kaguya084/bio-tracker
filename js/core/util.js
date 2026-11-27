/* =================================================================
   Project Labyrinth · bio-tracker — 纯工具层（无状态，最先加载）
   从 index.html 原 L1226-1229 / L1493 / L2053 / L3141 抽出，保持函数体逐字不变。
   ================================================================= */
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const TODAY = today();
const fmt = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
/* 完整 HTML 转义：原实现只转义引号，食物名等进入 innerHTML 时可被注入标签 */
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const jesc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function last7() { const a = []; for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); a.push(fmt(d)); } return a; }
