/* =================================================================
   一致性验证：同一份统计规格，JS 与浏览器内 Python 双实现对照。
   课程作业"评估"教学点：把"算得对不对"变成页面可见的一致率 6/6。
   ================================================================= */
function _fixtures() {
  const mk = (dates, min) => {
    const o = {};
    dates.forEach(d => { o[d] = [{ t: '快走', min: min }]; });
    return o;
  };
  const days = d => Array.from({ length: 7 }, (_, i) => '2026-11-' + String(21 + i).padStart(2, '0'));
  const all = days();
  return [
    { name: '正常7天', ex: mk(all, 30) },
    { name: '含缺失值', ex: Object.assign(mk(all, 30), { '2026-11-23': [{ t: '跑步', min: null }] }) },
    { name: '含异常值', ex: Object.assign(mk(all, 30), { '2026-11-24': [{ t: '跑步', min: 400 }] }) },
    { name: '有效2天', ex: mk(all.slice(0, 2), 25) },
    { name: '有效3天边界', ex: mk(all.slice(0, 3), 25) },
    { name: '空数据', ex: {} },
  ];
}

function _pick(s) {
  return {
    minutes: s.totals.minutes,
    valid: s.coverage.days_with_valid_record,
    missing: s.counts.records_missing_value,
    excluded: s.counts.records_excluded,
    mean: s.averages.mean_per_day,
    direction: s.trend.direction,
    insufficient: s.insufficient,
  };
}

function _near(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 0.05;
  return false;
}

function verifyParity() {
  if (!window.PY_READY) return { ok: false, reason: 'Python 引擎未就绪', rows: [] };
  const start = '2026-11-21', end = '2026-11-27';
  const rows = _fixtures().map(f => {
    const js = _pick(spSummarizeExercise(start, end, f.ex));
    const P = pyCall('sp_summarize_exercise', { ex: f.ex, start: start, end: end });
    if (!P.ok) return { name: f.name, ok: false, js: js, py: null };
    const py = _pick(P.data);
    const keys = Object.keys(js);
    const diffs = keys.filter(k => !_near(js[k], py[k]));
    return { name: f.name, ok: diffs.length === 0, js: js, py: py, diffs: diffs };
  });
  const passed = rows.filter(r => r.ok).length;
  return { ok: passed === rows.length, passed: passed, total: rows.length, rows: rows };
}

function showParity() {
  const r = verifyParity();
  if (!r.total) { alert(r.reason || '验证失败'); return; }
  const lines = r.rows.map(x =>
    (x.ok ? '✅ ' : '❌ ') + x.name +
    ' ｜ JS ' + x.js.minutes + '分/' + x.js.valid + '天 ｜ Python ' +
    (x.py ? x.py.minutes + '分/' + x.py.valid + '天' : '—') +
    (x.diffs && x.diffs.length ? ' ｜ 差异:' + x.diffs.join(',') : '')
  );
  const w = window.open('', '_blank');
  if (!w) { alert('弹窗被拦截'); return; }
  w.document.write('<!DOCTYPE html><html><head><meta charset="utf-8"><title>JS / Python 一致性验证</title>' +
    '<style>body{font-family:system-ui,sans-serif;background:#faf8fa;color:#2c2c34;padding:24px}' +
    'h3{color:#b5485a}pre{white-space:pre-wrap;line-height:1.9;font-size:13px}</style></head><body>' +
    '<h3>计算思维 · 双实现一致性验证</h3>' +
    '<p>一致率：<b>' + r.passed + '/' + r.total + '</b>（同一规格的 JS 与 Python 实现对照）</p>' +
    '<pre>' + lines.map(s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')).join('\n') + '</pre>' +
    '</body></html>');
  w.document.close();
}
