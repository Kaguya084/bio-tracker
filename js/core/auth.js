/* =================================================================
   CloudBase 官方 Auth 封装 —— 浏览器内账号与会话
   依赖：cloudbase.full.js（CDN，全局变量 cloudbase）
   会话唯一判据：auth.getSession() 的 data.session（不用 getLoginState/getUser）
   公开 accessKey（publishableKey）可放前端；不含任何服务端密钥。
   ================================================================= */
const AUTH_ENV = 'project-labyrinth-d4dsyd0c9116e7';
const AUTH_REGION = 'ap-shanghai';
const PUB_KEY = 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjcxZmNlYTYzLTE3NjItNDQ4NS05ZGJmLWNlN2QzNzNkYWRkMSJ9.eyJpc3MiOiJodHRwczovL3Byb2plY3QtbGFieXJpbnRoLWQ0ZHN5ZDBjOTExNmU3LmFwLXNoYW5naGFpLnRjYi1hcGkudGVuY2VudGNsb3VkYXBpLmNvbSIsInN1YiI6ImFub24iLCJhdWQiOiJwcm9qZWN0LWxhYnlyaW50aC1kNGRzeWQwYzkxMTZlNyIsImV4cCI6NDA5OTQ2MzIzNiwiaWF0IjoxNzk1NzgwMDM2LCJub25jZSI6Imk3UDNlekVaU0xHakN2di0tWWY5MmciLCJhdF9oYXNoIjoiaTdQM2V6RVpTTEdqQ3Z2LS1ZZjkyZyIsIm5hbWUiOiJBbm9ueW1vdXMiLCJzY29wZSI6ImFub255bW91cyIsInByb2plY3RfaWQiOiJwcm9qZWN0LWxhYnlyaW50aC1kNGRzeWQwYzkxMTZlNyIsIm1ldGEiOnsicGxhdGZvcm0iOiJQdWJsaXNoYWJsZUtleSJ9LCJyb2xlIjoiYW5vbiIsImlzX2Fub255bW91cyI6dHJ1ZSwiYXBwX21ldGFkYXRhIjp7InByb3ZpZGVyIjoiYW5vbnltb3VzIiwicHJvdmlkZXJzIjpbImFub255bW91cyJdfSwidXNlcl9tZXRhZGF0YSI6eyJuYW1lIjoiQW5vbnltb3VzIn0sInVzZXJfdHlwZSI6IiIsImNsaWVudF90eXBlIjoiY2xpZW50X3VzZXIiLCJpc19zeXN0ZW1fYWRtaW4iOmZhbHNlfQ.Cfh0ApTwDO6sefe2IEE1RWaKiZnf3ef_WBAycGViFG9ypzbIljo0DzosM6Sd1qOVCDOZkwqeGSZJww3a374CccALjowztGDGNNLv_TLJqsMqqLSRNKwKI_XyRRETkGvYUam3uraJFP3pZ5XrllEn-BeZSSKhWYy_kRH3FPaC6udDrOeSdcvZE2JBlYIzhiPZEJv6pQsE4cSeR9UAaDNLFq94OH0rrZ7bl4_lEOCeJxOE_-ynlUXe76wLQN2Spp4KY8_h2VgRBmSRtBLNpgE0NRjz7vzbrdhfEh3OciIgRU7nAwrCZBA46_NzD5uyiCol2nABXPf8NPPwvC_1Yv71MA';

const LS_EMAIL = 'bio_auth_email';
const LS_UID = 'bio_auth_uid';

let app, auth;
try {
  app = cloudbase.init({
    env: AUTH_ENV, region: AUTH_REGION,
    accessKey: PUB_KEY,
    auth: { detectSessionInUrl: true }
  });
  auth = (typeof app.auth === 'function') ? app.auth() : app.auth;
} catch (e) {
  console.error('[auth] SDK init failed:', e);
}

const Auth = (() => {
  async function session() {
    if (!auth || !auth.getSession) return null;
    try {
      const { data } = await auth.getSession();
      return (data && data.session) ? data.session : null;
    } catch (e) { return null; }
  }
  async function uid() {
    const s = await session();
    return s && s.user ? (s.user.id || s.user.sub || '') : '';
  }
  async function token() {
    const s = await session();
    return s ? (s.access_token || '') : '';
  }

  /* 账号切换防护：uid 变化时清空本地业务数据与时间戳，再全量拉取 */
  function clearLocalOnSwitch() {
    try {
      const K = 'health_assistant_v3';
      localStorage.removeItem(K);
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
    if (email) localStorage.setItem(LS_EMAIL, email);
  }
  async function identify(email) {
    const u = await uid();
    const prev = localStorage.getItem(LS_UID);
    if (prev && prev !== u) clearLocalOnSwitch();  // 换账号 → 清空，避免串数据
    localStorage.setItem(LS_UID, u);
    bindToSync(email);
  }
  async function signOut() {
    if (auth && auth.signOut) { try { await auth.signOut(); } catch (e) {} }
    localStorage.removeItem(LS_EMAIL);
    localStorage.removeItem(LS_UID);
    if (typeof Sync !== 'undefined') Sync.clearIdentity();
  }

  /* 注册：signUp 发码 → verifyOtp → 自动登录；错误从 error.message 出 */
  async function register(email, password, code) {
    if (!auth) return { ok: false, msg: 'Auth SDK 未加载' };
    const { data, error } = await auth.signUp({ email, password });
    if (error) return { ok: false, msg: '发送验证码失败：' + error.message };
    // 若调用方没带 code，说明只是第一步发码
    if (!code) return { ok: true, sent: true };
    const { error: ve } = await data.verifyOtp({ token: code });
    if (ve) return { ok: false, msg: '验证码错误或过期：' + ve.message };
    await identify(email);
    return { ok: true };
  }
  async function login(email, password) {
    if (!auth) return { ok: false, msg: 'Auth SDK 未加载' };
    const { error } = await auth.signInWithPassword({ email, password });
    if (error) return { ok: false, msg: '登录失败：' + error.message };
    await identify(email);
    return { ok: true };
  }

  /* 启动时恢复会话；返回 uid 或空串 */
  async function restore() {
    const s = await session();
    if (!s) return '';
    const u = await uid();
    const prev = localStorage.getItem(LS_UID);
    if (prev && prev !== u) clearLocalOnSwitch();
    localStorage.setItem(LS_UID, u);
    bindToSync(localStorage.getItem(LS_EMAIL) || '');
    return u;
  }

  /* 会话变更监听：登出/刷新同步状态 */
  if (auth && auth.onAuthStateChange) {
    try {
      auth.onAuthStateChange((event, sess) => {
        if (event === 'SIGNED_OUT') {
          localStorage.removeItem(LS_UID);
          if (typeof Sync !== 'undefined') Sync.clearIdentity();
        } else if (sess && event === 'TOKEN_REFRESHED') {
          if (typeof Sync !== 'undefined') Sync.setIdentityFromAuth({ uid: uid, token: token });
        }
      });
    } catch (e) {}
  }

  return {
    email: () => localStorage.getItem(LS_EMAIL) || '',
    uid: uid, token: token, session: session,
    isOn: async () => !!(await session()),
    identify: identify, restore: restore,
    register: register, login: login, signOut: signOut,
    clearLocalOnSwitch: clearLocalOnSwitch
  };
})();
