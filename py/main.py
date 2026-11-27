# =================================================================
# 校园健康助手 · 浏览器内 Python 计算内核
# 课程：计算思维与Python语言 —— 作业演示
#
# 设计原则（答辩可讲）：
#   1. 抽象：所有函数只处理 dict / list / 基本类型，不碰 DOM、不碰 localStorage
#   2. 分治：时间区间 -> 按天聚合 -> 自然周 -> 前后半段趋势
#   3. 鲁棒：缺失 != 0、异常值排除、样本不足不下结论（三条防幻觉硬规则）
#   4. 可评估：self_test() 对固定样例断言，结果可量化展示
#
# 与 JS 的桥：唯一入口 py_compute(req_text: str) -> str（JSON in / JSON out）
# =================================================================
import json
import math
from datetime import date, timedelta

# ---------- 常量（防幻觉规则的参数） ----------
MIN_DAYS = 3                 # 有效天数不足 3 天 -> insufficient
WEEKLY_GOAL_MIN = 150        # 每周运动目标（分钟）
ANOMALY_RANGE = (1, 300)     # 单次运动时长的合理区间（分钟）


# ---------- 工具：统一舍入，消除 JS Math.round 与 Python round 的差异 ----------
def rhalf(x, nd=0):
    """四舍五入（.5 向上），与 JavaScript Math.round 对齐。
    Python 内置 round() 是银行家舍入，直接对照会导致 JS/Python 结果不一致。"""
    p = 10 ** nd
    return math.floor(x * p + 0.5) / p


def to_float(x, default=None):
    """安全转 float：None / 空串 / 非法值 -> default。缺失值不伪造为 0。"""
    if x is None or x == '':
        return default
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


# =================================================================
# 分区一：防幻觉三条硬规则
# =================================================================
def is_anomalous(field, value):
    """规则②：异常值判定。超范围的分钟数不参与统计。"""
    if value is None or field != 'min':
        return False
    return value < ANOMALY_RANGE[0] or value > ANOMALY_RANGE[1]


def normalize_ex_item(x):
    """规则①：归一化。缺失的 min 保留 None，绝不填 0。"""
    x = x or {}
    m = to_float(x.get('min'))
    return {
        't': x.get('t'),
        'min': m,
        'int': x.get('int') or 'm',
        'kcal': x.get('kcal') or 0,
        'note': x.get('note') or '',
        '_anomaly': is_anomalous('min', m),
    }


def date_range(start, end):
    """生成闭区间日期列表 [start, end]，作为统计的时间轴。"""
    y, m, d = [int(v) for v in start.split('-')]
    cur = date(y, m, d)
    ey, em, ed = [int(v) for v in end.split('-')]
    last = date(ey, em, ed)
    out = []
    while cur <= last:
        out.append(cur.isoformat())
        cur += timedelta(days=1)
    return out


