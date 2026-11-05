/**
 * 课表：解析 + 网格计算 + 存取辅助。
 *
 * 没有学校教务系统的接口（各校都不一样、还都要登录），所以走「粘贴导入」：
 * 把课表原样粘进来，这里做容错解析。常见写法都认：
 *
 *   周一 1-2节 汇编语言 松园3-201
 *   星期二,第3-4节,大学英语,北3-105 1-16周
 *   礼拜三 5-6 数据结构@松园2-301 1-16周(单)
 *   四 7-8节 软件工程导论
 *
 * 纯函数部分不依赖 wx，方便直接跑测试。
 */

const DAY_NAMES = ['一', '二', '三', '四', '五', '六', '日']

/** 节次 → 起止时间，用来判断「现在正上哪节课」 */
const PERIOD_TIME = {
  '1-2': '08:00-09:40',
  '3-4': '10:00-11:40',
  '5-6': '14:00-15:40',
  '7-8': '16:00-17:40',
  '9-10': '19:00-20:40',
  '11-12': '20:50-22:30'
}

/** 单个节次的开始时间，网格左侧时间列用 */
const PERIOD_START = {
  1: '08:00', 2: '08:55', 3: '10:00', 4: '10:55',
  5: '14:00', 6: '14:55', 7: '16:00', 8: '16:55',
  9: '19:00', 10: '19:55', 11: '20:50', 12: '21:45'
}

const DAY_ALIAS = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7,
  '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7
}

/** 课程块配色：同一个课名永远同一个颜色（浅色 / 深色各一套，一一对应） */
const PALETTE = [
  { bg: '#EDECFC', fg: '#4C45D6', bar: '#6C63E8' },
  { bg: '#E4F2FE', fg: '#1F6FD0', bar: '#3E8FE8' },
  { bg: '#E7F7EE', fg: '#15803D', bar: '#22A05A' },
  { bg: '#FEF3E2', fg: '#B45309', bar: '#E08A2B' },
  { bg: '#FDE9EF', fg: '#BE185D', bar: '#E0507F' },
  { bg: '#EAF0FA', fg: '#35508A', bar: '#5B78B5' },
  { bg: '#F1E9FB', fg: '#7C3AED', bar: '#9C6BF0' },
  { bg: '#E6F5F4', fg: '#0F766E', bar: '#2A9D93' },
  { bg: '#FCF0E7', fg: '#9A3412', bar: '#CB6136' },
  { bg: '#EDF3E6', fg: '#3F6212', bar: '#6A9231' }
]

const DARK_PALETTE = [
  { bg: '#2C2B4A', fg: '#B7B3F5', bar: '#6C63E8' },
  { bg: '#1E3348', fg: '#8CC2F5', bar: '#3E8FE8' },
  { bg: '#1B3A2A', fg: '#8FD9AC', bar: '#22A05A' },
  { bg: '#3A2E1C', fg: '#F0C583', bar: '#E08A2B' },
  { bg: '#3E2231', fg: '#F2A3C2', bar: '#E0507F' },
  { bg: '#232E45', fg: '#A9BEE3', bar: '#5B78B5' },
  { bg: '#2F2444', fg: '#C8ADF8', bar: '#9C6BF0' },
  { bg: '#1C3634', fg: '#8FD8D0', bar: '#2A9D93' },
  { bg: '#38261A', fg: '#EBB08D', bar: '#CB6136' },
  { bg: '#28321C', fg: '#C2DB92', bar: '#6A9231' }
]

function dayOf(name) {
  return DAY_ALIAS[String(name || '').trim()] || 0
}

function periodLabel(start, end) {
  if (!start) return ''
  return end && end !== start ? start + '-' + end : String(start)
}

function hashOf(s) {
  let h = 0
  const t = String(s || '')
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 100000
  return h
}

function colorOf(name, dark) {
  const p = dark ? DARK_PALETTE : PALETTE
  return p[hashOf(name) % p.length]
}

/**
 * 「1-16周」「第1-16周(单)」「单周」「双周」→ { from, to, parity }
 * parity: 0 每周 / 1 单周 / 2 双周
 */
