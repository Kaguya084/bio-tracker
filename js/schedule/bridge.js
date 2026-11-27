/* =================================================================
   日程桥接层：把 AI 行动建议转为外部日程站可导入的 JSON 数组
   从 index.html 抽出；依赖全局 fmt(util.js)。不做 postMessage（外部站无接收方）。
   ================================================================= */
/* ---------- 将网页3的 actions 转换为网页1可导入的 JSON 数组 ---------- */
function actionsToScheduleJson(actions){
  const items = [];
  const map = { '一':1, '二':2, '三':3, '四':4, '五':5, '六':6, '日':0, '天':0 };
  const now = new Date();
  
  (actions||[]).forEach(a => {
    // 1. 提取时间，如 "12:30"
    const timeMatch = a.when.match(/(\d{1,2}:\d{2})/);
    const time = timeMatch ? (timeMatch[1].length < 5 ? '0'+timeMatch[1] : timeMatch[1]) : "12:30"; 
    
    // 2. 提取星期，如 "周一、三、五 12:30" -> "一、三、五" -> ['一','三','五']
    let dayStr = a.when.split(' ')[0]; 
    dayStr = dayStr.replace(/周/g, '');
    const days = dayStr.split(/[、，,]/).filter(Boolean);
    
    // 如果没写星期，兜底生成一条
    if(days.length === 0) {
      items.push({
        title: a.action_type,
        date: fmt(now), 
        time: time,
        end: a.duration_min,
        loc: a.where,
        type: 'activity',
        priority: 'medium',
        note: a.trigger
      });
      return;
    }
    
    // 3. 推算具体日期
    days.forEach(dayChar => {
      const targetDay = map[dayChar];
      if(targetDay === undefined) return;
      
      let diff = targetDay - now.getDay();
      if (diff < 0) {
        diff += 7;
      } else if (diff === 0) {
        // 同一天，检查时间是否已过
        const hm = time.split(':');
        const targetTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parseInt(hm[0]), parseInt(hm[1]));
        if (now > targetTime) diff += 7; 
      }
      
      const d = new Date(now);
      d.setDate(d.getDate() + diff);
      
      items.push({
        title: a.action_type, // 标题：如"跑步"
        date: fmt(d),         // 具体日期
        time: time,           // 时间
        end: a.duration_min,  // 时长
        loc: a.where,         // 地点
        type: 'activity',     // 类型（活动）
        priority: 'medium',   // 优先级
        note: a.trigger       // 备注（触发点）
      });
    });
  });
  
  return JSON.stringify(items, null, 2);
}

