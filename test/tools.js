/**
 * 记事本 + 专注（番茄钟）的本地自检
 *
 * 这两个功能全部跑在本机存储上，所以不需要联网、不需要云环境：
 * 装一个内存版 wx.setStorageSync，把逻辑层跑一遍即可。
 *
 * 重点盯三件容易出错的事：
 *   1. 便签的「标题兜底」和「置顶排序」——列表全靠这两个字段
 *   2. 计时器的暂停/继续——靠 endAt 时间戳而不是累加，切后台回来才对得上
 *   3. 跨天的统计——昨天的番茄不能算进今天
 */
const path = require('path')

const ROOT = path.join(__dirname, '..')

/* ------------------------------------------------------------------ */
/* 内存版 wx 存储                                                      */
/* ------------------------------------------------------------------ */
const store = {}
global.wx = {
  getStorageSync(k) {
    return Object.prototype.hasOwnProperty.call(store, k) ? JSON.parse(JSON.stringify(store[k])) : ''
  },
  setStorageSync(k, v) {
    store[k] = JSON.parse(JSON.stringify(v))
  },
  removeStorageSync(k) {
    delete store[k]
  }
}

const N = require(path.join(ROOT, 'miniprogram', 'utils', 'notes'))
const T = require(path.join(ROOT, 'miniprogram', 'utils', 'tomato'))

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''))
  }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected })
}

/* ================================================================== */
/* 一、记事本                                                          */
/* ================================================================== */
console.log('\n【便签：增删改查】')
{
  N.clear()
  eq('空库读取为空数组', N.list(), [])

  const a = N.save({ title: '高数第三章', body: '极限的定义\n夹逼定理' })
  ok('新增拿到 id', !!a.id)
  eq('默认底色', a.color, 'plain')
  eq('默认不置顶', a.pinned, false)
  ok('创建时间已写入', a.createdAt > 0)
  eq('库里 1 条', N.list().length, 1)

  const b = N.save({ title: '买东西', body: '牛奶、面包' })
  eq('库里 2 条', N.list().length, 2)
  eq('最新修改的排最前', N.list()[0].title, '买东西')

  // 更新：createdAt 要保住，updatedAt 要变新
  const a2 = N.save({ id: a.id, title: '高数第三章（改）', body: '极限的定义' })
  eq('更新后标题变了', a2.title, '高数第三章（改）')
  eq('创建时间没变', a2.createdAt, a.createdAt)
  ok('修改时间变新了', a2.updatedAt >= a.updatedAt)
  eq('更新不会多出一条', N.list().length, 2)
  eq('刚改过的排最前', N.list()[0].id, a.id)

  eq('按 id 取', N.get(a.id).title, '高数第三章（改）')
  eq('取不存在的返回 null', N.get('nope'), null)

  // 只传部分字段时，没传的沿用原值
  const a3 = N.save({ id: a.id, title: '只改标题' })
  eq('省略 body 时保留原正文', a3.body, '极限的定义')
  eq('省略 color 时保留原底色', a3.color, 'plain')

  N.remove(b.id)
  eq('删掉 1 条剩 1 条', N.list().length, 1)
  eq('删的是对的那条', N.list()[0].id, a.id)
}

console.log('\n【便签：置顶排序】')
{
  N.clear()
  const x = N.save({ title: '甲', body: '' })
  const y = N.save({ title: '乙', body: '' })
  const z = N.save({ title: '丙', body: '' })

  eq('默认按最后修改倒序', N.list().map((n) => n.title), ['丙', '乙', '甲'])
  N.togglePin(x.id)
  eq('置顶后排最前', N.list().map((n) => n.title), ['甲', '丙', '乙'])
  N.togglePin(y.id)
  eq('两条置顶内部仍按时间倒序', N.list().map((n) => n.title), ['乙', '甲', '丙'])
  N.togglePin(x.id)
  eq('取消置顶回到时间序', N.list().map((n) => n.title), ['乙', '丙', '甲'])
  ok('置顶数量', N.stats().pinned === 1, N.stats())
}

