/* =================================================================
   云同步层（本地优先 + 可选上云）
   - 默认关闭：不配置 syncCode 时，所有操作都是纯本地 no-op
   - 配对码：6 位码关联多设备，不依赖账号
   - 冲突：字段级 last-write-wins（按 updated_at）
   - journal（心情日记）永不进入 changes —— 隐私硬约束
   依赖：store.js（DB）、bus.js（Bus）
   ================================================================= */
const Sync = (() => {
  const LS_DEVICE = 'bio_device_id';
  const LS_CODE = 'bio_sync_code';
  const LS_ENABLED = 'bio_sync_enabled';
  const LS_LAST = 'bio_sync_last';
  const ENDPOINT = () => window.SYNC_ENDPOINT || ''; // 部署后在 index.html 顶部配置

  const deviceId = (() => {
    let id = localStorage.getItem(LS_DEVICE);
    if (!id) { id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); localStorage.setItem(LS_DEVICE, id); }
    return id;
  })();

  const isOn = () => localStorage.getItem(LS_ENABLED) === '1' && !!localStorage.getItem(LS_CODE);
  const code = () => localStorage.getItem(LS_CODE);

  /* 可同步的桶；journal 明确排除 */
  const SYNC_BUCKETS = ['water', 'sleep', 'diet', 'ex', 'steps', 'foods', 'sportProfile', 'sportPlans', 'sportFeedbacks'];

  function collectChanges() {
    const out = [];
    const stamp = Date.now();
    SYNC_BUCKETS.forEach(bucket => {
      const val = DB[bucket];
      if (val == null) return;
      if (typeof val === 'object' && !Array.isArray(val)) {
        Object.keys(val).forEach(k => {
          out.push({ bucket, rec_key: k, payload: val[k], updated_at: stamp, deleted: false });
        });
      } else {
        out.push({ bucket, rec_key: '_all', payload: val, updated_at: stamp, deleted: false });
      }
    });
    return out;
  }

  function applyChanges(rows) {
    let touched = false;
    (rows || []).forEach(r => {
      if (!SYNC_BUCKETS.includes(r.bucket)) return; // 二次防线：journal 永不被写入
      const cur = DB[r.bucket];
      const oldTs = +(localStorage.getItem('bio_ts_' + r.bucket + '_' + r.rec_key) || 0);
      if (r.updated_at <= oldTs) return;
      if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
        if (r.deleted) delete cur[r.rec_key];
        else cur[r.rec_key] = r.payload;
      } else {
        DB[r.bucket] = r.payload;
      }
      localStorage.setItem('bio_ts_' + r.bucket + '_' + r.rec_key, String(r.updated_at));
      touched = true;
    });
    if (touched) { save(); Bus.emit('sync:applied', rows); }
    return touched;
  }

  async function call(op, extra) {
    if (!ENDPOINT()) throw new Error('云端地址未配置（本地模式）');
    const resp = await fetch(ENDPOINT() + '/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ op, sync_code: code(), device_id: deviceId }, extra || {}))
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || '同步失败');
    return data.data;
  }

  return {
    deviceId,
    isOn,
    code,
    enable(c) {
      localStorage.setItem(LS_CODE, String(c).trim().toUpperCase());
      localStorage.setItem(LS_ENABLED, '1');
    },
    disable() { localStorage.setItem(LS_ENABLED, '0'); },
    /* 创建配对码：云端不可用时本地生成一个（仅作演示，云端正式码以服务端返回为准） */
    async createCode() {
      if (!ENDPOINT()) return 'LOCAL-' + Math.random().toString(36).slice(2, 8).toUpperCase();
      const d = await call('create', {});
      return d.sync_code;
    },
    async push() {
      if (!isOn()) return { skipped: true };
      const rows = await call('push', { changes: collectChanges() });
      localStorage.setItem(LS_LAST, String(Date.now()));
      return { applied: rows };
    },
    async pull() {
      if (!isOn()) return { skipped: true, rows: [] };
      const rows = await call('pull', { since: +(localStorage.getItem(LS_LAST) || 0) });
      applyChanges(rows);
      localStorage.setItem(LS_LAST, String(Date.now()));
      return { applied: rows.length };
    },
    /* 供设置页显示状态 */
    status() {
      return { on: isOn(), code: code(), device: deviceId, last: localStorage.getItem(LS_LAST) || '—' };
    }
  };
})();