function parseWeeks(text) {
  const s = String(text || '')
  if (!s) return null

  // 单双周括号紧跟在周次后面时，必须和整段一起吃掉，否则会残留成「地点」
  const rm = s.match(
    /(?:第\s*)?(\d{1,2})\s*[-~—－–至到]\s*(\d{1,2})\s*周\s*(?:[\(（]\s*([单双])\s*[\)）])?/
  )
  if (rm) {
    const from = Number(rm[1])
    const to = Number(rm[2])
    const parity = rm[3] ? (rm[3] === '单' ? 1 : 2) : 0
    return { from: Math.min(from, to), to: Math.max(from, to), parity, text: rm[0] }
  }

  const pm = s.match(/[\(（]\s*([单双])\s*[\)）]/) || s.match(/([单双])\s*周/)
  const parity = pm ? (pm[1] === '单' ? 1 : 2) : 0

  const om = s.match(/(\d{1,2})\s*周\s*(?:[\(（]\s*([单双])\s*[\)）])?/)
  if (om) {
    const n = Number(om[1])
    const p2 = om[2] ? (om[2] === '单' ? 1 : 2) : parity
    return { from: n, to: n, parity: p2, text: om[0] }
  }
  return parity ? { from: 1, to: 30, parity, text: pm[0] } : null
}

function weeksText(w) {
  if (!w) return ''
  // 教务带下来的精确周次列表：散点周（实验课）压缩成「4、6、8周」，
  // 纯单周/纯双周标成「2-17周(单)」，其余连续段压成「1-3、5、8-10周」
  const list = Array.isArray(w.list) ? w.list.slice().sort((a, b) => a - b) : null
  if (list && list.length) {
    if (list.length === 1) return list[0] + '周'
    const allOdd = list.every((x) => x % 2 === 1)
    const allEven = list.every((x) => x % 2 === 0)
    if (allOdd || allEven) {
      return list[0] + '-' + list[list.length - 1] + '周(' + (allOdd ? '单' : '双') + ')'
    }
    const parts = []
    let s = list[0]
    let p = list[0]
    for (let i = 1; i <= list.length; i++) {
      const v = list[i]
      if (v === p + 1) {
        p = v
        continue
      }
      parts.push(s === p ? String(s) : s + '-' + p)
      s = v
      p = v
    }
    return (parts.length <= 5 ? parts.join('、') : list[0] + '-' + list[list.length - 1]) + '周'
  }
  const body = w.from === w.to ? w.from + '周' : w.from + '-' + w.to + '周'
  if (w.parity === 1) return body + '(单)'
  if (w.parity === 2) return body + '(双)'
  return body
}

