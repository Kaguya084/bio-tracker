/* =================================================================
   CloudBase HTTP Function bio-api —— bio-tracker 服务端代理
   1) POST /ai   —— 代理 DeepSeek（需登录）
   2) POST /sync —— 按 CloudBase Auth 用户 ID(uid) 隔离的 push/pull（需登录）
   鉴权：前端 Authorization: Bearer <CloudBase session access_token>
         云函数 GET /auth/v1/user/me 验签取 sub 作为 owner_uid
   数据访问：https://{envId}.api.tcloudbasegateway.com/v1/rdb/rest/{table}
   PG 访问用 CLOUDBASE_API_KEY（service_role，绕过 RLS）——仅服务端持有。
   零第三方依赖：只用 Node 内置 https/http/url。
   ================================================================= */
const https = require('https');
const http = require('http');
const { URL } = require('url');

const ENV_ID = process.env.TCB_ENV_ID || 'project-labyrinth-d4dsyd0c9116e7';
const API_KEY = process.env.CLOUDBASE_API_KEY || '';
const GATEWAY = ENV_ID + '.api.tcloudbasegateway.com';

/* 单个 Origin 反射，兼容 file:// 的 "null"；Allow-Headers 必须含 Authorization */
function corsHeaders(req) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin'
  };
}
function sendJson(res, code, body, req) {
  res.writeHead(code, Object.assign(
    { 'Content-Type': 'application/json; charset=utf-8' },
    req ? corsHeaders(req) : {}
  ));
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

/* ---------- Auth HTTP API 代理（服务端调用，不受浏览器安全域名限制） ---------- */
function authApi(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body != null ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request({
      hostname: GATEWAY, path: '/auth/v1/' + path, method, headers, timeout: 15000
    }, resp => {
      let raw = '';
      resp.on('data', c => raw += c);
      resp.on('end', () => {
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch (e) { data = { raw: raw.slice(0, 300) }; }
        if (resp.statusCode >= 200 && resp.statusCode < 300) resolve(data);
        else reject(new Error(data.error_description || data.error || ('Auth HTTP ' + resp.statusCode)));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Auth 请求超时')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function handleAuth(body) {
  const op = body.op;
  if (op === 'send') {
    // 发验证码：前端注册第一步
    const d = await authApi('POST', 'verification', { target: 'ANY', email: body.email });
    return { verification_id: d.verification_id, expires_in: d.expires_in };
  }
  if (op === 'verify') {
    // 验验证码：返回 verification_token 给前端（不在这里注册）
    const d = await authApi('POST', 'verification/verify', {
      verification_id: body.verification_id, verification_code: body.code
    });
    return { verification_token: d.verification_token };
  }
  if (op === 'signup') {
    const d = await authApi('POST', 'signup', {
      email: body.email, password: body.password,
      verification_token: body.verification_token, username: body.username
    });
    return { sub: d.sub, access_token: d.access_token, refresh_token: d.refresh_token, expires_in: d.expires_in };
  }
  if (op === 'signin') {
    const d = await authApi('POST', 'signin', { username: body.username, password: body.password });
    return { sub: d.sub, access_token: d.access_token, refresh_token: d.refresh_token, expires_in: d.expires_in };
  }
  if (op === 'refresh') {
    const d = await authApi('POST', 'token', {
      grant_type: 'refresh_token', refresh_token: body.refresh_token, client_id: ENV_ID
    });
    return { access_token: d.access_token, refresh_token: d.refresh_token, expires_in: d.expires_in };
  }
  throw new Error('未知 auth op: ' + op);
}

/* ---------- 鉴权：token -> uid ---------- */
function whoAmI(token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: GATEWAY, path: '/auth/v1/user/me', method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
      timeout: 10000
    }, resp => {
      let raw = '';
      resp.on('data', c => raw += c);
      resp.on('end', () => {
        if (resp.statusCode >= 200 && resp.statusCode < 300) {
          try {
            const u = JSON.parse(raw);
            const uid = u.sub || u.user_id || (u.user && u.user.id) || '';
            if (!uid) return reject(new Error('UNAUTHORIZED'));
            resolve(uid);
          } catch (e) { reject(new Error('UNAUTHORIZED')); }
        } else reject(new Error('UNAUTHORIZED'));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('auth timeout')));
    req.end();
  });
}

/* ---------- PG REST ---------- */
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
    const req = https.request({ hostname: GATEWAY, path, method, headers, timeout: 15000 }, resp => {
      let raw = '';
      resp.on('data', c => raw += c);
      resp.on('end', () => {
        if (resp.statusCode >= 200 && resp.statusCode < 300) {
          try { resolve(raw ? JSON.parse(raw) : []); } catch (e) { resolve(raw); }
        } else reject(new Error('PG ' + resp.statusCode + ': ' + raw.slice(0, 200)));
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
      }, timeout: 20000
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

/* ---------- 同步（按 uid 隔离） ---------- */
const enc = s => encodeURIComponent(s);

async function syncPush(body, uid) {
  const { device_id, changes } = body;
  if (!device_id || !Array.isArray(changes)) throw new Error('push 参数不完整');
  const results = [];
  for (const ch of changes) {
    const { bucket, rec_key, payload, updated_at, deleted } = ch;
    if (!bucket || !rec_key || typeof updated_at !== 'number') continue;
    const q = 'owner_uid=eq.' + enc(uid) + '&bucket=eq.' + enc(bucket) +
              '&rec_key=eq.' + enc(rec_key) + '&select=id,updated_at&limit=1';
    const old = await pgRequest('GET', 'health_sync', q);
    const prev = Array.isArray(old) ? old[0] : null;
    if (prev && Number(prev.updated_at) > updated_at) {
      results.push({ bucket, rec_key, applied: false, reason: 'older' });
      continue;
    }
    // sync_code 列仍为 NOT NULL（旧 schema 遗留），写空串占位；隔离完全用 owner_uid
    const doc = {
      owner_uid: uid, sync_code: '', device_id, bucket, rec_key,
      payload: payload || {}, updated_at, deleted: !!deleted
    };
    if (prev && prev.id) await pgRequest('PATCH', 'health_sync', 'id=eq.' + enc(prev.id), doc);
    else await pgRequest('POST', 'health_sync', '', doc, { 'Prefer': 'return=minimal' });
    results.push({ bucket, rec_key, applied: true });
  }
  return results;
}

async function syncPull(body, uid) {
  const { since } = body;
  let q = 'owner_uid=eq.' + enc(uid) +
          '&select=bucket,rec_key,payload,updated_at,deleted&limit=1000';
  if (since) q += '&updated_at=gt.' + enc(String(since));
  const rows = await pgRequest('GET', 'health_sync', q);
  return (Array.isArray(rows) ? rows : []).map(r => ({
    bucket: r.bucket, rec_key: r.rec_key, payload: r.payload,
    updated_at: r.updated_at, deleted: !!r.deleted
  }));
}

/* ---------- HTTP server（监听 9000） ---------- */
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }
  const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
  try {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' }, req);
    if (pathname === '/' || pathname.endsWith('/health') || pathname.endsWith('/api'))
      return sendJson(res, 200, { ok: true, service: 'bio-api', auth: 'required' }, req);

    // /auth 无需登录：发码/验码/注册/登录本身是获取凭证的过程
    if (pathname.endsWith('/auth')) {
      const ab = await readJsonBody(req);
      return sendJson(res, 200, { ok: true, data: await handleAuth(ab) }, req);
    }

    // 统一鉴权：/ai 与 /sync 都必须带有效 token
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return sendJson(res, 401, { ok: false, error: '未登录' }, req);
    let uid;
    try { uid = await whoAmI(token); }
    catch (e) { return sendJson(res, 401, { ok: false, error: '登录已过期，请重新登录' }, req); }

    const body = await readJsonBody(req);
    if (pathname.endsWith('/ai')) {
      if (!body.system || !body.payload) throw new Error('ai 参数不完整');
      return sendJson(res, 200, { ok: true, text: await callDeepSeek(body.system, body.payload) }, req);
    }
    if (pathname.endsWith('/sync')) {
      if (body.op === 'push') return sendJson(res, 200, { ok: true, data: await syncPush(body, uid) }, req);
      if (body.op === 'pull') return sendJson(res, 200, { ok: true, data: await syncPull(body, uid) }, req);
      throw new Error('未知 sync op（配对码 create 已废弃）');
    }
    return sendJson(res, 404, { ok: false, error: 'not found' }, req);
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: e.message || String(e) }, req);
  }
});

server.listen(9000, '0.0.0.0');