console.log('\n【便签：标题兜底 + 摘要】')
{
  eq('有标题就用标题', N.titleOf({ title: '标题', body: '正文' }), '标题')
  eq('没标题取正文首行', N.titleOf({ title: '   ', body: '第一行\n第二行' }), '第一行')
  eq('全空算空便签', N.titleOf({ title: '', body: '   \n  ' }), '空便签')

  eq(
    '有标题时摘要用正文全部',
    N.digestOf({ title: '标题', body: '正文一句话' }),
    '正文一句话'
  )
  eq(
    '没标题时摘要跳过首行',
    N.digestOf({ title: '', body: '第一行\n第二行内容' }),
    '第二行内容'
  )
  const long = N.digestOf({ title: 't', body: 'x'.repeat(100) }, 10)
  eq('超长摘要截断加省略号', long, 'xxxxxxxxxx…')
  eq('换行压成空格', N.digestOf({ title: 't', body: 'a\nb\r\nc' }), 'a b c')
}

console.log('\n【便签：字数 / 搜索 / 时间】')
{
  eq('字数不含空格换行', N.lengthOf({ title: 'ab', body: 'c d\ne' }), 5)

  const n1 = { title: '高数笔记', body: '夹逼定理' }
  const n2 = { title: 'English Notes', body: 'Limit' }
  ok('命中标题', N.match(n1, '高数'))
  ok('命中正文', N.match(n1, '夹逼'))
  ok('搜索不区分大小写', N.match(n2, 'english'))
  ok('没命中', !N.match(n1, '物理'))
  ok('空关键词算全命中', N.match(n1, '  '))

  N.clear()
  N.save({ title: '含有夹逼的笔记', body: '' })
  N.save({ title: '无关', body: '' })
  eq('search 过滤条数', N.search('夹逼').length, 1)

  const now = new Date(2026, 9, 26, 15, 0).getTime()
  const at = (d, h, m) => new Date(2026, 9, d, h, m).getTime()
  eq('今天', N.timeLabel(at(26, 9, 5), now), '今天 09:05')
  eq('昨天', N.timeLabel(at(25, 22, 0), now), '昨天')
  eq('前天', N.timeLabel(at(24, 8, 0), now), '前天')
  eq('同年更早', N.timeLabel(new Date(2026, 2, 8).getTime(), now), '3月8日')
  eq('跨年', N.timeLabel(new Date(2025, 11, 31).getTime(), now), '2025年12月31日')
  eq('没有时间戳返回空', N.timeLabel(0, now), '')
}

console.log('\n【便签：脏数据兜底】')
{
  const n = N.normalize({ title: 123, body: null, color: '不存在的颜色', pinned: 'yes' })
  eq('标题转字符串', n.title, '123')
  eq('空正文补空串', n.body, '')
  eq('非法底色回落到默认', n.color, 'plain')
  eq('pinned 只认 true', n.pinned, false)
  ok('缺 id 时补一个', !!n.id)

  store.notes_v1 = '不是数组'
  eq('存储被写坏时当空库', N.list(), [])
  store.notes_v1 = [{ title: '坏数据但能救' }]
  eq('能救回一条', N.list().length, 1)
}

/* ================================================================== */
/* 二、专注（番茄钟）                                                  */
/* ================================================================== */
console.log('\n【专注：设置】')
{
  eq('默认专注 25 分钟', T.getSettings().focus, 25)
  eq('默认休息 5 分钟', T.getSettings().break, 5)
  eq('默认目标 8 个', T.getSettings().goal, 8)

  eq('超范围被夹到上限', T.saveSettings({ focus: 999 }).focus, 180)
  eq('超范围被夹到下限', T.saveSettings({ focus: 0 }).focus, 1)
  eq('非数字回落到默认', T.saveSettings({ break: 'abc' }).break, 5)
  eq('小数四舍五入', T.saveSettings({ goal: 6.6 }).goal, 7)
  eq('设置持久化', T.getSettings().focus, 1)
  eq('休息上限 90', T.saveSettings({ break: 500 }).break, 90)
  eq('任意值都存得住（37 分钟）', T.saveSettings({ focus: 37 }).focus, 37)
  T.saveSettings({ focus: 25, break: 5, goal: 8, autoNext: false })
  eq('改回默认', T.getSettings().focus, 25)
  eq('autoNext 只认 true', T.saveSettings({ autoNext: 'yes' }).autoNext, false)
}