function parseLine(line) {
  const raw = String(line || '').trim()
  if (!raw) return null

  let dm = raw.match(/(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/)
  if (!dm) {
    // 也有人写成「四 7-8节 软件工程」
    const bare = raw.match(/^([一二三四五六日天]|[1-7])\s*[,，、\s]/)
    if (bare) dm = [bare[0], bare[1]]
  }
  if (!dm) return null
  const day = dayOf(dm[1])

  let rest = raw.replace(dm[0], ' ')

  // 周次要先抽走：否则「1-16周」会被下面的节次正则当成节次
  const weeks = parseWeeks(rest)
  if (weeks) rest = rest.replace(weeks.text, ' ')

  // 节次：第1-2节 / 1-2节 / 1~2 / 第3节
  let start = 0
  let end = 0
  const pm = rest.match(/第?\s*(\d{1,2})\s*(?:[-~—－–至到]\s*(\d{1,2}))?\s*节?/)
  if (pm) {
    start = Number(pm[1])
    end = Number(pm[2] || pm[1])
    rest = rest.replace(pm[0], ' ')
  }

  rest = rest.replace(/^[\s,，、;；:：|]+|[\s,，、;；:：|]+$/g, '')
  if (!rest) return null

  let name = rest
  let place = ''
  if (rest.indexOf('@') > -1) {
    const parts = rest.split('@')
    name = parts[0]
    place = parts.slice(1).join(' ')
  } else {
    const parts = rest.split(/[\t,，;；]+|\s{1,}/).filter(Boolean)
    if (parts.length >= 2) {
      place = parts.pop()
      name = parts.join(' ')
    }
  }

  name = String(name || '').replace(/^[\s,，、;；:：|]+|[\s,，、;；:：|]+$/g, '')
  place = String(place || '').trim()
  if (!name) return null
  // 「上午 / 下午 / 晚上」这类分组标题会落到这里，丢掉
  if (/^(上午|下午|中午|晚上|课程表|课表)$/.test(name)) return null

  return { day, start, end, name, place, weeks }
}

/**
 * 整段文本 → 课表条目
 * @returns {{items: Array, skipped: number}}
 */
function parseText(text) {
  const lines = String(text || '').split(/\r?\n/)
  const items = []
  const seen = {}
  let skipped = 0

  lines.forEach((line) => {
    const one = parseLine(line)
    if (!one) {
      if (String(line || '').trim()) skipped += 1
      return
    }
    const key = [one.day, one.start, one.end, one.name].join('|')
    if (seen[key]) return
    seen[key] = 1
    items.push(Object.assign({ id: key }, one))
  })

  items.sort((a, b) => a.day - b.day || (a.start || 99) - (b.start || 99))
  return { items, skipped }
}

/** 按星期分组，供页面渲染 */
function groupByDay(items) {
  const out = []
  for (let d = 1; d <= 7; d++) {
    const list = (items || [])
      .filter((x) => x.day === d)
      .sort((a, b) => (a.start || 99) - (b.start || 99))
    out.push({ day: d, name: '周' + DAY_NAMES[d - 1], items: list })
  }
  return out
}

/* ---------------- 周次 ---------------- */

function startOfDay(d) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

/** 把任意日期归到它所在那一周的周一 */
function mondayOf(date) {
  const d = startOfDay(date)
  const w = d.getDay() === 0 ? 7 : d.getDay()
  d.setDate(d.getDate() - (w - 1))
  return d
}

/** 第几周：termStart 为开学第一周的周一 */
function weekNoOf(date, termStart) {
  const t = mondayOf(termStart || new Date())
  const d = startOfDay(date)
  return Math.floor((d - t) / 86400000 / 7) + 1
}

/** 这一周要上的课：精确周次列表优先，其次周次范围 + 单双周 */
function inWeek(item, weekNo) {
  const w = item && item.weeks
  if (!w) return true
  if (!weekNo) return true
  if (Array.isArray(w.list) && w.list.length) return w.list.indexOf(weekNo) > -1
  if (weekNo < w.from || weekNo > w.to) return false
  if (w.parity === 1 && weekNo % 2 === 0) return false
  if (w.parity === 2 && weekNo % 2 === 1) return false
  return true
}

function fmtMD(d) {
  return d.getMonth() + 1 + '/' + d.getDate()
}

/**
 * 现在正上第几节（按两节一组的时间表算）
 * @returns {{from:number,to:number}|null}
 */
function currentPeriod(now) {
  const d = now || new Date()
  const mins = d.getHours() * 60 + d.getMinutes()
  const keys = Object.keys(PERIOD_TIME)
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    const m = PERIOD_TIME[k].match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/)
    if (!m) continue
    const s = Number(m[1]) * 60 + Number(m[2])
    const e = Number(m[3]) * 60 + Number(m[4])
    if (mins >= s && mins <= e) {
      const parts = k.split('-')
      return { from: Number(parts[0]), to: Number(parts[1]) }
    }
  }
  return null
}

/**
 * 网格数据。
 * @param {Array} items 全部课程
 * @param {number} weekNo 当前看的是第几周
 * @param {Object} opt { termStart, now, rowH, minPeriod, dark }
 */
