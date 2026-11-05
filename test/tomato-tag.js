/**
 * 专注：标签（学习/休息/生活）+ 秒级时长 + 生活关键词统计
 *   node test/tomato-tag.js
 *
 * 全离线：stub 掉 wx 的存储，直接用 addSession / summarizeDays 造数据，
 * 不碰页面层（页面只负责把结果摆到屏幕上）。
 */
const store = {}

global.wx = {
  getStorageSync: (k) => (store[k] === undefined ? '' : store[k]),
  setStorageSync: (k, v) => {
    store[k] = v
  },
  removeStorageSync: (k) => {
    delete store[k]
  },
  getStorageInfoSync: () => ({ keys: Object.keys(store) })
}

const T = require('../miniprogram/utils/tomato')
const SCOPE = require('../miniprogram/utils/scope')

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)))
  }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), got)
}
function clearAll() {
  Object.keys(store).forEach((k) => delete store[k])
}

const NOW = new Date(2026, 9, 27, 10, 0, 0).getTime() // 2026-10-27 10:00
const YDAY = NOW - 86400000

/* ---------------- 标签 ---------------- */
console.log('\n[标签：学习 / 休息 / 生活]')
clearAll()
eq('三个标签，顺序固定', T.TAGS.map((x) => x.t), ['学习', '休息', '生活'])
eq('tagOf 认 life', T.tagOf('life'), 'life')
eq('tagOf 认不了的一律当学习', T.tagOf('乱写'), 'study')
eq('tagLabel', T.tagLabel('life'), '生活')

const t1 = T.addTask('背单词', 'study')
eq('加待办带标签', t1.tag, 'study')
const t2 = T.addTask('健身 30 分钟', 'life')
eq('生活待办', t2.tag, 'life')
const t3 = T.addTask('不选标签', undefined)
eq('不传标签默认学习', t3.tag, 'study')
eq('改标签', T.setTaskTag(t2.id, 'rest').tag, 'rest')
eq('改回生活', T.setTaskTag(t2.id, 'life').tag, 'life')
ok('任务列表里能读到标签文案', T.getTasks().filter((x) => x.id === t2.id)[0].tag === 'life')

// 老数据没有 tag：当成学习，别丢
clearAll()
store[SCOPE.key(T.TASK_KEY)] = [{ id: 'old1', title: '老任务', pomos: 2, done: false, createdAt: NOW }]
eq('老待办没有标签 → 学习', T.getTasks()[0].tag, 'study')
eq('老待办番茄数还在', T.getTasks()[0].pomos, 2)

/* ---------------- 记录：按秒 ---------------- */
console.log('\n[记录：秒级，不再四舍五入到分钟]')
clearAll()
const s1 = T.addSession({ taskId: 'x', title: '健身 30 分钟', tag: 'life', mode: 'focus', sec: 80, at: NOW })
eq('80 秒存住', s1.sec, 80)
eq('minutes 兼容老代码（取整）', s1.minutes, 1)

// 老记录只有 minutes
clearAll()
store[SCOPE.key(T.SES_KEY)] = [{ id: 'a', taskId: '', mode: 'focus', minutes: 3, at: NOW }]
eq('老记录 3 分钟 → 180 秒', T.getSessions()[0].sec, 180)
eq('老记录没标签 → 学习', T.getSessions()[0].tag, 'study')

clearAll()
store[SCOPE.key(T.SES_KEY)] = [{ id: 'b', taskId: '', mode: 'break', minutes: 5, at: NOW }]
eq('老记录是休息模式 → 休息标签', T.getSessions()[0].tag, 'rest')

/* ---------------- 按天汇总 ---------------- */
console.log('\n[按天汇总：三个标签各一格]')
clearAll()
T.addSession({ title: '健身 30 分钟', tag: 'life', mode: 'focus', sec: 80, at: NOW })
T.addSession({ title: '背单词', tag: 'study', mode: 'focus', sec: 600, at: NOW })
T.addSession({ mode: 'break', sec: 300, at: NOW })
const day = T.getDays()[String(T.startOfDay(NOW))]
eq('生活秒数', day.life.s, 80)
eq('生活次数', day.life.n, 1)
eq('学习秒数', day.study.s, 600)
eq('休息秒数', day.rest.s, 300)

const sum = T.summarizeDays(T.getDays(), T.startOfDay(NOW), T.startOfDay(NOW) + 86400000)
eq('区间汇总：生活 80 秒', sum.life.s, 80)
eq('区间汇总：学习 600 秒', sum.study.s, 600)
eq('区间汇总：学习天数 1', sum.studyDays, 1)
eq('区间汇总：生活天数 1', sum.lifeDays, 1)

// 老格式的天表要能读出来，还不能丢
clearAll()
store[SCOPE.key(T.DAY_KEY)] = {
  [String(T.startOfDay(NOW))]: { min: 10, pomos: 2, rest: 5, rests: 1 }
}
const mig = T.getDays()[String(T.startOfDay(NOW))]
eq('老格式 min=10 → 学习 600 秒', mig.study.s, 600)
eq('老格式 pomos=2', mig.study.n, 2)
eq('老格式 rest=5 → 休息 300 秒', mig.rest.s, 300)
eq('老格式 rests=1', mig.rest.n, 1)
eq('读一次就落成新格式', typeof store[SCOPE.key(T.DAY_KEY)][String(T.startOfDay(NOW))].study, 'object')