console.log('\n【专注：时长自定义】')
{
  eq('纯数字', T.parseMinutes('45'), 45)
  eq('带「分钟」', T.parseMinutes('45分钟'), 45)
  eq('带「分」', T.parseMinutes('20 分'), 20)
  eq('一小时内小数点', T.parseMinutes('12.5'), 13)
  eq('「小时」换算成分钟', T.parseMinutes('1小时'), 60)
  eq('「h」也认', T.parseMinutes('2h'), 120)
  eq('一小时半', T.parseMinutes('1.5小时'), 90)
  eq('空格无所谓', T.parseMinutes('  30  '), 30)
  eq('0 不算', T.parseMinutes('0'), null)
  eq('负数不算', T.parseMinutes('-5'), null)
  eq('乱写不算', T.parseMinutes('abc'), null)
  eq('空串不算', T.parseMinutes(''), null)
  eq('非字符串也不崩', T.parseMinutes(null), null)
  eq('专注超 180 被夹住', T.parseMinutes('999'), 180)
  eq('休息按自己的上限夹', T.parseMinutes('999', 'break'), 90)
  eq('专注范围', T.rangeOf('focus').max, 180)
  eq('休息范围', T.rangeOf('break').max, 90)
  eq('范围查不存在的模式按专注算', T.rangeOf('xx').min, 1)
  eq('自定义时长直接开跑', T.startRun({ mode: 'focus', minutes: 37, now: 1750000000000 }).totalMs, 37 * 60000)
  eq('休息也能自定义', T.startRun({ mode: 'break', minutes: 12, now: 1750000000000 }).totalMs, 12 * 60000)
  T.saveSettings({ focus: 25, break: 5, goal: 8, autoNext: false })
}

console.log('\n【专注：待办】')
{
  store.tomato_tasks_v1 = []
  eq('空列表', T.getTasks(), [])

  const a = T.addTask('复习高数')
  ok('新增拿到 id', !!a.id)
  eq('空标题不创建', T.addTask('   '), null)
  const b = T.addTask('写实验报告')
  eq('两条待办', T.getTasks().length, 2)
  eq('新加的在上面', T.getTasks()[0].title, '写实验报告')

  const done = T.toggleTask(a.id)
  eq('打勾变完成', done.done, true)
  ok('记录完成时间', done.doneAt > 0)
  eq('完成的沉到底部', T.getTasks()[T.getTasks().length - 1].id, a.id)
  const undone = T.toggleTask(a.id)
  eq('再点一下取消完成', undone.done, false)
  eq('取消后清零完成时间', undone.doneAt, 0)

  T.bumpTaskPomo(b.id)
  T.bumpTaskPomo(b.id)
  const bumped = T.getTasks().find((t) => t.id === b.id)
  eq('番茄数累加', bumped.pomos, 2)
  eq('给不存在的待办加番茄不报错', T.bumpTaskPomo('nope'), null)

  T.removeTask(b.id)
  eq('删掉一条', T.getTasks().length, 1)
}

