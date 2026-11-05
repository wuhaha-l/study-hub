/**
 * 专注（仿番茄 ToDo）
 *
 * 四块数据，全在本机：
 *   tomato_tasks_v1    待办：[{ id, title, tag, pomos, done, createdAt, doneAt }]
 *   tomato_sessions_v1 记录：[{ id, taskId, title, tag, mode, sec, minutes, at }]
 *   tomato_settings_v1 设置：{ focus, break, goal, autoNext }（分钟数随便改）
 *   tomato_run_v1      正在跑/暂停中的计时器（切页面、切后台都不丢）
 *
 * 标签（tag）：一条待办必带一个标签 —— 学习 / 休息 / 生活。
 * 统计就按标签分开算：学习时长、休息时长、生活时长。
 * 生活还要按待办标题里的关键词（健身、跑步、做饭…）分组，所以记录里存了 title。
 *
 * 记录存秒（sec），不存分钟：「生活」这类碎片时间要精确到几分几秒，
 * 全用四舍五入到分钟会把 1 分 20 秒抹成 1 分。
 *
 * 计时不靠 setInterval 累加（小程序后台会被挂起，累加必然不准），
 * 而是记一个「结束时刻 endAt」，每次刷新用 now 去减 —— 从后台回来也对得上。
 * pause 时把剩余毫秒固化到 remainMs，resume 再重新换算 endAt。
 */
const SCOPE = require('./scope.js')
const TASK_KEY = 'tomato_tasks_v1'
const SES_KEY = 'tomato_sessions_v1'
const SET_KEY = 'tomato_settings_v1'
const RUN_KEY = 'tomato_run_v1'
// 按天汇总：{ '1750000000000': { study:{s,n}, rest:{s,n}, life:{s,n} } }
//   s 秒数、n 次数；一天一个键，不会滚掉，
//   所以「今年学了多少 / 生活了多少」这种跨度大的统计照样准。
// 老版本是 { min, pomos, rest, rests }，读的时候会自动转成新格式。
const DAY_KEY = 'tomato_days_v1'

const MODE_FOCUS = 'focus'
const MODE_BREAK = 'break'

/* ---------------- 标签 ---------------- */

const TAG_STUDY = 'study'
const TAG_REST = 'rest'
const TAG_LIFE = 'life'

// 顺序就是界面上的顺序：学习 / 休息 / 生活
const TAGS = [
  { k: TAG_STUDY, t: '学习', color: '#6366F1' },
  { k: TAG_REST, t: '休息', color: '#10B981' },
  { k: TAG_LIFE, t: '生活', color: '#F59E0B' }
]
const TAG_KEYS = [TAG_STUDY, TAG_REST, TAG_LIFE]

function tagOf(v) {
  return TAG_KEYS.indexOf(str(v)) > -1 ? str(v) : TAG_STUDY
}

function tagLabel(v) {
  const k = tagOf(v)
  const hit = TAGS.filter((x) => x.k === k)[0]
  return hit ? hit.t : '学习'
}

function tagColor(v) {
  const k = tagOf(v)
  const hit = TAGS.filter((x) => x.k === k)[0]
  return hit ? hit.color : '#6366F1'
}

// 时长都能自定义，只做安全范围兜底：专注 1~180 分钟，休息 1~90 分钟
const RANGE = { focus: [1, 180], break: [1, 90] }

const DEFAULT_SETTINGS = { focus: 25, break: 5, goal: 8, autoNext: false }

function nowTs() {
  return Date.now()
}

function uid(p) {
  return (p || 'x') + nowTs().toString(36) + Math.random().toString(36).slice(2, 6)
}

function str(v) {
  return v === undefined || v === null ? '' : String(v)
}

function clampInt(v, min, max, dft) {
  const n = Math.round(Number(v))
  if (!isFinite(n)) return dft
  if (n < min) return min
  if (n > max) return max
  return n
}

/**
 * 把用户输入的时长串变成合法分钟数。
 * 认「45」「45分」「45分钟」「1h」「1.5小时」这些写法，认不出来返回 null。
 */
function parseMinutes(text, kind) {
  const s = str(text).trim()
  if (!s) return null
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(小时|时|h|H|分钟|分|m|M)?$/)
  if (!m) return null
  let n = Number(m[1])
  if (!isFinite(n) || n <= 0) return null
  const unit = m[2] || ''
  if (/小时|时|h|H/.test(unit)) n = n * 60
  return clampRange(n, kind || MODE_FOCUS)
}

