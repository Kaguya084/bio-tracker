/* =================================================================
   AI 守卫层：防幻觉三条硬规则 + 统计归一化（无 DOM 依赖）
   从 index.html 抽出；依赖全局 fmt(util.js) 与 DB(store.js)。
   ================================================================= */
/* 硬规则②：异常值判定 */
function spIsAnomalous(field, value){
  if(value == null) return false;
  const rules = { min:[1,300] };
  const r = rules[field]; if(!r) return false;
  return value < r[0] || value > r[1];
}
/* 硬规则①：把网页2老数据 {t,min,int,kcal} 映射成网页3语义 {exercise_type,duration_min,intensity} */
function spNormalize(list){
  return (list||[]).map(x=>({
    t: x.t,
    min: (x.min == null || x.min === '') ? null : Number(x.min),
    int: x.int || 'm',
    kcal: x.kcal || 0,
    note: x.note || '',
    _anomaly: spIsAnomalous('min', x.min == null ? null : Number(x.min))
  }));
}
/* 硬规则③：有效天数 < 3 视为 insufficient */
const MIN_DAYS_FOR_EXPLANATION = 3;
const WEEKLY_GOAL_MIN = 150;

function spDateRange(start, end){
  const out=[]; let d=new Date(start+'T00:00:00'); const e=new Date(end+'T00:00:00');
  while(d<=e){ out.push(fmt(d)); d.setDate(d.getDate()+1); }
  return out;
}
/* fallback: 与 py/main.py 同规格。第三参数仅供一致性验证传入 fixture，
   现有调用只传 (start,end)，行为完全不变。 */
function spSummarizeExercise(start, end, exByDate){
  const exSource = exByDate || DB.ex;
  // 收集区间内所有有效/异常/缺失
  const allDays = spDateRange(start, end);
  const inSpan=[];      // {date, items}
  allDays.forEach(d=>{
    const arr = exSource[d];
    if(!arr || !arr.length) return;
    inSpan.push({date:d, items:spNormalize(arr)});
  });
  let totalMin=0, validSessions=0, validDaysSet=new Set();
  let missingCount=0, anomalyCount=0;
  const perDay={};           // date → 分钟
  const byType={};
  const excluded=[];         // 异常/缺失明细
  inSpan.forEach(({date, items})=>{
    items.forEach(x=>{
      if(x._anomaly){
        anomalyCount++;
        excluded.push({date, kind:'anomaly', type:x.t, min:x.min});
        return;
      }
      if(x.min == null){
        missingCount++;
        excluded.push({date, kind:'missing', type:x.t, min:null});
        return;
      }
      validSessions++;
      validDaysSet.add(date);
      totalMin += x.min;
      perDay[date] = (perDay[date]||0) + x.min;
      const k = x.t || '未填写';
      byType[k] = byType[k] || {count:0, minutes:0};
      byType[k].count++;
      byType[k].minutes += x.min;
    });
  });
  const validDays = validDaysSet.size;
  const total = allDays.length;
  const coverage = {
    total_days: total,
    days_with_valid_record: validDays,
    coverage_ratio: total ? +(validDays/total).toFixed(3) : 0,
    missing_days: total - validDays
  };
  const durs = [];
  Object.keys(perDay).forEach(d=>durs.push(perDay[d]));
  const mean = durs.length ? +(durs.reduce((a,b)=>a+b,0)/durs.length).toFixed(1) : null;
  const sorted = durs.slice().sort((a,b)=>a-b);
  const median = !sorted.length ? null : (sorted.length%2 ? sorted[Math.floor(sorted.length/2)]
    : +((sorted[sorted.length/2-1]+sorted[sorted.length/2])/2).toFixed(1));
  const avgPerSession = validSessions ? +(totalMin/validSessions).toFixed(1) : null;
  const avgPerValidDay = validDays ? +(totalMin/validDays).toFixed(1) : null;

  // 前后半段
  const half = Math.floor(allDays.length/2);
  const firstSpan = allDays.slice(0, half), secondSpan = allDays.slice(half);
  const fDays = firstSpan.filter(d=>perDay[d]!=null);
  const sDays = secondSpan.filter(d=>perDay[d]!=null);
  const fAvg = fDays.length ? +(fDays.reduce((a,d)=>a+perDay[d],0)/fDays.length).toFixed(1) : null;
  const sAvg = sDays.length ? +(sDays.reduce((a,d)=>a+perDay[d],0)/sDays.length).toFixed(1) : null;
  let direction='数据不足';
  if(fAvg!=null && sAvg!=null){
    const diff=sAvg-fAvg;
    if(diff>2) direction='上升'; else if(diff<-2) direction='下降'; else direction='基本持平';
  }
  const delta = (fAvg!=null && sAvg!=null) ? +(sAvg-fAvg).toFixed(1) : null;

  // 按自然周
  const weeks=[];
  for(let i=0;i<allDays.length;i+=7){
    const chunk=allDays.slice(i,i+7);
    const mins=chunk.reduce((a,d)=>a+(perDay[d]||0),0);
    const hasData=chunk.some(d=>perDay[d]!=null);
    weeks.push({
      range:[chunk[0], chunk[chunk.length-1]],
      minutes: +mins.toFixed(1),
      target: WEEKLY_GOAL_MIN,
      met: hasData && mins>=WEEKLY_GOAL_MIN,
      has_data: hasData,
      has_full_week: chunk.length===7
    });
  }

  return {
    period:{start, end, days: total},
    coverage,
    counts:{
      records_valid: validSessions,
      records_missing_value: missingCount,
      records_excluded: anomalyCount
    },
    totals:{ sessions: validSessions, minutes: +totalMin.toFixed(1) },
    averages:{
      minutes_per_session: avgPerSession,
      minutes_per_valid_day: avgPerValidDay,
      mean_per_day: mean,
      median_per_day: median
    },
    per_day: perDay,
    weeks,
    trend:{ first_half_avg:fAvg, second_half_avg:sAvg, delta, direction },
    by_type: byType,
    excluded_records: excluded,
    missing_value_records: excluded.filter(x=>x.kind==='missing'),
    insufficient: validDays < MIN_DAYS_FOR_EXPLANATION
  };
}