console.log('\n【专注：计时器状态机】')
{
  const t0 = 1750000000000
  const run = T.startRun({ mode: 'focus', minutes: 25, taskTitle: '复习高数', now: t0 })

  eq('总时长', run.totalMs, 25 * 60000)
  eq('结束时刻', run.endAt, t0 + 25 * 60000)
  eq('一开始就在跑', run.running, true)
  eq('剩余等于总时长', T.remainOf(run, t0), 25 * 60000)
  eq('刚开始进度为 0', T.progressOf(run, t0), 0)
  eq('刚开始没结束', T.isFinished(run, t0), false)

  const half = t0 + 12.5 * 60000
  eq('过一半剩一半', T.remainOf(run, half), 12.5 * 60000)
  eq('进度到一半', T.progressOf(run, half), 0.5)

  // 暂停：把剩余时间固化下来，endAt 清掉
  const paused = T.pauseRun(run, half)
  eq('暂停后不在跑', paused.running, false)
  eq('暂停后剩余被固化', paused.remainMs, 12.5 * 60000)
  eq('暂停后清掉 endAt', paused.endAt, 0)
  eq('记了一次暂停', paused.pauses, 1)

  // 暂停期间时间流逝不影响剩余 —— 这是「切后台回来还准」的关键
  eq('暂停 1 小时后剩余不变', T.remainOf(paused, half + 3600000), 12.5 * 60000)

  // 继续：用剩余时间重算 endAt
  const t1 = half + 3600000
  const resumed = T.resumeRun(paused, t1)
  eq('继续后重新开始跑', resumed.running, true)
  eq('继续后剩余不变', T.remainOf(resumed, t1), 12.5 * 60000)
  eq('继续后 endAt 按剩余重算', resumed.endAt, t1 + 12.5 * 60000)
  eq('继续后进度没跳变', T.progressOf(resumed, t1), 0.5)

  // 跑完
  const end = t1 + 12.5 * 60000
  eq('到点剩余为 0', T.remainOf(resumed, end), 0)
  eq('到点算结束', T.isFinished(resumed, end), true)
  eq('进度满 1', T.progressOf(resumed, end), 1)
  eq('超时后剩余不会变负数', T.remainOf(resumed, end + 99999), 0)

  eq('休息模式也走同一套', T.startRun({ mode: 'break', minutes: 5, now: t0 }).totalMs, 5 * 60000)
  eq('时长非法时夹到下限', T.startRun({ mode: 'focus', minutes: 0, now: t0 }).totalMs, 60000)
  eq('时长非法时夹到上限', T.startRun({ mode: 'focus', minutes: 999, now: t0 }).totalMs, 180 * 60000)

  eq('00:00 格式化', T.fmtClock(0), '00:00')
  eq('09:05 格式化', T.fmtClock(545000), '09:05')
  eq('25:00 格式化', T.fmtClock(1500000), '25:00')
  eq('负数也不出错', T.fmtClock(-1000), '00:00')
}

console.log('\n【专注：进度落盘/恢复】')
{
  const t0 = 1750000000000
  const run = T.startRun({ mode: 'focus', minutes: 25, now: t0 })

  T.saveRun(run)
  const back = T.loadRun()
  ok('能从本机读回来', !!back)
  eq('读回来模式一致', back.mode, 'focus')
  eq('读回来结束时刻一致', back.endAt, run.endAt)
  eq('读回来剩余算得对', T.remainOf(back, t0 + 5 * 60000), 20 * 60000)

  T.clearRun()
  eq('清掉后读不到', T.loadRun(), null)

  store.tomato_run_v1 = '坏数据'
  eq('坏数据当没有', T.loadRun(), null)
  store.tomato_run_v1 = { mode: 'focus' } // 缺 totalMs
  eq('缺字段当没有', T.loadRun(), null)
  T.clearRun()
}