/** 夹到该模式的合法范围 */
function clampRange(v, kind) {
  const r = RANGE[kind === MODE_BREAK ? MODE_BREAK : MODE_FOCUS]
  return clampInt(v, r[0], r[1], r[0])
}

/** 当前模式允许的分钟范围，界面上提示用 */
function rangeOf(kind) {
  const r = RANGE[kind === MODE_BREAK ? MODE_BREAK : MODE_FOCUS]
  return { min: r[0], max: r[1] }
}

/* ---------------- 设置 ---------------- */

function getSettings() {
  let raw = null
  try {
    raw = wx.getStorageSync(SCOPE.key(SET_KEY))
  } catch (e) {
    raw = null
  }
  const o = raw && typeof raw === 'object' ? raw : {}
  return {
    // 专注 1~180 分钟，休息 1~90 分钟，目标 1~24 个
    focus: clampInt(o.focus, RANGE.focus[0], RANGE.focus[1], DEFAULT_SETTINGS.focus),
    break: clampInt(o.break, RANGE.break[0], RANGE.break[1], DEFAULT_SETTINGS.break),
    goal: clampInt(o.goal, 1, 24, DEFAULT_SETTINGS.goal),
    autoNext: o.autoNext === true
  }
}

function saveSettings(patch) {
  const next = Object.assign({}, getSettings(), patch || {})
  const clean = {
    focus: clampInt(next.focus, RANGE.focus[0], RANGE.focus[1], DEFAULT_SETTINGS.focus),
    break: clampInt(next.break, RANGE.break[0], RANGE.break[1], DEFAULT_SETTINGS.break),
    goal: clampInt(next.goal, 1, 24, DEFAULT_SETTINGS.goal),
    autoNext: next.autoNext === true
  }
  try {
    wx.setStorageSync(SCOPE.key(SET_KEY), clean)
  } catch (e) {
    /* ignore */
  }
  return clean
}

/* ---------------- 待办 ---------------- */

function normalizeTask(t) {
  const o = t && typeof t === 'object' ? t : {}
  const created = Number(o.createdAt) || nowTs()
  return {
    id: str(o.id) || uid('t'),
    title: str(o.title).trim(),
    // 老数据没有 tag，一律当学习；新加的一条必须选标签
    tag: tagOf(o.tag),
    pomos: Math.max(0, Math.round(Number(o.pomos) || 0)),
    done: o.done === true,
    createdAt: created,
    doneAt: Number(o.doneAt) || 0
  }
}

function getTasks() {
  let raw = null
  try {
    raw = wx.getStorageSync(SCOPE.key(TASK_KEY))
  } catch (e) {
    raw = null
  }
  if (!Array.isArray(raw)) return []
  const all = raw.map(normalizeTask).filter((t) => !!t.title || !!t.id)
  // 未完成在前，完成沉底；同类按创建时间倒序（新加的在上）
  return all.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1
    return (b.createdAt || 0) - (a.createdAt || 0)
  })
}

function writeTasks(list) {
  const arr = (Array.isArray(list) ? list : []).map(normalizeTask)
  try {
    wx.setStorageSync(SCOPE.key(TASK_KEY), arr)
  } catch (e) {
    /* ignore */
  }
  return arr
}

function addTask(title, tag) {
  const t = str(title).trim()
  if (!t) return null
  const all = getTasks()
  // 同一毫秒连加两条时也要分得出先后，否则新加的不在最上面
  let max = 0
  all.forEach((x) => {
    if (x.createdAt > max) max = x.createdAt
  })
  const now = nowTs()
  const item = normalizeTask({ title: t, tag: tagOf(tag), createdAt: now > max ? now : max + 1 })
  all.push(item)
  writeTasks(all)
  return item
}

/** 改一条待办的标签（学习 / 休息 / 生活） */
function setTaskTag(id, tag) {
  const all = getTasks()
  const i = all.findIndex((x) => x.id === id)
  if (i < 0) return null
  all[i] = normalizeTask(Object.assign({}, all[i], { tag: tagOf(tag) }))
  writeTasks(all)
  return all[i]
}