/* AI 输入：与网页 3 的 to_payload 一致 */
function spToPayload(s){
  return {
    kind: 'exercise',
    kind_label: '运动',
    unit: '分钟',
    period: s.period,
    coverage: s.coverage,
    counts: s.counts,
    averages: s.averages,
    totals: s.totals,
    trend: s.trend,
    by_type: s.by_type,
    weeks: s.weeks.map(w=>({
      range: w.range,
      minutes: w.has_data ? w.minutes : null,
      target: w.target,
      met: w.has_data ? w.met : null,
      has_data: w.has_data
    })),
    insufficient: s.insufficient,
    excluded_records: s.excluded_records,
    missing_value_records: s.missing_value_records
  };
}

/* 与网页 3 的 human_notes 一致 */
function spHumanNotes(s){
  const c=s.coverage, notes=[];
  notes.push(`日期区间：${s.period.start} 至 ${s.period.end}，共 ${s.period.days} 天`);
  notes.push(`有效记录覆盖：${c.days_with_valid_record}/${c.total_days} 天（${Math.round(c.coverage_ratio*100)}%），${c.missing_days} 天无任何记录`);
  if(s.counts.records_missing_value){
    notes.push(`${s.counts.records_missing_value} 条记录没有填写分钟数：不进均值，也不当作 0`);
  }
  if(s.counts.records_excluded){
    notes.push(`${s.counts.records_excluded} 条记录被判定为异常值，已排除在统计之外`);
  }
  if(s.insufficient){
    notes.push(`有效天数不足 ${MIN_DAYS_FOR_EXPLANATION} 天：只描述已观察到的现象，不作趋势与因果判断`);
  }
  return notes;
}

