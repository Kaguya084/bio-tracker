/* =================================================================
   极简事件总线：让数据变更可以通知渲染层，替代散落各处的 renderAll() 硬编码。
   阶段 1 只做基础设施，不改调用点；阶段 2 再让模块按桶订阅。
   ================================================================= */
const Bus = (() => {
  const map = new Map();
  return {
    on(evt, fn) {
      if (!map.has(evt)) map.set(evt, new Set());
      map.get(evt).add(fn);
      return () => map.get(evt).delete(fn);
    },
    emit(evt, payload) {
      const set = map.get(evt);
      if (!set) return;
      set.forEach(fn => {
        try { fn(payload); } catch (e) { console.error('[Bus] handler error on ' + evt, e); }
      });
    }
  };
})();