function toggleTask(id) {
  const all = getTasks()
  const i = all.findIndex((x) => x.id === id)
  if (i < 0) return null
  const done = !all[i].done
  all[i] = normalizeTask(Object.assign({}, all[i], { done: done, doneAt: done ? nowTs() : 0 }))
  writeTasks(all)
  return all[i]
}

function removeTask(id) {
  const all = getTasks().filter((x) => x.id !== id)
  writeTasks(all)
  return all.length
}

/** 一条专注记录完成后，给对应待办 +1 个番茄 */
function bumpTaskPomo(id) {
  const all = getTasks()
  const i = all.findIndex((x) => x.id === id)
  if (i < 0) return null
  all[i] = normalizeTask(Object.assign({}, all[i], { pomos: all[i].pomos + 1 }))
  writeTasks(all)
  return all[i]
}

/* ---------------- 专注记录 ---------------- */

function normSession(s) {
  const o = s && typeof s === 'object' ? s : {}
  const mode = o.mode === MODE_BREAK ? MODE_BREAK : MODE_FOCUS
  // 老记录只存了 minutes：当成整分钟换回秒
  const sec = Math.max(0, Math.round(Number(o.sec) || (Number(o.minutes) || 0) * 60))
  return {
    id: str(o.id) || uid('s'),
    taskId: str(o.taskId),
    // 标题存快照：待办改名/删掉了，按关键词统计生活时长还得靠它
    title: str(o.title).trim(),
    // 老记录没有 tag：休息模式算休息，其余都是学习
    tag: o.tag ? tagOf(o.tag) : mode === MODE_BREAK ? TAG_REST : TAG_STUDY,
    mode: mode,
    sec: sec,
    minutes: Math.round(sec / 60),
    at: Number(o.at) || nowTs()
  }
}

function getSessions() {
  let raw = null
  try {
    raw = wx.getStorageSync(SCOPE.key(SES_KEY))
  } catch (e) {
    raw = null
  }
  if (!Array.isArray(raw)) return []
  return raw.map(normSession).sort((a, b) => b.at - a.at)
}

function addSession(s) {
  const o = s && typeof s === 'object' ? s : {}
  const item = normSession({
    taskId: o.taskId,
    title: o.title,
    tag: o.tag,
    mode: o.mode,
    sec: o.sec,
    minutes: o.minutes,
    at: Number(o.at) || nowTs()
  })
  // 先取按天汇总（必要时它会把老格式转一遍），再写新明细 ——
  // 顺序反了这条会被算两遍
  const days = getDays()
  const all = getSessions()
  all.push(item)
  // 只留最近 500 条，免得本机存储越滚越大
  const keep = all.slice(0, 500)
  try {
    wx.setStorageSync(SCOPE.key(SES_KEY), keep)
  } catch (e) {
    /* ignore */
  }
  // 按标签进汇总表：学习 / 休息 / 生活各一格，秒级累加
  const k = String(startOfDay(item.at))
  const cur = days[k] || blankDay()
  const slot = cur[item.tag] || blankSlot()
  slot.s += item.sec
  slot.n += 1
  cur[item.tag] = slot
  days[k] = cur
  writeDays(days)
  return item
}

/* ---------------- 按天汇总（年/月/周统计的地基） ---------------- */

function blankSlot() {
  return { s: 0, n: 0 }
}

function blankDay() {
  return { study: blankSlot(), rest: blankSlot(), life: blankSlot() }
}

function normSlot(v) {
  const o = v && typeof v === 'object' ? v : {}
  return {
    s: Math.max(0, Math.round(Number(o.s) || 0)),
    n: Math.max(0, Math.round(Number(o.n) || 0))
  }
}

/**
 * 一天的汇总，统一成 { study:{s,n}, rest:{s,n}, life:{s,n} }。
 * 老格式是 { min, pomos, rest, rests }（分钟），这里顺手换算，
 * 这样升级上来的存量数据不用清也不会丢历史。
 */
function normDay(src) {
  const o = src && typeof src === 'object' ? src : {}
  if (o.study && typeof o.study === 'object') {
    return { study: normSlot(o.study), rest: normSlot(o.rest), life: normSlot(o.life) }
  }
  const mins = (v) => Math.round(Math.max(0, Number(v) || 0) * 60)
  return {
    study: { s: mins(o.min), n: Math.max(0, Math.round(Number(o.pomos) || 0)) },
    rest: { s: mins(o.rest), n: Math.max(0, Math.round(Number(o.rests) || 0)) },
    life: blankSlot()
  }
}