function gridOf(items, weekNo, opt) {
  const o = opt || {}
  const rowH = o.rowH || 54
  const gap = 4
  const dark = !!o.dark
  const now = o.now ? new Date(o.now) : new Date()
  const termStart = o.termStart ? new Date(o.termStart) : mondayOf(now)
  const thisWeek = weekNoOf(now, termStart)
  const wno = weekNo || thisWeek
  const monday = new Date(mondayOf(termStart))
  monday.setDate(monday.getDate() + (wno - 1) * 7)
  const todayStr = startOfDay(now).getTime()
  // 只有看「本周」时才有「现在正上哪节」这回事
  const cur = wno === thisWeek ? currentPeriod(now) : null

  const list = (items || []).filter((x) => inWeek(x, wno))

  let maxEnd = 0
  list.forEach((x) => {
    maxEnd = Math.max(maxEnd, Number(x.end || x.start) || 0)
  })
  const maxPeriod = Math.max(o.minPeriod || 10, Math.min(14, maxEnd))

  const days = []
  for (let d = 1; d <= 7; d++) {
    const dayDate = new Date(monday)
    dayDate.setDate(monday.getDate() + (d - 1))
    const blocks = list
      .filter((x) => x.day === d)
      .sort((a, b) => (a.start || 99) - (b.start || 99))
      .map((x) => {
        const s = Math.max(1, Number(x.start) || 1)
        const e = Math.max(s, Number(x.end) || s)
        const c = colorOf(x.name, dark)
        return {
          id: x.id,
          name: x.name,
          place: x.place || '',
          start: x.start,
          end: x.end,
          period: periodLabel(x.start, x.end),
          weeksLabel: weeksText(x.weeks),
          bg: c.bg,
          fg: c.fg,
          bar: c.bar,
          top: (s - 1) * rowH,
          height: (e - s + 1) * rowH - gap,
          // 两节以内的块只放课程名，三四节以上才放地点
          showPlace: !!x.place && e - s >= 1
        }
      })
    days.push({
      day: d,
      name: '周' + DAY_NAMES[d - 1],
      date: fmtMD(dayDate),
      isToday: startOfDay(dayDate).getTime() === todayStr,
      count: blocks.length,
      items: blocks
    })
  }

  const rows = []
  for (let i = 1; i <= maxPeriod; i++) {
    rows.push({
      no: i,
      time: PERIOD_START[i] || '',
      isNow: !!cur && i >= cur.from && i <= cur.to
    })
  }

  return {
    weekNo: wno,
    thisWeek,
    isThisWeek: wno === thisWeek,
    nowPeriod: cur,
    maxPeriod,
    rowH,
    bodyH: maxPeriod * rowH,
    rows,
    days,
    total: list.length
  }
}

/** 今天第几节课在上：返回 {now, next} */
function todayInfo(items, now) {
  const today = now || new Date()
  const day = today.getDay() === 0 ? 7 : today.getDay()
  const list = (items || [])
    .filter((x) => x.day === day)
    .sort((a, b) => (a.start || 99) - (b.start || 99))

  const mins = today.getHours() * 60 + today.getMinutes()
  let current = null
  let next = null
  list.forEach((x) => {
    const span = PERIOD_TIME[periodLabel(x.start, x.end)] || ''
    const m = span.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/)
    if (!m) {
      if (!current && !next) next = x
      return
    }
    const s = Number(m[1]) * 60 + Number(m[2])
    const e = Number(m[3]) * 60 + Number(m[4])
    if (mins >= s && mins <= e) current = x
    else if (mins < s && !next) next = x
  })

  return { day, list, current, next }
}

/** 一门课实际要上的教学周列表：优先精确列表，否则按范围+单双周展开 */
function weekListOf(w) {
  if (!w) return []
  if (Array.isArray(w.list) && w.list.length) return w.list.slice().sort((a, b) => a - b)
  const out = []
  const from = Number(w.from) || 1
  const to = Number(w.to) || from
  for (let i = from; i <= to; i++) {
    if (w.parity === 1 && i % 2 === 0) continue
    if (w.parity === 2 && i % 2 === 1) continue
    out.push(i)
  }
  return out
}

/**
 * 把一个多周次的格子按周拆开（实验课每次实验单独一格，方便逐个重命名）。
 * 拆出来的格子名字带「·第N周」后缀，周次是精确单周。
 */
function splitByWeek(item) {
  const list = weekListOf(item && item.weeks)
  if (list.length < 2) return []
  return list.map((wk) => {
    const name = item.name + '·第' + wk + '周'
    return {
      id: [item.day, item.start, item.end, name].join('|'),
      day: item.day,
      start: item.start,
      end: item.end,
      name,
      place: item.place || '',
      weeks: { from: wk, to: wk, list: [wk], parity: 0 }
    }
  })
}

module.exports = {
  DAY_NAMES,
  PERIOD_TIME,
  PERIOD_START,
  PALETTE,
  DARK_PALETTE,
  colorOf,
  weekListOf,
  splitByWeek,
  parseLine,
  parseText,
  parseWeeks,
  weeksText,
  groupByDay,
  todayInfo,
  periodLabel,
  currentPeriod,
  mondayOf,
  weekNoOf,
  inWeek,
  gridOf,
  fmtMD
}
