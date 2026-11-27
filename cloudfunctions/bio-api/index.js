/* =================================================================
   CloudBase 云函数 bio-api —— bio-tracker 的服务端代理
   职责：
   1) /ai   —— 代理 DeepSeek，API Key 只存服务端环境变量，前端永不接触
   2) /sync —— 配对码同步：push(字段级 LWW) / pull / create-pair
   数据表 health_sync / sync_pairs 已开启 RLS 且无策略（拒绝浏览器直连），
   本函数使用服务端凭据访问，是唯一合法入口。
   ================================================================= */
const tcb = require('@cloudbase/node-sdk');
const https = require('https');

const app = tcb.init({ env: tcb.SYMBOL_CURRENT_ENV });
const db = app.database();

/* 前端只认识这两个集合名；底层 PG 表由云端映射。兼容 NoSQL SDK 写法以适配
   SHARED PG 的文档兼容层；若环境切换为纯 PG，请将此处改为 app.rdb().from()。 */
const C_SYNC = 'health_sync';
const C_PAIR = 'sync_pairs';

function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(body));
}

function readBody(event) {
  if (event.body && typeof event.body === 'string') return JSON.parse(event.body);
  return event.body || {};
}

/* ---------- AI 代理 ---------- */
function callDeepSeek(systemPrompt, userPayload) {
  return new Promise((resolve, reject) => {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) return reject(new Error('服务端未配置 DEEPSEEK_API_KEY'));
    const payload = JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPayload }
      ],
      temperature: 0.3
    });
    const req = https.request({
      hostname: 'api.deepseek.com', path: '/v1/chat/completions', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key,
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 20000
    }, resp => {
      let raw = '';
      resp.on('data', c => raw += c);
      resp.on('end', () => {
        if (resp.statusCode < 200 || resp.statusCode >= 300)
          return reject(new Error('DeepSeek HTTP ' + resp.statusCode + ': ' + raw.slice(0, 120)));
        try {
          const data = JSON.parse(raw);
          resolve(data.choices[0].message.content);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('DeepSeek 请求超时')));
    req.write(payload);
    req.end();
  });
}

/* ---------- 配对码 ---------- */
function randomCode() {
  // 排除易混淆字符 0/O/1/I
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/* ---------- 同步核心：字段级 last-write-wins ---------- */
async function syncPush(body) {
  const { sync_code, device_id, changes } = body;
  if (!sync_code || !device_id || !Array.isArray(changes))
    throw new Error('push 参数不完整');

  const results = [];
  for (const ch of changes) {
    const { bucket, rec_key, payload, updated_at, deleted } = ch;
    if (!bucket || !rec_key || typeof updated_at !== 'number')
      continue;
    // 先查该行现有版本
    const q = await db.collection(C_SYNC).where({
      sync_code, bucket, rec_key
    }).limit(1).get();
    const old = q.data && q.data[0];
    if (old && old.updated_at > updated_at) {
      results.push({ bucket, rec_key, applied: false, reason: 'older' });
      continue;
    }
    const doc = {
      sync_code, device_id, bucket, rec_key,
      payload: payload || {},
      updated_at,
      deleted: !!deleted,
      server_time: Date.now()
    };
    if (old && old._id) await db.collection(C_SYNC).doc(old._id).update(doc);
    else await db.collection(C_SYNC).add(doc);
    results.push({ bucket, rec_key, applied: true });
  }
  // 刷新配对活跃时间
  try { await db.collection(C_PAIR).doc(sync_code).update({ last_seen: Date.now() }); } catch (e) {}
  return results;
}

async function syncPull(body) {
  const { sync_code, since } = body;
  if (!sync_code) throw new Error('pull 缺少 sync_code');
  const q = await db.collection(C_SYNC).where({ sync_code }).limit(1000).get();
  const rows = (q.data || []).filter(r => !since || r.updated_at > since);
  return rows.map(r => ({
    bucket: r.bucket, rec_key: r.rec_key, payload: r.payload,
    updated_at: r.updated_at, deleted: !!r.deleted
  }));
}

async function syncCreate(body) {
  const code = body.force_code || randomCode();
  const q = await db.collection(C_PAIR).where({ sync_code: code }).limit(1).get();
  if (q.data && q.data.length) {
    if (!body.force_code) return syncCreate({}); // 碰撞则重抽
    return { sync_code: code, reused: true };
  }
  await db.collection(C_PAIR).add({ sync_code: code, created_at: Date.now(), last_seen: Date.now() });
  return { sync_code: code, reused: false };
}

/* ---------- HTTP 入口 ---------- */
exports.main = async (event, context) => {
  const res = context.res;
  if (!res) return { code: 400, msg: '需通过 HTTP 访问方式调用' };
  try {
    const body = readBody(event);
    const action = (event.path || '').split('/').filter(Boolean).pop() || body.action;

    if (action === 'ai') {
      if (!body.system || !body.payload) throw new Error('ai 参数不完整');
      const text = await callDeepSeek(body.system, body.payload);
      return json(res, 200, { ok: true, text });
    }
    if (action === 'sync') {
      const op = body.op;
      if (op === 'create') return json(res, 200, { ok: true, data: await syncCreate(body) });
      if (op === 'push')  return json(res, 200, { ok: true, data: await syncPush(body) });
      if (op === 'pull')  return json(res, 200, { ok: true, data: await syncPull(body) });
      throw new Error('未知 sync op');
    }
    return json(res, 404, { ok: false, error: 'unknown action' });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message || String(e) });
  }
};