function buildDays(sessions) {
  const map = {}
  ;(Array.isArray(sessions) ? sessions : []).forEach((s) => {
    if (!s) return
    const x = normSession(s)
    const at = Number(x.at) || 0
    if (!at) return
    const k = String(startOfDay(at))
    const cur = map[k] || blankDay()
    cur[x.tag].s += x.sec
    cur[x.tag].n += 1
    map[k] = cur
  })
  return map
}

function writeDays(map) {
  const out = map && typeof map === 'object' ? map : {}
  try {
    wx.setStorageSync(SCOPE.key(DAY_KEY), out)
  } catch (e) {
    /* ignore */
  }
  return out
}

function getDays() {
  let raw = null
  try {
    raw = wx.getStorageSync(SCOPE.key(DAY_KEY))
  } catch (e) {
    raw = null
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const out = {}
    let legacy = false
    // 更老的版本连 rest/rests 都没有：那天的休息要从明细里回填一次
    let needRest = false
    Object.keys(raw).forEach((k) => {
      const t = Number(k)
      if (!isFinite(t) || t <= 0) return
      const src = raw[k]
      if (!(src && typeof src === 'object' && src.study)) legacy = true
      if (src && typeof src === 'object' && src.rest === undefined && src.rests === undefined) needRest = true
      out[String(t)] = normDay(src)
    })
    if (needRest) {
      // 学习时长以表里的为准（表比明细活得久），休息时长从明细回填最多 500 条
      const old = buildDays(getSessions())
      Object.keys(old).forEach((k) => {
        if (!out[k]) {
          out[k] = old[k]
          return
        }
        out[k].rest.s = Math.max(out[k].rest.s, old[k].rest.s)
        out[k].rest.n = Math.max(out[k].rest.n, old[k].rest.n)
      })
    }
    // 读到老格式就顺手落成新格式，下次不用再转
    if (legacy || needRest) writeDays(out)
    return out
  }
  // 第一次读（或是从旧版本升上来）：拿明细汇总一遍补上
  return writeDays(buildDays(getSessions()))
}

/** 传数组就现算，传汇总表就用它，什么都不传读本机 */
function asDays(input) {
  if (Array.isArray(input)) return buildDays(input)
  if (input && typeof input === 'object') return input
  return getDays()
}

/** 某个区间内各标签各花了多少秒：from <= t < to */
function summarizeDays(days, from, to) {
  const map = days && typeof days === 'object' ? days : {}
  const lo = Number(from) || 0
  const hi = to === undefined || to === null ? Infinity : Number(to)
  const acc = { study: blankSlot(), rest: blankSlot(), life: blankSlot() }
  const dayHit = { study: 0, rest: 0, life: 0 }
  let active = 0
  Object.keys(map).forEach((k) => {
    const t = Number(k)
    if (!isFinite(t) || t < lo || t >= hi) return
    const d = normDay(map[k])
    let any = false
    TAG_KEYS.forEach((tg) => {
      const v = d[tg]
      if (v.s <= 0 && v.n <= 0) return
      acc[tg].s += v.s
      acc[tg].n += v.n
      dayHit[tg]++
      any = true
    })
    if (any) active++
  })
  return {
    // 三块都带着，前端切标签不用重算
    study: acc.study,
    rest: acc.rest,
    life: acc.life,
    days: active,
    studyDays: dayHit.study,
    restDays: dayHit.rest,
    lifeDays: dayHit.life
  }
}

/** 「2 小时 35 分」这种给人看的写法（入参是分钟，老口径） */
function fmtDur(min) {
  const total = Math.max(0, Math.round(Number(min) || 0))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (!h) return m + ' 分'
  if (!m) return h + ' 小时'
  return h + ' 小时 ' + m + ' 分'
}

/** 柱状图顶上那点小字：「45分」「3.5h」（入参是分钟，老口径） */
function fmtDurShort(min) {
  const total = Math.max(0, Math.round(Number(min) || 0))
  if (!total) return ''
  if (total < 60) return total + '分'
  const h = total / 60
  return (h >= 10 ? Math.round(h) : Math.round(h * 10) / 10) + 'h'
}

