/**
 * 学期判定（云端和小程序共用同一份，改这里要两边同步）。
 *
 * 为什么放纯函数：超星只给「课程开始时间」，不给「第几学期」。
 * 国内高校基本都是「8 月～次年 1 月 = 秋季学期，2～7 月 = 春季学期」，
 * 用开始时间落点推学期，比靠课程名里的「（2026春季）」可靠得多
 * （很多课名压根不带学期，比如「汇编语言」）。
 *
 * 返回结构：
 *   { key: '2026-2027-秋', label: '2026-2027 学年秋季学期', short: '2026 秋', rank: 202609 }
 * rank 用来排序 / 判断「是不是当前学期」——越大越新。
 */

const FALL_START_MONTH = 8 // 8 月起算秋季

function p4(y) {
  return String(y)
}

/** 秋季学期：startYear 年 9 月开始 */
function fall(startYear) {
  const y = Number(startYear)
  return {
    key: p4(y) + '-' + p4(y + 1) + '-秋',
    label: p4(y) + '-' + p4(y + 1) + ' 学年秋季学期',
    short: p4(y) + ' 秋',
    rank: y * 100 + 9
  }
}

/** 春季学期：endYear 年上半年（3~7 月） */
function spring(endYear) {
  const y = Number(endYear)
  return {
    key: p4(y - 1) + '-' + p4(y) + '-春',
    label: p4(y - 1) + '-' + p4(y) + ' 学年春季学期',
    short: p4(y) + ' 春',
    rank: (y - 1) * 100 + 2
  }
}

/**
 * 时间戳（毫秒或秒都认）→ 学期对象
 */
function of(ms) {
  const n = Number(ms)
  if (!n) return null
  const t = n > 1e12 ? n : n > 1e9 ? n * 1000 : 0
  if (!t) return null

  const d = new Date(t)
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  if (!y || isNaN(y)) return null

  if (m >= FALL_START_MONTH) return fall(y)
  if (m >= 2) return spring(y)
  return fall(y - 1) // 1 月是秋季学期的尾巴
}

/** 现在属于哪个学期 */
function current(now) {
  return of(now || Date.now())
}

/**
 * 从课程名里猜学期，兜底用。认这些写法：
 *   数据结构（2026春季） / 高等数学(2025-2026-2) / 大学英语 2026秋 / 2025—2026学年第二学期
 */
function fromName(name) {
  // 各种长短破折号统一成 ASCII 短横，避免正则里塞一堆全角符号
  const s = String(name || '').replace(/[—–－~至]/g, '-')
  if (!s) return null

  // 2025-2026-2 / 2025-2026学年第二学期（1/一 = 秋，2/二 = 春）
  let m = s.match(/(20\d{2})-?(20\d{2})(?:学年)?第?([12一二])学期?/)
  if (!m) m = s.match(/(20\d{2})-(20\d{2})-([12])/)
  if (m) {
    const y1 = Number(m[1])
    const first = m[3] === '1' || m[3] === '一'
    return first ? fall(y1) : spring(y1 + 1)
  }

  // 2026春季 / 2026 秋
  m = s.match(/(20\d{2})[年-]?\s*(春|秋|夏|冬)/)
  if (m) {
    const y = Number(m[1])
    return m[2] === '春' || m[2] === '夏' ? spring(y) : fall(y)
  }

  // 2 位年份 + 季节：25秋 / 26春 / 26秋（U校园、部分教务系统常用）
  //   两位年份一律补成 20xx（25→2025、26→2026）。
  m = s.match(/(?:^|[^\d])(\d{2})\s*(春|秋|夏|冬)/)
  if (m) {
    const y = 2000 + Number(m[1])
    return m[2] === '春' || m[2] === '夏' ? spring(y) : fall(y)
  }

  // 只有季节没有年份：按现在就近推
  const now = new Date()
  if (/春季|下学期|第二学期/.test(s)) return spring(now.getFullYear())
  if (/秋季|上学期|第一学期/.test(s)) return fall(now.getFullYear())
  return null
}

/** 「无法判断学期」的任务统一归这里，UI 上单独列 */
const UNKNOWN = { key: 'unknown', label: '学期未知', short: '未知', rank: 0 }

/**
 * 综合判断：优先课程开始时间，其次课程名里的学期字样
 * @param {{startMs?:number, name?:string}} course
 */
function ofCourse(course) {
  const c = course || {}
  return of(c.startMs) || fromName(c.name) || UNKNOWN
}

/** 学期 key 的展示文案（'2026-2027-秋' → '2026 秋'） */
function shortOf(key) {
  const k = String(key || '')
  if (k === 'unknown') return '未知'
  const m = k.match(/^(20\d{2})-(20\d{2})-(秋|春)$/)
  if (!m) return '未知'
  return (m[3] === '秋' ? m[1] : m[2]) + ' ' + m[3]
}

module.exports = { of, current, fromName, ofCourse, shortOf, UNKNOWN, fall, spring }
