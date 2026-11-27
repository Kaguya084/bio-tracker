/* =================================================================
   账号与会话 —— 走自有云函数 /auth 代理（绕开 CloudBase 网关安全域名限制）
   不依赖 @cloudbase/js-sdk：体验版套餐无法把 GitHub Pages 加入安全域名，
   SDK 直连网关会 403；改为前端调自有 bio-api 云函数，由服务端转发 Auth HTTP API。
   token 自行管理：access_token 2h / refresh_token 30d，过期前自动刷新。
   ================================================================= */
const LS_AUTH_EMAIL = 'bio_auth_email';
const LS_AUTH_UID = 'bio_auth_uid';
const LS_ACCESS = 'bio_auth_access';
const LS_REFRESH = 'bio_auth_refresh';
const LS_EXPIRE = 'bio_auth_expire';   // access_token 到期时间（ms）

const AuthEndpoint = () => (window.SYNC_ENDPOINT || '');  // 与 /sync 同一个云函数网关

const Auth = (() => {
  function saveSession(d) {
    if (!d || !d.access_token) return false;
    const now = Date.now();
    localStorage.setItem(LS_ACCESS, d.access_token);
    if (d.refresh_token) localStorage.setItem(LS_REFRESH, d.refresh_token);
    const expire = Number(d.expires_in || 7200);
    localStorage.setItem(LS_EXPIRE, String(now + Math.max(60, expire - 120) * 1000)); // 提前 2 分钟过期
    if (d.sub) localStorage.setItem(LS_UID, d.sub);
    return true;
  }
  function clearSession() {
    [LS_AUTH_EMAIL, LS_AUTH_UID, LS_ACCESS, LS_REFRESH, LS_EXPIRE].forEach(k => localStorage.removeItem(k));
  }
  async function api(op, data) {
    const base = AuthEndpoint();
    if (!base) throw new Error('云端地址未配置');
    const resp = await fetch(base + '/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ op }, data || {}))
    });
    if (resp.status === 401) { clearSession(); throw new Error('登录已过期'); }
    const r = await resp.json();
    if (!r.ok) throw new Error(r.error || '账号服务失败');
    return r.data;
  }

  async function token() {
    const exp = Number(localStorage.getItem(LS_EXPIRE) || 0);
    const at = localStorage.getItem(LS_ACCESS) || '';
    if (!at) return '';
    if (Date.now() < exp) return at;                 // 未过期
    // 尝试用 refresh_token 换新
    const rt = localStorage.getItem(LS_REFRESH) || '';
    if (!rt) { clearSession(); return ''; }
    try {
      const d = await api('refresh', { refresh_token: rt });
      if (saveSession(d)) return d.access_token;
    } catch (e) { clearSession(); }
    return '';
  }
  async function uid() { return localStorage.getItem(LS_UID) || ''; }
  async function session() { return (await token()) ? { user: { id: await uid() } } : null; }

  function clearLocalOnSwitch() {
    try {
      localStorage.removeItem('health_assistant_v3');
      Object.keys(localStorage).forEach(k => {
        if (k.startsWith('bio_ts_') || k.startsWith('bio_sig_')) localStorage.removeItem(k);
      });
      if (typeof DB === 'object') {
        Object.keys(DB).forEach(k => {
          if (Array.isArray(DB[k])) DB[k] = [];
          else if (DB[k] && typeof DB[k] === 'object') DB[k] = {};
          else DB[k] = null;
        });
      }
    } catch (e) { console.warn('[auth] clear local failed', e); }
  }
  function bindToSync(email) {
    if (typeof Sync === 'undefined') return;
    Sync.setIdentityFromAuth({ uid: uid, token: token });
    if (email) localStorage.setItem(LS_AUTH_EMAIL, email);
  }
  async function afterAuth(d, email) {
    const prev = localStorage.getItem(LS_UID);
    saveSession(d);
    const u = d.sub || await uid();
    if (prev && prev !== u) clearLocalOnSwitch();
    localStorage.setItem(LS_UID, u);
    localStorage.setItem(LS_AUTH_EMAIL, email);
    bindToSync(email);
  }

  /* 注册三步：send → verify → signup；code 为空时只发码 */
  async function register(email, password, code) {
    try {
      if (!code) {
        const s = await api('send', { email });
        localStorage.setItem('bio_auth_vid', s.verification_id || ''); // 验码需要同一个 verification_id
        return { ok: true, sent: true };
      }
      const vid = localStorage.getItem('bio_auth_vid') || '';
      const v = await api('verify', { verification_id: vid, code });
      const d = await api('signup', { email, password, verification_token: v.verification_token, username: email.split('@')[0] });
      await afterAuth(d, email);
      return { ok: true };
    } catch (e) { return { ok: false, msg: e.message }; }
  }
  async function login(email, password) {
    try {
      const d = await api('signin', { username: email, password });
      await afterAuth(d, email);
      return { ok: true };
    } catch (e) { return { ok: false, msg: '登录失败：' + e.message }; }
  }
  async function signOut() {
    clearSession();
    if (typeof Sync !== 'undefined') Sync.clearIdentity();
  }
  async function restore() {
    if (!(await token())) return '';
    const u = await uid();
    bindToSync(localStorage.getItem(LS_AUTH_EMAIL) || '');
    return u;
  }

  return {
    email: () => localStorage.getItem(LS_AUTH_EMAIL) || '',
    uid: uid, token: token, session: session,
    isOn: async () => !!(await token()),
    identify: afterAuth, restore: restore,
    register: register, login: login, signOut: signOut,
    clearLocalOnSwitch: clearLocalOnSwitch
  };
})();