/**
 * 秒级写法：「3 分 20 秒」「2 小时 5 分」。
 * 生活时长这类碎片时间要精确到秒，四舍五入到分钟会把 1 分 20 秒抹成 1 分。
 */
function fmtSpan(sec) {
  const t = Math.max(0, Math.round(Number(sec) || 0))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  if (h > 0) return m > 0 ? h + ' 小时 ' + m + ' 分' : h + ' 小时'
  if (m > 0) return s > 0 ? m + ' 分 ' + s + ' 秒' : m + ' 分'
  return s + ' 秒'
}

/**
 * 拆成「数字 + 单位」几段，好让数字用大字号、单位用小字号。
 * 小时级只到分（再塞秒就顶出格子了），一小时以内精确到秒。
 */
function spanParts(sec) {
  const t = Math.max(0, Math.round(Number(sec) || 0))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  if (h > 0) {
    const out = [{ k: 'h', n: String(h), u: '小时' }]
    if (m > 0) out.push({ k: 'm', n: String(m), u: '分' })
    return out
  }
  if (m > 0) {
    const out = [{ k: 'm', n: String(m), u: '分' }]
    if (s > 0) out.push({ k: 's', n: String(s), u: '秒' })
    return out
  }
  return [{ k: 's', n: String(s), u: '秒' }]
}

/** 柱子上那点小字，秒级：「40秒」「12分」「3.5h」 */
function fmtSpanShort(sec) {
  const t = Math.max(0, Math.round(Number(sec) || 0))
  if (!t) return ''
  if (t < 60) return t + '秒'
  const min = t / 60
  if (min < 60) return Math.round(min) + '分'
  const h = min / 60
  return (h >= 10 ? Math.round(h) : Math.round(h * 10) / 10) + 'h'
}

/* ---------------- 生活关键词 ---------------- */

// 常见的生活活动词。按长度从长到短匹配，「健身房」先于「健身」命中。
const LIFE_WORDS = [
  '仰卧起坐', '俯卧撑', '眼保健操', '洗衣服', '晾衣服', '扔垃圾',
  '健身房', '健身', '锻炼', '跑步', '慢跑', '快走', '散步', '遛弯', '拉伸', '瑜伽',
  '跳绳', '游泳', '骑车', '通勤', '坐车', '打球', '篮球', '足球', '羽毛球', '乒乓',
  '洗澡', '洗漱', '刷牙', '洗脸', '理发',
  '早饭', '午饭', '晚饭', '吃饭', '做饭', '煮饭', '做饭吃', '点外卖', '外卖', '零食',
  '洗碗', '打扫', '扫地', '拖地', '擦桌子', '收拾', '整理', '收纳',
  '买菜', '购物', '超市', '逛超市', '快递', '取快递', '取件',
  '睡觉', '午睡', '午休', '赖床', '小憩',
  '游戏', '打游戏', '追剧', '看剧', '刷手机', '刷视频', '看视频', '聊天', '视频通话',
  '听歌', '音乐', '吉他', '钢琴', '画画', '冥想', '发呆', '泡脚', '喝咖啡'
]
// 建表时就按长度排好，保证「先具体后笼统」
LIFE_WORDS.sort((a, b) => b.length - a.length)

// 抽关键词时先扔掉这些没信息量的词（连数字一起扔），剩下的当关键词
const LIFE_NOISE = /打卡|记录|计划|分钟|小时|今天|明天|每天|一下|一次|半个|一个|时间|日常|\d+/g

/**
 * 从待办标题里认一个「生活关键词」。
 * 认出「健身」「跑步」这种具体词就用它，认不出就把标题砍到 6 个字当关键词 ——
 * 宁可用标题本身，也别把所有生活时间都糊进一个「其它」。
 */
function lifeKey(title) {
  const s = str(title).replace(/[\s\u3000]+/g, '')
  for (let i = 0; i < LIFE_WORDS.length; i++) {
    if (s.indexOf(LIFE_WORDS[i]) > -1) return LIFE_WORDS[i]
  }
  const clean = s.replace(LIFE_NOISE, '')
  const use = clean || s
  return use.slice(0, 6) || '其它'
}

/**
 * 生活时长按关键词分组：[{ kw, sec, n, txt, sub, pct }]，秒数多的在前。
 * 数据源是明细（最多最近 500 条）—— 按关键词分组没法预汇总到按天表里，
 * 好在一个人的生活条目本来就不多，500 条足够回溯很久。
 */
