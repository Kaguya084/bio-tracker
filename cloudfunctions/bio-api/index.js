/* =================================================================
   CloudBase HTTP Function bio-api —— bio-tracker 服务端代理
   1) POST /ai   —— 代理 DeepSeek，DEEPSEEK_API_KEY 只存云端环境变量
   2) POST /sync —— 配对码同步 push/pull/create，走 PG REST API
   数据访问：https://{envId}.api.tcloudbasegateway.com/v1/rdb/rest/{table}
   鉴权：Authorization: Bearer <CLOUDBASE_API_KEY>（service_role，绕过 RLS）
   —— SHARED PG 无 NoSQL 后端；node-sdk 的 rdb() 运行时未实现，故用官方 REST 契约。
   CORS：由 HTTP 网关按安全域名注入，函数本身不设置 Allow-Origin。
   ================================================================= */
const https = require('https');
const http = require('http');
const { URL } = require('url');

const ENV_ID = process.env.TCB_ENV_ID || 'project-labyrinth-d4dsyd0c9116e7';
const API_KEY = process.env.CLOUDBASE_API_KEY || '';
const PG_HOST = ENV_ID + '.api.tcloudbasegateway.com';

function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

/* ---------- PG REST 通用请求 ---------- */
function pgRequest(method, table, query, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    if (!API_KEY) return reject(new Error('服务端未配置 CLOUDBASE_API_KEY'));
    const path = '/v1/rdb/rest/' + table + (query ? '?' + query : '');
    const payload = body != null ? JSON.stringify(body) : null;
    const headers = Object.assign({
      'Authorization': 'Bearer ' + API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }, extraHeaders || {});
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request({ hostname: PG_HOST, path, method, headers, timeout: 15000 }, resp => {
      let raw = '';
      resp.on('data', c => raw += c);
      resp.on('end', () => {
        if (resp.statusCode >= 200 && resp.statusCode < 300) {
          try { resolve(raw ? JSON.parse(raw) : []); } catch (e) { resolve(raw); }
        } else {
          reject(new Error('PG ' + resp.statusCode + ': ' + raw.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('PG 请求超时')));
    if (payload) req.write(payload);
    req.end();
  });
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
        try { resolve(JSON.parse(raw).choices[0].message.content); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('DeepSeek 请求超时')));
    req.write(payload);
    req.end();
  });
}

/* ---------- 配对码与同步 ---------- */
function randomCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 排除易混淆 0/O/1/I
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
const enc = s => encodeURIComponent(s);

async function syncPush(body) {
  const { sync_code, device_id, changes } = body;
  if (!sync_code || !device_id || !Array.isArray(changes)) throw new Error('push 参数不完整');
  const results = [];
  for (const ch of changes) {
    const { bucket, rec_key, payload, updated_at, deleted } = ch;
    if (!bucket || !rec_key || typeof updated_at !== 'number') continue;
    const q = 'sync_code=eq.' + enc(sync_code) + '&bucket=eq.' + enc(bucket) +
              '&rec_key=eq.' + enc(rec_key) + '&select=id,updated_at&limit=1';
    const old = await pgRequest('GET', 'health_sync', q);
    const prev = Array.isArray(old) ? old[0] : null;
    if (prev && Number(prev.updated_at) > updated_at) {
      results.push({ bucket, rec_key, applied: false, reason: 'older' });
      continue;
    }
    const doc = { sync_code, device_id, bucket, rec_key,
      payload: payload || {}, updated_at, deleted: !!deleted };
    if (prev && prev.id) await pgRequest('PATCH', 'health_sync', 'id=eq.' + enc(prev.id), doc);
    else await pgRequest('POST', 'health_sync', '', doc, { 'Prefer': 'return=minimal' });
    results.push({ bucket, rec_key, applied: true });
  }
  try {
    await pgRequest('PATCH', 'sync_pairs', 'sync_code=eq.' + enc(sync_code),
      { last_seen: new Date().toISOString() });
  } catch (e) { /* 配对记录不存在不影响主流程 */ }
  return results;
}

async function syncPull(body) {
  const { sync_code, since } = body;
  if (!sync_code) throw new Error('pull 缺少 sync_code');
  let q = 'sync_code=eq.' + enc(sync_code) + '&select=bucket,rec_key,payload,updated_at,deleted&limit=1000';
  if (since) q += '&updated_at=gt.' + enc(String(since));
  const rows = await pgRequest('GET', 'health_sync', q);
  return (Array.isArray(rows) ? rows : []).map(r => ({
    bucket: r.bucket, rec_key: r.rec_key, payload: r.payload,
    updated_at: r.updated_at, deleted: !!r.deleted
  }));
}

async function syncCreate(body) {
  const code = body.force_code || randomCode();
  const exist = await pgRequest('GET', 'sync_pairs',
    'sync_code=eq.' + enc(code) + '&select=sync_code&limit=1');
  if (Array.isArray(exist) && exist.length) {
    if (!body.force_code) return syncCreate({});
    return { sync_code: code, reused: true };
  }
  await pgRequest('POST', 'sync_pairs', '',
    { sync_code: code, created_at: new Date().toISOString(), last_seen: new Date().toISOString() },
    { 'Prefer': 'return=minimal' });
  return { sync_code: code, reused: false };
}

/* ---------- HTTP server（监听 9000） ---------- */
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
  try {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    const body = await readJsonBody(req);
    if (pathname.endsWith('/ai')) {
      if (!body.system || !body.payload) throw new Error('ai 参数不完整');
      return sendJson(res, 200, { ok: true, text: await callDeepSeek(body.system, body.payload) });
    }
    if (pathname.endsWith('/sync')) {
      if (body.op === 'create') return sendJson(res, 200, { ok: true, data: await syncCreate(body) });
      if (body.op === 'push')  return sendJson(res, 200, { ok: true, data: await syncPush(body) });
      if (body.op === 'pull')  return sendJson(res, 200, { ok: true, data: await syncPull(body) });
      throw new Error('未知 sync op');
    }
    if (pathname === '/' || pathname === '/health') return sendJson(res, 200, { ok: true, service: 'bio-api' });
    return sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: e.message || String(e) });
  }
});

server.listen(9000, '0.0.0.0');
