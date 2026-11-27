/* =================================================================
   Python 桥：JS → 浏览器内 Python（PyScript/Pyodide）
   设计：单一 JSON 字符串接口，避免 dict→JS object 代理转换坑。
   所有调用点必须做降级：Python 未就绪时回退既有 JS 实现。
   ================================================================= */
window.PY_READY = false;

function pyCall(op, data) {
  if (!window.PY_READY || typeof window.pyCompute !== 'function') {
    return { ok: false, data: null, reason: 'not-ready' };
  }
  try {
    const raw = window.pyCompute(JSON.stringify({ op: op, data: data || {} }));
    const r = JSON.parse(raw);
    return { ok: r.ok !== false, data: r.data, reason: r.error || null };
  } catch (e) {
    return { ok: false, data: null, reason: String(e && e.message || e) };
  }
}

/* 状态条三态控制 */
(function initPyStatus() {
  const show = (text, kind) => {
    const el = document.getElementById('pyStatus');
    if (!el) return;
    el.textContent = text;
    el.className = 'py-status on ' + (kind || '');
    if (kind === 'ok') setTimeout(() => { el.classList.remove('on'); }, 3000);
  };
  window.__pyStatusShow = show;

  // 等待 Python 就绪（上限 20 秒）；py:ready 事件可提前触发
  const start = Date.now();
  const poll = setInterval(() => {
    if (window.PY_READY) {
      clearInterval(poll);
      let passed = '—';
      try {
        const r = pyCall('self_test', {});
        if (r.ok && r.data) passed = r.data.passed + '/' + r.data.total;
      } catch (e) {}
      show('Python 已就绪 · 自测 ' + passed, 'ok');
      window.dispatchEvent(new Event('pyboost:ready'));
    } else if (Date.now() - start > 20000) {
      clearInterval(poll);
      show('Python 未就绪，继续使用 JS 计算', 'idle');
    }
  }, 100);
  document.addEventListener('py:ready', () => {
    // Pyodide 解释器已启动，但 pyCompute 代理可能还在绑定，交给轮询确认
  });
})();

/* 查看 Python 源码（教学演示用） */
function showPySource() {
  const src = document.getElementById('py-src');
  if (!src) return;
  const w = window.open('', '_blank');
  if (!w) { alert('弹窗被拦截，请允许本页弹窗'); return; }
  w.document.write('<!DOCTYPE html><html><head><meta charset="utf-8"><title>py/main.py · Python 源码</title>' +
    '<style>body{font-family:ui-monospace,Consolas,monospace;background:#faf8fa;color:#2c2c34;padding:24px;line-height:1.6}' +
    'pre{white-space:pre-wrap}</style></head><body><h3>校园健康助手 · Python 计算内核</h3><pre>' +
    src.textContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
    '</pre></body></html>');
  w.document.close();
}
