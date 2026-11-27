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
      // 修复：不再写 LS_LAST。原逻辑上传后把游标推到"现在"，导致本机下次
      // 下载时 since=now，把其他设备在此之前上传的数据全部过滤掉（iOS 下载失败的根因）。
      return { applied: rows };
    },
    async pull() {
      if (!isOn()) return { skipped: true, rows: [] };
      // 全量拉取：since=0 时服务端不加 updated_at 过滤。
      // 是否应用由 applyChanges 逐条按 bio_ts 做 LWW 判断，避免依赖设备间不可靠的时间游标。
      const rows = await call('pull', { since: 0 });
      applyChanges(rows);
      localStorage.setItem(LS_LAST, String(Date.now())); // 仅用于状态显示，不再作为过滤条件
      return { applied: rows.length };
    },
    /* 供设置页显示状态 */
    status() {
      return { on: isOn(), code: code(), device: deviceId, last: localStorage.getItem(LS_LAST) || '—' };
    }
  };
})();
