/**
 * 课表的本地存取与「教务数据合并」。
 *
 * 为什么单独抽出来：写课表的入口有两个 ——
 *   1. 课表页自己的「教务导入 → 拉取」
 *   2. 登录设置页的「登录并导入课表」（一步走完）
 * 合并规则（教务覆盖同时间位、保留纯手动的课）必须只有一份，
 * 否则两边行为会慢慢跑偏。
 */

const SCOPE = require('./scope.js')
const KEY = 'timetable_v1'
const TERM_KEY = 'timetable_term'

function read() {
  const v = wx.getStorageSync(SCOPE.key(KEY))
  return Array.isArray(v) ? v : []
}

function write(items) {
  wx.setStorageSync(SCOPE.key(KEY), items)
  return items
}

function readTerm() {
  const v = wx.getStorageSync(SCOPE.key(TERM_KEY))
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ''
}

function writeTerm(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) return ''
  wx.setStorageSync(SCOPE.key(TERM_KEY), v)
  return v
}

function sortItems(items) {
  return items.sort((a, b) => a.day - b.day || (a.start || 99) - (b.start || 99))
}

/**
 * 把教务拉到的课并进本机课表。
 *
 * 规则：同一个「周几 + 起节 + 止节」的时间位上，教务是权威 —— 原来手填的课让位；
 * 但「手动改过的格子」（重命名 / 按周拆分等，带 manual 标记）比教务更权威，
 * 教务同时间位的数据不再覆盖它 —— 否则每次重新拉课表，
 * 手工整理好的实验课名字就全被打回「大学物理实验A(Ⅰ)」了。
 *
 * @returns {{added:number, kept:number, total:number, termStart:string, items:Array}}
 */
function mergeJw(r) {
  const slotOf = (x) => [x.day, x.start, x.end].join('|')

  const incoming = ((r && r.items) || [])
    .filter((it) => it && it.day && it.name)
    .map((it) => ({
      id: [it.day, it.start, it.end, it.name].join('|'),
      day: Number(it.day),
      start: Number(it.start) || 1,
      end: Number(it.end) || Number(it.start) || 1,
      name: String(it.name),
      place: it.place || '',
      weeks: it.weeks || null
    }))

  if (!incoming.length) {
    return { added: 0, kept: read().length, total: read().length, termStart: '', items: read() }
  }

  const jwSlots = {}
  incoming.forEach((x) => {
    const k = slotOf(x)
    if (!jwSlots[k]) jwSlots[k] = []
    jwSlots[k].push(x)
  })

  const old = read()
  const manualSlots = {}
  old.forEach((x) => {
    if (x.manual) manualSlots[slotOf(x)] = true
  })
  // 手动格子所在的时间位：教务的让位；其余时间位教务覆盖旧数据
  const kept = old.filter((x) => x.manual || !jwSlots[slotOf(x)])
  const incomingUsed = incoming.filter((x) => !manualSlots[slotOf(x)])
  const merged = sortItems(kept.concat(incomingUsed))
  write(merged)

  // 教务页面上的开学日最准，顺手校准，周次和单双周立刻对得上
  const termStart = (r && r.termStart) || ''
  if (termStart) writeTerm(termStart)

  return { added: incomingUsed.length, kept: kept.length, total: merged.length, termStart, items: merged }
}

module.exports = { KEY, TERM_KEY, read, write, readTerm, writeTerm, mergeJw, sortItems }