console.log('\n【专注：统计】')
{
  const now = new Date(2026, 9, 26, 16, 0).getTime() // 2026-10-26 周一
  const at = (d, h) => new Date(2026, 9, d, h, 0, 0).getTime()

  const sessions = [
    // 今天 3 个番茄
    { mode: 'focus', minutes: 25, at: at(26, 9) },
    { mode: 'focus', minutes: 25, at: at(26, 10) },
    { mode: 'focus', minutes: 45, at: at(26, 14) },
    // 昨天 2 个
    { mode: 'focus', minutes: 25, at: at(25, 20) },
    { mode: 'focus', minutes: 25, at: at(25, 21) },
    // 前天 1 个
    { mode: 'focus', minutes: 30, at: at(24, 15) },
    // 断了一天，再往前有
    { mode: 'focus', minutes: 25, at: at(22, 15) },
    // 休息不算番茄
    { mode: 'break', minutes: 5, at: at(26, 11) }
  ]

  const st = T.stats(sessions, now)
  eq('今日番茄只算 focus', st.today, 3)
  eq('今日分钟', st.todayMin, 95)
  eq('今日休息分钟', st.todayRest, 5)
  eq('本周休息分钟', st.weekRest, 5)
  // 2026-10-26 是周一 → 本周只有今天这 3 个
  eq('本周番茄（周一起算）', st.week, 3)
  eq('连续天数', st.streak, 3)
  eq('目标带出来', st.goal, 8)
  eq('目标完成度', st.goalPct, 38)

  // 一周的起点是周一：周日本身算「上一周的最后一天」
  eq('周一的本周起点就是当天', T.startOfWeek(at(26, 16)), new Date(2026, 9, 26).getTime())
  eq('周日的本周起点回到上周一', T.startOfWeek(at(25, 23)), new Date(2026, 9, 19).getTime())

  // 今天还没开始专注时，连续天数从昨天往前数
  const st2 = T.stats(sessions, at(27, 8))
  eq('今天还没练时从昨天数', st2.streak, 3)
  eq('今天 0 个', st2.today, 0)
  eq('目标完成度 0', st2.goalPct, 0)

  // 全都完成目标
  const full = []
  for (let i = 0; i < 8; i++) full.push({ mode: 'focus', minutes: 25, at: at(26, 8) })
  eq('达标时 100%', T.stats(full, now).goalPct, 100)
  // 超额也不超过 100
  for (let i = 0; i < 5; i++) full.push({ mode: 'focus', minutes: 25, at: at(26, 9) })
  eq('超额封顶 100%', T.stats(full, now).goalPct, 100)

  eq('空记录也算得出来', T.stats([], now).today, 0)
  eq('空记录连续 0 天', T.stats([], now).streak, 0)
}

console.log('\n【专注：写入记录】')
{
  store.tomato_sessions_v1 = []
  T.addSession({ mode: 'focus', minutes: 25, taskId: 't1', at: 1750000000000 })
  const all = T.getSessions()
  eq('记下 1 条', all.length, 1)
  eq('带任务 id', all[0].taskId, 't1')
  eq('分钟数', all[0].minutes, 25)
  eq('新记录在最前', T.getSessions()[0].id, all[0].id)

  // 只保留最近 500 条，防止本机存储越滚越大
  for (let i = 0; i < 520; i++) {
    T.addSession({ mode: 'focus', minutes: 25, at: 1750000000000 + i })
  }
  eq('最多留 500 条', T.getSessions().length, 500)

  store.tomato_sessions_v1 = '坏数据'
  eq('存储坏了当空', T.getSessions(), [])
}

console.log('\n【专注：一轮完整流程】')
{
  delete store.tomato_days_v1
  store.tomato_sessions_v1 = []
  store.tomato_tasks_v1 = []

  const t0 = new Date(2026, 9, 26, 10, 0).getTime()
  const task = T.addTask('复习高数')

  // 专注 25 分钟走完 → 记 1 个番茄，给待办 +1
  T.addSession({ mode: 'focus', minutes: 25, taskId: task.id, at: t0 + 25 * 60000 })
  T.bumpTaskPomo(task.id)
  // 接着休息 5 分钟走完 → 只记休息
  T.addSession({ mode: 'break', minutes: 5, at: t0 + 30 * 60000 })

  const st = T.stats(T.getSessions(), t0 + 31 * 60000)
  eq('今日 1 个番茄', st.today, 1)
  eq('今日专注 25 分钟', st.todayMin, 25)
  eq('今日休息 5 分钟', st.todayRest, 5)
  eq('待办上的番茄数 +1', T.getTasks().find((x) => x.id === task.id).pomos, 1)

  const rep = T.report(undefined, t0 + 31 * 60000)
  eq('日汇总：学习 25 分钟（1500 秒）', rep.day.study.s, 1500)
  eq('日汇总：休息 5 分钟（300 秒）', rep.day.rest.s, 300)
  eq('月汇总：休息也在', rep.month.rest.s, 300)
  eq('年汇总：两边对得上', [rep.year.study.s, rep.year.rest.s], [1500, 300])

  // 换休息口径看柱状图，今天这根柱子就是 5 分钟
  const bd = T.chart(undefined, 'day', t0 + 31 * 60000, 'rest')
  eq('休息柱今天 5 分钟', bd.bars[6].value, 300)
  eq('休息柱合计 5 分钟', bd.sum, 300)
}

