/* =================================================================
   数据层：DB 定义 / 旧版迁移 / 持久化 / 变更发布
   从 index.html 原 L1211-1236 抽出。DB 对象引用保持全局可用，
   使 100+ 处既有 DB.xxx 调用点零改动；save() 增加变更事件发布。
   依赖：util.js（无）、bus.js（Bus）。
   ================================================================= */
const K = 'health_assistant_v3';
const DB = {
  water: {}, sleep: {}, diet: {}, ex: {}, foods: [],
  settings: {
    weight: 60, goal: 2000, cup1: 200, cup2: 300, theme: 'rose',
    remind: true, interval: 60, start: '08:00', end: '22:00',
    height: 170, age: 30, sex: 'f', act: 1.55, adj: 0, goalMin: 30, goalKcal: 200
  },
  sportProfile: null, sportPlans: [], sportFeedbacks: []
};

try {
  const old = JSON.parse(localStorage.getItem('health_assistant_v2') || 'null');
  if (old && !localStorage.getItem(K)) localStorage.setItem(K, JSON.stringify(old));
} catch (e) {}

try { Object.assign(DB, JSON.parse(localStorage.getItem(K) || '{}')); } catch (e) {}

DB.water = DB.water || {}; DB.sleep = DB.sleep || {}; DB.diet = DB.diet || {};
DB.ex = DB.ex || {}; DB.foods = DB.foods || [];
DB.sportPlans = DB.sportPlans || []; DB.sportFeedbacks = DB.sportFeedbacks || [];
DB.steps = DB.steps || {}; DB.journal = DB.journal || {};

/* 旧版睡眠数组 → 新版对象 */
Object.keys(DB.sleep).forEach(d => {
  const r = DB.sleep[d];
  if (Array.isArray(r)) DB.sleep[d] = { bed: r[0], wake: r[1], lat: 15, awake: 0, q: Math.min(5, (+r[3] || 1) + 2), note: r[4] || '' };
});

/* 唯一持久化出口：写盘后发布变更事件，供渲染层订阅。
   阶段 1 仅发布、不强制订阅；既有显式 renderAll() 调用全部保留。 */
function save() {
  localStorage.setItem(K, JSON.stringify(DB));
  Bus.emit('data:changed', { db: DB });
}

save();