function lifeKeywords(input, from, to) {
  const list = Array.isArray(input) ? input : getSessions()
  const lo = Number(from) || 0
  const hi = to === undefined || to === null ? Infinity : Number(to)
  const map = {}
  list.forEach((raw) => {
    const s = normSession(raw)
    if (s.tag !== TAG_LIFE) return
    if (s.at < lo || s.at >= hi) return
    const k = lifeKey(s.title)
    const cur = map[k] || { kw: k, sec: 0, n: 0 }
    cur.sec += s.sec
    cur.n += 1
    map[k] = cur
  })
  const out = Object.keys(map)
    .map((k) => map[k])
    .sort((a, b) => b.sec - a.sec)
  const max = out.length ? out[0].sec : 0
  out.forEach((x) => {
    x.txt = fmtSpan(x.sec)
    x.sub = x.n + ' 次'
    x.pct = max > 0 ? Math.max(6, Math.round((x.sec / max) * 100)) : 0
  })
  return out
}

/* ---------------- 统计 ---------------- */

function startOfDay(ts) {
  const d = new Date(Number(ts) || nowTs())
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** 周一为一周起点（跟课表一致） */
function startOfWeek(ts) {
  const d = new Date(Number(ts) || nowTs())
  const s = startOfDay(d.getTime())
  const wd = d.getDay() // 0=周日
  const back = wd === 0 ? 6 : wd - 1
  return s - back * 86400000
}

function startOfMonth(ts) {
  const d = new Date(Number(ts) || nowTs())
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

function startOfYear(ts) {
  const d = new Date(Number(ts) || nowTs())
  return new Date(d.getFullYear(), 0, 1).getTime()
}

const DAY_MS = 86400000

/**
 * 四段汇总：今天 / 本周 / 本月 / 今年，另加一个不限时间的累计。
 * days 可以是明细数组、汇总表，或什么都不传（读本机）。
 */
function report(input, now) {
  const days = asDays(input)
  const cur = Number(now) || nowTs()
  const d0 = startOfDay(cur)
  const w0 = startOfWeek(cur)
  const m0 = startOfMonth(cur)
  const y0 = startOfYear(cur)
  const md = new Date(m0)
  const yd = new Date(y0)
  const mEnd = new Date(md.getFullYear(), md.getMonth() + 1, 1).getTime()
  const yEnd = new Date(yd.getFullYear() + 1, 0, 1).getTime()

  return {
    total: summarizeDays(days, 0),
    day: summarizeDays(days, d0, d0 + DAY_MS),
    week: summarizeDays(days, w0, w0 + 7 * DAY_MS),
    month: summarizeDays(days, m0, mEnd),
    year: summarizeDays(days, y0, yEnd)
  }
}

const CHART_MODES = ['day', 'week', 'month', 'year']
const CHART_COUNTS = { day: 7, week: 6, month: 6, year: 4 }

/**
 * 柱状图数据。mode: day 近 7 天 / week 近 6 周 / month 近 6 个月 / year 近 4 年。
 * metric: focus 看学习分钟数（默认）/ break 看休息分钟数。
 * 最后一根柱子就是「当前这一格」，前端会高亮它。
 */
function chart(input, mode, now, metric) {
  const days = asDays(input)
  const cur = Number(now) || nowTs()
  const m = CHART_MODES.indexOf(mode) > -1 ? mode : 'day'
  // metric 就是标签：study / rest / life
  const mk = tagOf(metric)
  const n = CHART_COUNTS[m]
  const slots = []

  if (m === 'day') {
    const d0 = startOfDay(cur)
    for (let i = n - 1; i >= 0; i--) {
      const from = d0 - i * DAY_MS
      slots.push({ from: from, to: from + DAY_MS })
    }
  } else if (m === 'week') {
    const w0 = startOfWeek(cur)
    for (let i = n - 1; i >= 0; i--) {
      const from = w0 - i * 7 * DAY_MS
      slots.push({ from: from, to: from + 7 * DAY_MS })
    }
  } else if (m === 'month') {
    const d = new Date(startOfMonth(cur))
    for (let i = n - 1; i >= 0; i--) {
      slots.push({
        from: new Date(d.getFullYear(), d.getMonth() - i, 1).getTime(),
        to: new Date(d.getFullYear(), d.getMonth() - i + 1, 1).getTime()
      })
    }
  } else {
    const y = new Date(startOfYear(cur)).getFullYear()
    for (let i = n - 1; i >= 0; i--) {
      slots.push({
        from: new Date(y - i, 0, 1).getTime(),
        to: new Date(y - i + 1, 0, 1).getTime()
      })
    }
  }

  const bars = slots.map((s, i) => {
    const r = summarizeDays(days, s.from, s.to)
    const d = new Date(s.from)
    let label = ''
    if (m === 'day') label = i === slots.length - 1 ? '今天' : ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
    else if (m === 'week') label = d.getMonth() + 1 + '/' + d.getDate()
    else if (m === 'month') label = d.getMonth() + 1 + '月'
    else label = String(d.getFullYear())
    // 秒数：生活这种碎片时间要看「几分几秒」，整分钟会把它抹平
    const value = r[mk].s
    return {
      from: s.from,
      to: s.to,
      label: label,
      // 三个标签的秒数都带着，前端切标签时不用重算
      study: r.study.s,
      rest: r.rest.s,
      life: r.life.s,
      value: value,
      isNow: i === slots.length - 1,
      txt: fmtSpanShort(value)
    }
  })

  let max = 0
  let sum = 0
  bars.forEach((b) => {
    if (b.value > max) max = b.value
    sum += b.value
  })
  bars.forEach((b) => {
    // 有数据就至少留 6% 高度，不然 5 分钟的柱子看不见
    b.pct = max > 0 && b.value > 0 ? Math.max(6, Math.round((b.value / max) * 100)) : 0
  })

  return {
    mode: m,
    metric: mk,
    bars: bars,
    max: max,
    // 秒；生活时长要精确到几分几秒
    sum: sum,
    from: slots.length ? slots[0].from : 0,
    to: slots.length ? slots[slots.length - 1].to : 0
  }
}

/**
 * 汇总：今日番茄数 / 今日专注分钟 / 休息分钟 / 生活分钟 / 本周番茄数 / 连续天数
 * sessions 传进来方便测试；不传就读本机。
 */
function stats(sessions, now) {
  const all = Array.isArray(sessions) ? sessions : getSessions()
  const cur = Number(now) || nowTs()
  const d0 = startOfDay(cur)
  const w0 = startOfWeek(cur)

  let today = 0
  let todayMin = 0
  let todayRest = 0
  let todayLife = 0
  let week = 0
  let weekRest = 0
  const days = {}

  all.forEach((raw) => {
    const s = normSession(raw)
    const at = Number(s.at) || 0
    const min = Math.round(s.sec / 60)
    // 休息只算休息时长，不占番茄数、也不参与连续打卡
    if (s.mode === MODE_BREAK) {
      if (at >= d0) todayRest += min
      if (at >= w0) weekRest += min
      return
    }
    if (s.mode !== MODE_FOCUS) return
    if (at >= d0) {
      today++
      todayMin += min
      // 生活也是「专注」来的，单独记一笔给「生活时长」用
      if (s.tag === TAG_LIFE) todayLife += min
    }
    if (at >= w0) week++
    if (at > 0) {
      const k = startOfDay(at)
      days[k] = (days[k] || 0) + 1
    }
  })

  // 连续打卡：从今天往前数，今天没专注就从昨天开始算（今天还有机会补）
  let streak = 0
  let cursor = d0
  if (!days[cursor]) cursor = d0 - 86400000
  while (days[cursor]) {
    streak++
    cursor -= 86400000
  }

  const st = getSettings()
  return {
    today: today,
    todayMin: todayMin,
    todayRest: todayRest,
    todayLife: todayLife,
    week: week,
    weekRest: weekRest,
    streak: streak,
    goal: st.goal,
    // 目标完成度 0~100
    goalPct: st.goal > 0 ? Math.min(100, Math.round((today / st.goal) * 100)) : 0
  }
}

/* ---------------- 计时状态机（纯函数，好测） ---------------- */

/**
 * 开一个新的一轮。
 * mode: focus | break，minutes: 时长（分钟）
 */
function startRun(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const mode = o.mode === MODE_BREAK ? MODE_BREAK : MODE_FOCUS
  // 时长自定义：只挡明显不合理的值，其余随便填
  const dft = mode === MODE_BREAK ? DEFAULT_SETTINGS.break : DEFAULT_SETTINGS.focus
  const minutes = clampRange(clampInt(o.minutes, 1, 180, dft), mode)
  const now = Number(o.now) || nowTs()
  const totalMs = minutes * 60000
  return {
    mode: mode,
    taskId: str(o.taskId),
    taskTitle: str(o.taskTitle),
    // 这一轮算哪个标签：休息模式一律算休息，专注模式跟待办走
    tag: mode === MODE_BREAK ? TAG_REST : tagOf(o.tag),
    totalMs: totalMs,
    remainMs: totalMs,
    endAt: now + totalMs,
    running: true,
    startedAt: now,
    // 暂停过几次（「放弃」时用来判断值不值得记一条）
    pauses: 0
  }
}

/** 当前剩余毫秒（跑着就用 endAt 算，暂停着就用固化的 remainMs） */
function remainOf(run, now) {
  if (!run || typeof run !== 'object') return 0
  const cur = Number(now) || nowTs()
  if (run.running) {
    const left = (Number(run.endAt) || 0) - cur
    return left > 0 ? left : 0
  }
  return Math.max(0, Number(run.remainMs) || 0)
}

function isFinished(run, now) {
  return remainOf(run, now) <= 0
}

/** 已走过的比例 0~1（画圆环用） */
function progressOf(run, now) {
  if (!run) return 0
  const total = Number(run.totalMs) || 0
  if (total <= 0) return 0
  const left = remainOf(run, now)
  return Math.max(0, Math.min(1, 1 - left / total))
}

function pauseRun(run, now) {
  if (!run || !run.running) return run
  const cur = Number(now) || nowTs()
  const left = remainOf(run, cur)
  return Object.assign({}, run, {
    running: false,
    remainMs: left,
    endAt: 0,
    pauses: (Number(run.pauses) || 0) + 1
  })
}

function resumeRun(run, now) {
  if (!run || run.running) return run
  const cur = Number(now) || nowTs()
  const left = Math.max(0, Number(run.remainMs) || 0)
  return Object.assign({}, run, {
    running: true,
    remainMs: left,
    endAt: cur + left
  })
}

/** mm:ss */
function fmtClock(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return ('0' + m).slice(-2) + ':' + ('0' + s).slice(-2)
}

/** 计时器状态落盘/读回：切页面、切后台都不丢 */
function saveRun(run) {
  try {
    if (!run) wx.removeStorageSync(SCOPE.key(RUN_KEY))
    else wx.setStorageSync(SCOPE.key(RUN_KEY), run)
  } catch (e) {
    /* ignore */
  }
}

function loadRun() {
  let raw = null
  try {
    raw = wx.getStorageSync(SCOPE.key(RUN_KEY))
  } catch (e) {
    raw = null
  }
  if (!raw || typeof raw !== 'object') return null
  if (!raw.mode || !Number(raw.totalMs)) return null
  return raw
}

function clearRun() {
  saveRun(null)
}

module.exports = {
  TASK_KEY,
  SES_KEY,
  SET_KEY,
  RUN_KEY,
  DAY_KEY,
  MODE_FOCUS,
  MODE_BREAK,
  TAG_STUDY,
  TAG_REST,
  TAG_LIFE,
  TAGS,
  TAG_KEYS,
  tagOf,
  tagLabel,
  tagColor,
  RANGE,
  DEFAULT_SETTINGS,
  parseMinutes,
  rangeOf,
  getSettings,
  saveSettings,
  getTasks,
  addTask,
  setTaskTag,
  toggleTask,
  removeTask,
  bumpTaskPomo,
  getSessions,
  normSession,
  addSession,
  getDays,
  writeDays,
  buildDays,
  normDay,
  summarizeDays,
  startOfDay,
  startOfWeek,
  startOfMonth,
  startOfYear,
  stats,
  report,
  chart,
  fmtDur,
  fmtDurShort,
  fmtSpan,
  spanParts,
  fmtSpanShort,
  LIFE_WORDS,
  lifeKey,
  lifeKeywords,
  startRun,
  remainOf,
  isFinished,
  progressOf,
  pauseRun,
  resumeRun,
  fmtClock,
  saveRun,
  loadRun,
  clearRun
}