console.log('\n【专注：学习时长统计（日/周/月/年）】')
{
  const now = new Date(2026, 9, 26, 16, 0).getTime() // 2026-10-26 周一
  const at = (d, h) => new Date(2026, 9, d, h || 9, 0, 0).getTime()
  const sessions = [
    { mode: 'focus', minutes: 25, at: at(26, 9) },
    { mode: 'focus', minutes: 45, at: at(26, 14) },
    { mode: 'focus', minutes: 30, at: at(25, 20) }, // 上周日
    { mode: 'focus', minutes: 60, at: at(20, 9) }, // 上周二
    { mode: 'focus', minutes: 90, at: new Date(2026, 7, 3, 9).getTime() }, // 8 月
    { mode: 'break', minutes: 5, at: at(26, 11) } // 休息不算
  ]

  // 全清，从「只有明细」的旧状态起步 —— 顺便验证迁移
  delete store.tomato_days_v1
  store.tomato_sessions_v1 = sessions

  const rep = T.report(sessions, now)
  // 全部按秒算：70 分钟 = 4200 秒，250 分钟 = 15000 秒
  eq('今天 70 分钟', rep.day.study.s, 4200)
  eq('今天 2 个番茄', rep.day.study.n, 2)
  eq('本周只有今天（周一起算）', rep.week.study.s, 4200)
  eq('本月 160 分钟', rep.month.study.s, 9600)
  eq('本月 4 个番茄', rep.month.study.n, 4)
  eq('今年 250 分钟', rep.year.study.s, 15000)
  eq('累计同今年', rep.total.study.s, 15000)
  eq('有专注的天数（4 天）', rep.total.days, 4)
  eq('同一份数据里休息也分了家', rep.day.rest.s, 300)
  eq('休息次数', rep.day.rest.n, 1)
  eq('休息不混进学习时长', rep.total.rest.s, 300)
  eq('学习天数不含只休息的那天', rep.total.studyDays, 4)
  eq('休息天数', rep.total.restDays, 1)

  // 迁移：本机没有汇总表时，从明细现算并补上
  delete store.tomato_days_v1
  const days = T.getDays()
  eq('没汇总表时按明细算出来', T.summarizeDays(days, 0).study.s, 15000)
  ok('顺手把汇总表写回本机', !!store.tomato_days_v1 && Object.keys(store.tomato_days_v1).length === 4, store.tomato_days_v1)
  eq('汇总表里某天就是那天', store.tomato_days_v1[String(new Date(2026, 9, 26).getTime())].study.s, 4200)

  // 新增记录不能把同一天算两遍（先取表再写明细的顺序问题）
  T.addSession({ mode: 'focus', minutes: 30, at: at(26, 15) })
  const rep2 = T.report(undefined, now)
  eq('新加 30 分钟后今天变 100', rep2.day.study.s, 6000)
  eq('累计也跟着涨', rep2.total.study.s, 16800)
  eq('明细条数对得上', T.getSessions().length, 7)
  T.addSession({ mode: 'break', minutes: 5, at: at(26, 16) })
  eq('休息不加时长', T.report(undefined, now).day.study.s, 6000)
  eq('休息单独累加', T.report(undefined, now).day.rest.s, 600)
  eq('休息次数也累加', T.report(undefined, now).day.rest.n, 2)
  eq('汇总表里有 rest 一块', store.tomato_days_v1[String(new Date(2026, 9, 26).getTime())].rest.s, 600)

  // 老版本汇总表只有 min/pomos：读的时候要用明细把休息补回来
  store.tomato_days_v1 = {}
  store.tomato_days_v1[String(new Date(2026, 9, 26).getTime())] = { min: 70, pomos: 2 }
  const fixed = T.getDays()
  const fk = String(new Date(2026, 9, 26).getTime())
  eq('老表的学习时长原样保留', fixed[fk].study.s, 4200)
  eq('老表也能补出休息时长', fixed[fk].rest.s, 600)
  eq('补完就写回本机', store.tomato_days_v1[fk].rest.s, 600)

  console.log('\n【专注：柱状图】')
  {
    const d = T.chart(sessions, 'day', now)
    eq('近 7 天就是 7 根柱子', d.bars.length, 7)
    eq('最后一根是今天', d.bars[6].label, '今天', d.bars[6])
    eq('今天被标成当前', d.bars[6].isNow, true)
    eq('第一根是 7 天前', d.bars[0].label, '二') // 10-20 是周二
    eq('10-20 那天 60 分钟', d.bars[0].study, 3600)
    eq('最高的一根 100%', d.bars[6].pct, 100)
    eq('没数据的柱子 0%', d.bars[1].pct, 0)
    ok('有数据的柱子至少有 6% 高度', d.bars[0].pct >= 6)
    eq('区间合计', d.sum, 9600)

    const w = T.chart(sessions, 'week', now)
    eq('近 6 周 6 根', w.bars.length, 6)
    eq('上一周 90 分钟', w.bars[4].study, 5400)
    eq('本周 70 分钟', w.bars[5].study, 4200)
    eq('上一周标记 10/19', w.bars[4].label, '10/19')

    const mo = T.chart(sessions, 'month', now)
    eq('近 6 月 6 根', mo.bars.length, 6)
    eq('8 月 90 分钟', mo.bars[3].study, 5400)
    eq('10 月 160 分钟', mo.bars[5].study, 9600)
    eq('月份标签', mo.bars[5].label, '10月')

    const y = T.chart(sessions, 'year', now)
    eq('近 4 年 4 根', y.bars.length, 4)
    eq('今年 250 分钟', y.bars[3].study, 15000)
    eq('去年 0', y.bars[2].study, 0)
    eq('年份标签', y.bars[3].label, '2026')

    eq('未知粒度退回近 7 天', T.chart(sessions, 'xx', now).bars.length, 7)
    eq('空数据也不会崩', T.chart([], 'month', now).bars.length, 6)
    ok('空数据没有满格柱子', T.chart([], 'month', now).max === 0)

    // 换个口径：同一根柱子看休息（新口径全部按秒）
    const bd = T.chart(sessions, 'day', now, 'rest')
    eq('休息视图也有 7 根', bd.bars.length, 7)
    eq('休息视图口径', bd.metric, 'rest')
    eq('今天休息 5 分钟 = 300 秒', bd.bars[6].rest, 300)
    eq('柱高按休息算', bd.bars[6].value, 300)
    eq('休息柱顶文案', bd.bars[6].txt, '5分')
    eq('休息合计', bd.sum, 300)
    eq('柱子仍带着学习秒数', bd.bars[6].study, 4200)
    eq('学习视图合计不含休息', d.sum, 9600)
    eq('没传口径就是学习', T.chart(sessions, 'day', now).metric, 'study')

    // 生活口径：这次数据里没有生活标签，柱子应该全是 0，但不能崩
    const ld = T.chart(sessions, 'day', now, 'life')
    eq('生活视图口径', ld.metric, 'life')
    eq('没有生活记录时合计为 0', ld.sum, 0)
    eq('空视图柱子也没有高度', ld.bars[6].value, 0)
  }

  console.log('\n【专注：时长文案】')
  eq('0 分', T.fmtDur(0), '0 分')
  eq('45 分', T.fmtDur(45), '45 分')
  eq('整点只说小时', T.fmtDur(120), '2 小时')
  eq('带零头', T.fmtDur(155), '2 小时 35 分')
  eq('柱顶 0 不显示', T.fmtDurShort(0), '')
  eq('柱顶不足一小时按分', T.fmtDurShort(45), '45分')
  eq('柱顶一位小数', T.fmtDurShort(210), '3.5h')
  eq('柱顶整数去掉小数点', T.fmtDurShort(120), '2h')
  eq('柱顶大数取整', T.fmtDurShort(780), '13h')
}

console.log('\n----------------------------------------')
console.log(`通过 ${pass}  失败 ${fail}`)
process.exit(fail ? 1 : 0)
