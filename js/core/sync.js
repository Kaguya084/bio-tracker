/* =================================================================
   云同步层（本地优先 + 可选上云）
   - 默认关闭：未登录时所有操作都是纯本地 no-op
   - 身份：由 Auth 模块注入 uid + token（CloudBase 官方 Auth）
   - 冲突：字段级 last-write-wins（按 updated_at）
   - journal（心情日记）永不进入 changes —— 隐私硬约束
   依赖：store.js（DB）、bus.js（Bus）、auth.js（注入身份）
   ================================================================= */
const Sync = (() => {
  const LS_DEVICE = 'bio_device_id';
  const LS_LAST = 'bio_sync_last';
  const ENDPOINT = () => window.SYNC_ENDPOINT || ''; // 云函数网关地址

  const deviceId = (() => {
    let id = localStorage.getItem(LS_DEVICE);
    if (!id) { id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); localStorage.setItem(LS_DEVICE, id); }
    return id;
  })();

  /* 身份由 auth.js 注入；getUid/getToken 是返回 Promise 的异步函数 */
  let identity = null;
  const isOn = () => !!(identity && typeof identity.getUid === 'function');
  const setIdentityFromAuth = (fns) => { identity = fns; };
  const clearIdentity = () => { identity = null; };

  /* 可同步的桶；journal 明确排除 */
  const SYNC_BUCKETS = ['water', 'sleep', 'diet', 'ex', 'steps', 'foods', 'sportProfile', 'sportPlans', 'sportFeedbacks'];

  /* 稳定序列化：键序固定，避免对象键顺序抖动被误判为"内容变化" */
  function stableStr(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableStr).join(',') + ']';
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStr(v[k])).join(',') + '}';
  }

  /* 逐条记录维护修改时间：
     - 用内容签名与上次上传的签名比对，内容变了才刷新时间戳
     - 未变化的记录沿用旧 ts，避免每次 push 把全部记录刷成最新
       （否则一台设备上传会覆盖另一台刚改的数据，退化成"最后上传者赢"）
     - applyChanges 从云端应用数据后也更新签名，避免把刚下载的数据再当本地改动上传 */
  function collectChanges() {
    const out = [];
    const now = Date.now();
    SYNC_BUCKETS.forEach(bucket => {
      const val = DB[bucket];
      if (val == null) return;
      const emit = (key, payload) => {
        const tkey = 'bio_ts_' + bucket + '_' + key;
        const skey = 'bio_sig_' + bucket + '_' + key;
        const sig = stableStr(payload);
        const prevSig = localStorage.getItem(skey);
        let ts = +(localStorage.getItem(tkey) || 0);
        if (!ts || prevSig !== sig) {
          ts = now;                       // 新记录或内容确有变化 → 刷新时间
          localStorage.setItem(tkey, String(ts));
          localStorage.setItem(skey, sig);
        }
        out.push({ bucket, rec_key: key, payload, updated_at: ts, deleted: false });
      };
      if (typeof val === 'object' && !Array.isArray(val)) {
        Object.keys(val).forEach(k => emit(k, val[k]));
      } else {
        emit('_all', val);
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
      localStorage.setItem('bio_sig_' + r.bucket + '_' + r.rec_key, stableStr(r.payload));
      touched = true;
    });
    if (touched) { save(); Bus.emit('sync:applied', rows); }
    return touched;
  }

  async function call(op, extra) {
    if (!ENDPOINT()) throw new Error('云端地址未配置（本地模式）');
    if (!isOn()) throw new Error('未登录');
    const token = await identity.getToken();
    const resp = await fetch(ENDPOINT() + '/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify(Object.assign({ op, device_id: deviceId }, extra || {}))
    });
    if (resp.status === 401) throw new Error('登录已过期，请重新登录');
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || '同步失败');
    return data.data;
  }

  return {
    deviceId,
    isOn,
    setIdentityFromAuth: setIdentityFromAuth,
    clearIdentity: clearIdentity,
    async push() {
      if (!isOn()) return { skipped: true };
      const rows = await call('push', { changes: collectChanges() });
      // 不写 LS_LAST：避免上传后把游标推到"现在"导致后续拉取过滤掉他机数据。
      return { applied: rows };
    },
    async pull() {
      if (!isOn()) return { skipped: true, rows: [] };
      // 全量拉取；是否应用由 applyChanges 逐条按 bio_ts 做 LWW 判断。
      const rows = await call('pull', { since: 0 });
      applyChanges(rows);
      localStorage.setItem(LS_LAST, String(Date.now())); // 仅状态显示
      return { applied: rows.length };
    },
    /* 供设置页显示状态 */
    status() {
      return {
        on: isOn(),
        email: localStorage.getItem('bio_auth_email') || '',
        device: deviceId,
        last: localStorage.getItem(LS_LAST) || '—'
      };
    }
  };
})();