# =================================================================
# 分区二：运动统计（镜像 js/ai/guard.js 的 sp* 系列）
# =================================================================
def sp_summarize_exercise(ex, start, end):
    """输入：ex = {'2026-11-27': [{t,min,int,kcal,note}, ...]}
    输出：与 JS spSummarizeExercise 同结构的 dict（字段逐一对齐）。"""
    ex_by_date = ex or {}
    all_days = date_range(start, end)
    per_day = {}
    by_type = {}
    excluded = []
    valid_sessions = 0
    missing_count = 0
    anomaly_count = 0
    total_min = 0.0
    valid_days_set = set()

    for d in all_days:
        arr = ex_by_date.get(d) or []
        if not arr:
            continue
        for raw in arr:
            x = normalize_ex_item(raw)
            if x['_anomaly']:
                anomaly_count += 1
                excluded.append({'date': d, 'kind': 'anomaly', 'type': x['t'], 'min': x['min']})
                continue
            if x['min'] is None:
                missing_count += 1
                excluded.append({'date': d, 'kind': 'missing', 'type': x['t'], 'min': None})
                continue
            valid_sessions += 1
            valid_days_set.add(d)
            total_min += x['min']
            per_day[d] = per_day.get(d, 0) + x['min']
            k = x['t'] or '未填写'
            slot = by_type.setdefault(k, {'count': 0, 'minutes': 0})
            slot['count'] += 1
            slot['minutes'] += x['min']

    valid_days = len(valid_days_set)
    total = len(all_days)
    durs = list(per_day.values())
    mean = rhalf(sum(durs) / len(durs), 1) if durs else None
    srt = sorted(durs)
    if not srt:
        median = None
    elif len(srt) % 2:
        median = srt[len(srt) // 2]
    else:
        median = rhalf((srt[len(srt) // 2 - 1] + srt[len(srt) // 2]) / 2, 1)

    # 前后半段对比
    half = len(all_days) // 2
    f_days = [d for d in all_days[:half] if d in per_day]
    s_days = [d for d in all_days[half:] if d in per_day]
    f_avg = rhalf(sum(per_day[d] for d in f_days) / len(f_days), 1) if f_days else None
    s_avg = rhalf(sum(per_day[d] for d in s_days) / len(s_days), 1) if s_days else None
    if f_avg is not None and s_avg is not None:
        diff = s_avg - f_avg
        direction = '上升' if diff > 2 else ('下降' if diff < -2 else '基本持平')
        delta = rhalf(diff, 1)
    else:
        direction, delta = '数据不足', None

    # 自然周
    weeks = []
    for i in range(0, len(all_days), 7):
        chunk = all_days[i:i + 7]
        mins = sum(per_day.get(d, 0) for d in chunk)
        has = any(d in per_day for d in chunk)
        weeks.append({
            'range': [chunk[0], chunk[-1]],
            'minutes': rhalf(mins, 1),
            'target': WEEKLY_GOAL_MIN,
            'met': bool(has and mins >= WEEKLY_GOAL_MIN),
            'has_data': has,
            'has_full_week': len(chunk) == 7,
        })

    missing_records = [r for r in excluded if r['kind'] == 'missing']
    return {
        'period': {'start': start, 'end': end, 'days': total},
        'coverage': {
            'total_days': total,
            'days_with_valid_record': valid_days,
            'coverage_ratio': rhalf(valid_days / total, 3) if total else 0,
            'missing_days': total - valid_days,
        },
        'counts': {
            'records_valid': valid_sessions,
            'records_missing_value': missing_count,
            'records_excluded': anomaly_count,
        },
        'totals': {'sessions': valid_sessions, 'minutes': rhalf(total_min, 1)},
        'averages': {
            'minutes_per_session': rhalf(total_min / valid_sessions, 1) if valid_sessions else None,
            'minutes_per_valid_day': rhalf(total_min / valid_days, 1) if valid_days else None,
            'mean_per_day': mean,
            'median_per_day': median,
        },
        'per_day': per_day,
        'weeks': weeks,
        'trend': {'first_half_avg': f_avg, 'second_half_avg': s_avg,
                  'delta': delta, 'direction': direction},
        'by_type': by_type,
        'excluded_records': excluded,
        'missing_value_records': missing_records,
        'insufficient': valid_days < MIN_DAYS,   # 规则③
        '_notes': human_notes({
            'period': {'start': start, 'end': end, 'days': total},
            'coverage': {'total_days': total, 'days_with_valid_record': valid_days,
                         'coverage_ratio': rhalf(valid_days / total, 3) if total else 0,
                         'missing_days': total - valid_days},
            'counts': {'records_missing_value': missing_count, 'records_excluded': anomaly_count},
            'insufficient': valid_days < MIN_DAYS,
        }),
    }


def human_notes(s):
    """与 JS spHumanNotes 一致：把数据边界写成人类可读的提示。"""
    c = s['coverage']
    notes = [
        f"日期区间：{s['period']['start']} 至 {s['period']['end']}，共 {s['period']['days']} 天",
        f"有效记录覆盖：{c['days_with_valid_record']}/{c['total_days']} 天"
        f"（{round(c['coverage_ratio'] * 100)}%），{c['missing_days']} 天无任何记录",
    ]
    if s['counts'].get('records_missing_value'):
        notes.append(f"{s['counts']['records_missing_value']} 条记录没有填写分钟数：不进均值，也不当作 0")
    if s['counts'].get('records_excluded'):
        notes.append(f"{s['counts']['records_excluded']} 条记录被判定为异常值，已排除在统计之外")
    if s.get('insufficient'):
        notes.append(f"有效天数不足 {MIN_DAYS} 天：只描述已观察到的现象，不作趋势与因果判断")
    return notes


def sp_to_payload(s):
    """AI 输入契约：去掉 has_full_week 等内部字段，缺失数据用 null 而非 0。"""
    return {
        'kind': 'exercise', 'kind_label': '运动', 'unit': '分钟',
        'period': s['period'], 'coverage': s['coverage'], 'counts': s['counts'],
        'averages': s['averages'], 'totals': s['totals'], 'trend': s['trend'],
        'by_type': s['by_type'],
        'weeks': [{'range': w['range'],
                   'minutes': w['minutes'] if w['has_data'] else None,
                   'target': w['target'],
                   'met': w['met'] if w['has_data'] else None,
                   'has_data': w['has_data']} for w in s['weeks']],
        'insufficient': s['insufficient'],
        'excluded_records': s['excluded_records'],
        'missing_value_records': s['missing_value_records'],
    }


# =================================================================
# 分区三：基础统计（对应 index.html 的纯计算函数）
# =================================================================
def clamp(v, a, b):
    return max(a, min(b, v))


def kcal_goal(settings):
    """Mifflin-St Jeor 公式：BMR -> TDEE -> 目标热量（下限 1200）。"""
    s = settings or {}
    w = to_float(s.get('weight'), 60) or 60
    h = to_float(s.get('height'), 170) or 170
    age = to_float(s.get('age'), 30) or 30
    sex = s.get('sex', 'f')
    act = to_float(s.get('act'), 1.55) or 1.55
    adj = to_float(s.get('adj'), 0) or 0
    bmr = 10 * w + 6.25 * h - 5 * age + (5 if sex == 'm' else -161)
    tdee = bmr * act
    return {'bmr': math.floor(bmr + 0.5), 'tdee': math.floor(tdee + 0.5),
            'goal': max(1200, math.floor((tdee + adj) / 10 + 0.5) * 10)}


def diet_sum(items):
    """饮食四项累加。"""
    out = {'k': 0, 'p': 0, 'c': 0, 'f': 0}
    for it in items or []:
        for key in out:
            out[key] += to_float(it.get(key), 0) or 0
    return out


def sleep_score(r):
    """睡眠评分：时长/效率/入睡/夜醒/主观 五因子加权。"""
    r = r or {}
    if not r:
        return None
    bh, bm = [int(v) for v in str(r.get('bed', '23:00')).split(':')]
    wh, wm = [int(v) for v in str(r.get('wake', '07:00')).split(':')]
    inbed = (wh * 60 + wm) - (bh * 60 + bm)
    if inbed <= 0:
        inbed += 1440
    lat = to_float(r.get('lat'), 0) or 0
    awake = to_float(r.get('awake'), 0) or 0
    real = max(0, inbed - (lat + awake * 15))
    eff = clamp(round(real / inbed * 100), 0, 100) if inbed else 0
    # 与 JS 对齐：Math.round(x/6)/10 —— 分钟换算成小时后保留 1 位小数
    h = math.floor(real / 6 + 0.5) / 10
    hib = math.floor(inbed / 6 + 0.5) / 10
    s_dur = clamp(100 - abs(h - 8) * 25, 0, 100)
    s_eff = clamp((eff - 70) / 30 * 100, 0, 100)
    s_lat = clamp(100 - (lat - 10) * 2.5, 0, 100)
    s_aw = [100, 75, 55, 35, 15, 8][min(int(awake), 5)] or 5
    s_sub = ((to_float(r.get('q'), 3) or 3) - 1) / 4 * 100
    score = math.floor(s_dur * 0.30 + s_eff * 0.20 + s_lat * 0.15 + s_aw * 0.15 + s_sub * 0.20 + 0.5)
    return {'inbed': inbed, 'real': real, 'eff': eff, 'h': h, 'hib': hib, 'score': score}


def ex_stat(items):
    """单日运动汇总：分钟 + 消耗。"""
    total_m, total_k = 0, 0
    for it in items or []:
        total_m += to_float(it.get('min'), 0) or 0
        total_k += to_float(it.get('kcal'), 0) or 0
    return {'min': total_m, 'kcal': total_k}


def insight_metrics(db, today, week_days=None):
    """总览页洞察的全部纯计算：一次跨桥返回，DOM 拼接仍由 JS 负责。"""
    db = db or {}
    settings = db.get('settings') or {}
    sleep = db.get('sleep') or {}
    water = db.get('water') or {}
    diet = db.get('diet') or {}
    ex = db.get('ex') or {}

    # --- 睡眠：近 7 天均值 + 晚睡/疲惫天数 ---
    skeys = sorted(sleep.keys())[-7:]
    scores = [x for x in (sleep_score(sleep[k]) for k in skeys) if x]
    avg_h = rhalf(sum(x['h'] for x in scores) / len(scores), 1) if scores else None
    avg_s = math.floor(sum(x['score'] for x in scores) / len(scores) + 0.5) if scores else None
    late = sum(1 for k in skeys
               if str(sleep[k].get('bed', '')) >= '23:45' or str(sleep[k].get('bed', '')) < '05:00')
    tired = sum(1 for k in skeys if (to_float(sleep[k].get('q'), 3) or 3) <= 2)

    # --- 饮水：今日 + 近 7 天日均 ---
    wt_day = sum(to_float(x.get('ml'), 0) or 0
                 for x in ((water.get(today) or {}).get('logs') or []))
    wdays = sorted(water.keys())[-7:]
    wavg = (math.floor(sum(
        sum(to_float(x.get('ml'), 0) or 0 for x in ((water[k] or {}).get('logs') or []))
        for k in wdays) / len(wdays) + 0.5)) if wdays else 0

    # --- 运动：近 7 天总量（week_days 由 JS 传入，避免 Python 再算日期） ---
    wm = wk = 0
    for d in (week_days or []):
        st = ex_stat(ex.get(d) or [])
        wm += st['min']
        wk += st['kcal']

    g = kcal_goal(settings)
    ds = diet_sum(diet.get(today) or [])
    return {
        'sleep': {'avg_h': avg_h, 'avg_score': avg_s, 'days': len(skeys),
                  'late': late, 'tired': tired},
        'kcal': {'goal': g['goal'], 'today': ds['k'], 'protein': ds['p'],
                 'items': len(diet.get(today) or [])},
        'water': {'today': wt_day, 'goal': to_float(settings.get('goal'), 2000) or 2000,
                  'avg7': wavg},
        'ex': {'minutes7': wm, 'kcal7': wk,
               'goal_min': to_float(settings.get('goalMin'), 30) or 30},
    }


# =================================================================
# 分区四：数据校验与迁移（对应 exportData / importData）
# =================================================================
KNOWN_BUCKETS = ['water', 'sleep', 'diet', 'ex', 'foods', 'settings',
                 'sportProfile', 'sportPlans', 'sportFeedbacks', 'steps', 'journal']


def validate_backup(obj):
    """导入前校验：类型不对、未知桶、必填字段缺失都拒绝。返回错误清单。"""
    errors = []
    if not isinstance(obj, dict):
        return {'ok': False, 'errors': ['备份文件顶层必须是对象']}
    for k, v in obj.items():
        if k not in KNOWN_BUCKETS:
            continue  # 未知字段忽略，不拒绝（前向兼容）
        if k in ('water', 'sleep', 'diet', 'ex', 'steps', 'journal') and not isinstance(v, dict):
            errors.append(f"桶 {k} 应为对象，实际为 {type(v).__name__}")
        if k in ('foods', 'sportPlans', 'sportFeedbacks') and not isinstance(v, list):
            errors.append(f"桶 {k} 应为数组，实际为 {type(v).__name__}")
        if k == 'settings' and not isinstance(v, dict):
            errors.append('桶 settings 应为对象')
    return {'ok': not errors, 'errors': errors}


def migrate_backup(obj):
    """旧版迁移：睡眠数组 -> 对象；移除密钥字段；补齐缺失桶。"""
    out = dict(obj or {})
    sleep = out.get('sleep') or {}
    for d, r in list(sleep.items()):
        if isinstance(r, list) and len(r) >= 2:
            sleep[d] = {'bed': r[0], 'wake': r[1], 'lat': 15, 'awake': 0,
                        'q': min(5, (to_float(r[3], 1) or 1) + 2),
                        'note': r[4] if len(r) > 4 else ''}
    out['sleep'] = sleep
    settings = dict(out.get('settings') or {})
    settings.pop('apiKey', None)   # 密钥永不进备份
    out['settings'] = settings
    return out


def export_sanitize(db):
    """导出脱敏：删除密钥字段（JS 侧保留权威实现，此处用于对照验证）。"""
    return migrate_backup(db or {})


# =================================================================
# 桥接入口：JSON 字符串进 / JSON 字符串出
# =================================================================
_OPS = {
    'sp_summarize_exercise': sp_summarize_exercise,
    'sp_to_payload': sp_to_payload,
    'human_notes': human_notes,
    'kcal_goal': kcal_goal,
    'diet_sum': diet_sum,
    'sleep_score': sleep_score,
    'ex_stat': ex_stat,
    'insight_metrics': insight_metrics,
    'validate_backup': validate_backup,
    'migrate_backup': migrate_backup,
    'export_sanitize': export_sanitize,
    'self_test': None,  # 下方特殊处理
}


def py_compute(req_text):
    """浏览器内 Python 的唯一出口。req = {'op': 名称, 'data': {...}}"""
    try:
        req = json.loads(req_text)
        op = req.get('op')
        data = req.get('data') or {}
        if op == 'self_test':
            result = self_test()
        else:
            fn = _OPS.get(op)
            if fn is None:
                raise ValueError('未知 op: ' + str(op))
            result = fn(**data)
        return json.dumps({'ok': True, 'op': op, 'data': result}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({'ok': False, 'error': type(e).__name__ + ': ' + str(e)}, ensure_ascii=False)


def self_test():
    """启动时自检：6 组固定样例，覆盖三条硬规则的边界。"""
    cases = []

    # 1) 正常 7 天
    ex1 = {'2026-11-21': [{'t': '快走', 'min': 30}]} if False else {
        '2026-11-%02d' % d: [{'t': '快走', 'min': 30}] for d in range(21, 28)}
    s = sp_summarize_exercise(ex1, '2026-11-21', '2026-11-27')
    cases.append(('正常7天', s['totals']['minutes'] == 210 and s['insufficient'] is False))

    # 2) 缺失值不按 0 计：该日被排除，总分钟从 210 降为 180（而非填 0 后仍算 210）
    ex2 = dict(ex1)
    ex2['2026-11-23'] = [{'t': '跑步', 'min': None}]
    s2 = sp_summarize_exercise(ex2, '2026-11-21', '2026-11-27')
    cases.append(('缺失值', s2['counts']['records_missing_value'] == 1 and s2['totals']['minutes'] == 180))

    # 3) 异常值排除：400 分钟超限被排除，总分钟同样降为 180
    ex3 = dict(ex1)
    ex3['2026-11-24'] = [{'t': '跑步', 'min': 400}]
    s3 = sp_summarize_exercise(ex3, '2026-11-21', '2026-11-27')
    cases.append(('异常值', s3['counts']['records_excluded'] == 1 and s3['totals']['minutes'] == 180))

    # 4) 有效 2 天 -> insufficient
    ex4 = {'2026-11-21': [{'t': '快走', 'min': 20}], '2026-11-22': [{'t': '跑步', 'min': 30}]}
    s4 = sp_summarize_exercise(ex4, '2026-11-21', '2026-11-27')
    cases.append(('有效2天', s4['insufficient'] is True))

    # 5) 有效 3 天 -> 边界，不算不足
    ex5 = dict(ex4)
    ex5['2026-11-23'] = [{'t': '瑜伽', 'min': 25}]
    s5 = sp_summarize_exercise(ex5, '2026-11-21', '2026-11-27')
    cases.append(('有效3天边界', s5['insufficient'] is False))

    # 6) 空数据
    s6 = sp_summarize_exercise({}, '2026-11-21', '2026-11-27')
    cases.append(('空数据', s6['totals']['minutes'] == 0 and s6['insufficient'] is True))

    passed = sum(1 for _, ok in cases if ok)
    return {'passed': passed, 'total': len(cases),
            'cases': [{'name': n, 'ok': ok} for n, ok in cases]}