/* ---------------- 生活关键词 ---------------- */
console.log('\n[生活：按待办关键词分组]')
eq('认「健身房」而不是「健身」', T.lifeKey('去健身房'), '健身房')
eq('认「跑步」', T.lifeKey('跑步 30 分钟'), '跑步')
eq('认「取快递」', T.lifeKey('下楼取快递'), '取快递')
eq('认不出就把标题当关键词', T.lifeKey('遛狗'), '遛狗')
eq('先把「打卡/20 分钟」这类废话剃掉', T.lifeKey('遛狗打卡 20 分钟'), '遛狗')

clearAll()
T.addSession({ title: '健身 30 分钟', tag: 'life', mode: 'focus', sec: 200, at: NOW })
T.addSession({ title: '去健身房', tag: 'life', mode: 'focus', sec: 400, at: YDAY })
T.addSession({ title: '跑步 20 分钟', tag: 'life', mode: 'focus', sec: 1200, at: NOW })
T.addSession({ title: '背单词', tag: 'study', mode: 'focus', sec: 9999, at: NOW })
T.addSession({ mode: 'break', sec: 300, at: NOW })

const kws = T.lifeKeywords(null, 0, NOW + 86400000)
eq('只算生活标签（学习不进榜）', kws.map((x) => x.kw), ['跑步', '健身房', '健身'])
eq('按秒数从多到少', kws.map((x) => x.sec), [1200, 400, 200])
eq('「健身 30 分钟」并到「健身」上（不只算一条）', kws[2].n, 1)
eq('健身房显示成几分几秒', kws[1].txt, '6 分 40 秒')
eq('跑步显示成 20 分', kws[0].txt, '20 分')
eq('第一名的条是满的', kws[0].pct, 100)
eq('第二名按比例 33%', kws[1].pct, 33)

// 同一个关键词的多条要合并（这是「按关键词统计」的意义）
clearAll()
T.addSession({ title: '健身', tag: 'life', mode: 'focus', sec: 600, at: NOW })
T.addSession({ title: '健身 40 分钟', tag: 'life', mode: 'focus', sec: 400, at: YDAY })
const one = T.lifeKeywords(null, 0, NOW + 86400000)
eq('同一个关键词合并成一行', one.length, 1)
eq('合并后 1000 秒', one[0].sec, 1000)
eq('合并后 2 次', one[0].n, 2)

clearAll()
T.addSession({ title: '健身', tag: 'life', mode: 'focus', sec: 80, at: NOW })
eq('80 秒 → 「1 分 20 秒」', T.lifeKeywords(null, 0, NOW + 86400000)[0].txt, '1 分 20 秒')

/* ---------------- 格式化 ---------------- */
console.log('\n[格式化：几分几秒]')
eq('fmtSpan(59)', T.fmtSpan(59), '59 秒')
eq('fmtSpan(80)', T.fmtSpan(80), '1 分 20 秒')
eq('fmtSpan(120)', T.fmtSpan(120), '2 分')
eq('fmtSpan(3600)', T.fmtSpan(3600), '1 小时')
eq('fmtSpan(3900)', T.fmtSpan(3900), '1 小时 5 分')
eq('spanParts(80)', T.spanParts(80), [
  { k: 'm', n: '1', u: '分' },
  { k: 's', n: '20', u: '秒' }
])
eq('spanParts(5400) 不塞零头秒', T.spanParts(5400), [
  { k: 'h', n: '1', u: '小时' },
  { k: 'm', n: '30', u: '分' }
])
eq('spanParts(0)', T.spanParts(0), [{ k: 's', n: '0', u: '秒' }])
eq('fmtSpanShort(40)', T.fmtSpanShort(40), '40秒')
eq('fmtSpanShort(720)', T.fmtSpanShort(720), '12分')
eq('fmtSpanShort(0)', T.fmtSpanShort(0), '')

/* ---------------- 统计 ---------------- */
console.log('\n[统计：生活单独算]')
clearAll()
T.addSession({ title: '跑步', tag: 'life', mode: 'focus', sec: 1200, at: NOW })
T.addSession({ title: '背单词', tag: 'study', mode: 'focus', sec: 1500, at: NOW })
T.addSession({ mode: 'break', sec: 300, at: NOW })
const st = T.stats(null, NOW)
eq('今日番茄 2（生活也算一轮专注）', st.today, 2)
eq('今日专注分钟 45', st.todayMin, 45)
eq('今日生活分钟 20', st.todayLife, 20)
eq('今日休息分钟 5', st.todayRest, 5)

const ch = T.chart(null, 'day', NOW, 'life')
eq('柱状图取生活口径', ch.metric, 'life')
eq('合计按秒', ch.sum, 1200)
eq('今天的柱子有值', ch.bars[ch.bars.length - 1].value, 1200)
eq('柱子文案', ch.bars[ch.bars.length - 1].txt, '20分')
eq('切到学习口径', T.chart(null, 'day', NOW, 'study').sum, 1500)

const rep = T.report(null, NOW)
eq('report 里三块都在', Object.keys(rep.total).sort(), ['days', 'life', 'lifeDays', 'rest', 'restDays', 'study', 'studyDays'])
eq('report.total.life.s', rep.total.life.s, 1200)

/* ---------------- 一轮的开始与结束 ---------------- */
console.log('\n[一轮计时：标签跟着待办走]')
const run = T.startRun({ mode: 'focus', minutes: 25, taskId: 't1', taskTitle: '健身', tag: 'life', now: NOW })
eq('专注轮次带生活标签', run.tag, 'life')
const brk = T.startRun({ mode: 'break', minutes: 5, now: NOW })
eq('休息轮次一律算休息', brk.tag, 'rest')
eq('自定义标签不会串到休息上', T.startRun({ mode: 'break', minutes: 5, tag: 'life', now: NOW }).tag, 'rest')

console.log('\n----------------------------------------')
console.log((fail ? '✗ ' : '✓ ') + '通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail ? 1 : 0)
