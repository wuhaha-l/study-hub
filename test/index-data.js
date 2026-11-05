/**
 * 首页数据管线测试（离线，stub 掉 wx / getApp / Page）
 *   node test/index-data.js
 *
 * 只测 JS 那一侧：applyData → 平台概览 / 筛选芯片 / 分组 / 统计。
 * 真机上「任务列表整块不显示」那次是 WXML 条件链被注释打断（见 test/wxml-chain.js），
 * 这个文件负责保证「数据是齐的」——两边分开守，出问题时好定位是哪一层。
 */
const store = {}
const noop = () => {}

global.wx = {
  getStorageSync: (k) => store[k],
  setStorageSync: (k, v) => {
    store[k] = v
  },
  removeStorageSync: (k) => {
    delete store[k]
  },
  setNavigationBarColor: noop,
  setBackgroundColor: noop,
  setBackgroundTextStyle: noop,
  vibrateShort: noop,
  showToast: noop,
  showModal: noop,
  getWindowInfo: () => ({ statusBarHeight: 20, windowWidth: 375, screenHeight: 812 }),
  getSystemInfoSync: () => ({ statusBarHeight: 20, windowWidth: 375, screenHeight: 812 }),
  getMenuButtonBoundingClientRect: () => ({ top: 24, height: 32, width: 87 }),
  cloud: { callFunction: () => Promise.reject(new Error('offline')) }
}
global.getApp = () => ({ globalData: { currentTasks: [] } })
global.Page = (o) => {
  global.__page = o
}

const SEM = require('../miniprogram/utils/semester')
const nowSem = SEM.current()
const now = Date.now()
const H = 3600000

function mk(i, over) {
  return Object.assign(
    {
      _id: 't' + i,
      platform: 'chaoxing',
      courseName: '大英3-新一代大学英语',
      title: '任务 ' + i,
      status: 'todo',
      taskType: 'work',
      deadline: now + 2 * 24 * H,
      semesterKey: nowSem.key
    },
    over
  )
}

const tasks = [
  mk(1, { deadline: now - 3 * H }), // 已过期
  mk(2, { deadline: now + 3 * H }), // 今天
  mk(3, { courseName: '大英3-新文理科', deadline: now + 5 * 24 * H }),
  mk(4, { platform: 'educoder', courseName: '数据结构', deadline: now + 6 * 24 * H })
]
for (let i = 5; i < 20; i++) {
  tasks.push(
    mk(i, { platform: 'unipus', courseName: '大学英语视听说', taskType: 'chapter', deadline: 0 })
  )
}

require('../miniprogram/pages/index/index.js')
const page = Object.assign({}, global.__page)
page.data = JSON.parse(JSON.stringify(page.data || {}))
page.setData = function (patch, cb) {
  Object.assign(this.data, patch)
  if (cb) cb()
}

let pass = 0
let fail = 0
function eq(name, got, want) {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  if (a === b) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + '\n    期望: ' + b + '\n    实际: ' + a)
  }
}

const dash = {
  role: 'school',
  accounts: [
    { platform: 'chaoxing', mode: 'cloud', status: 'ok', lastSyncAt: now },
    { platform: 'educoder', mode: 'intranet', status: 'ok', lastSyncAt: now },
    { platform: 'unipus', mode: 'cloud', status: 'ok', lastSyncAt: now }
  ],
  tasks,
  reminder: { remaining: 3, enabled: true },
  srvVer: '20261028.1'
}

console.log('\n[加载完就有账号 → 主列表要出来]')
page.applyData(dash)
eq('hasAccount 为真', page.data.hasAccount, true)
eq('统计到 19 条待办', page.data.stats.todo, 19)
eq('平台概览 3 行', page.data.platforms.length, 3)
eq('平台分段带计数', page.data.filters.map((f) => f.count), [19, 3, 1, 15])
eq(
  '课程芯片：全部课程在最前，计数等于待办数',
  page.data.courseChips[0],
  { key: 'all', name: '全部课程', count: 19 }
)

const keys = (page.data.groups || []).map((g) => g.key)
eq('分组键齐（过期 / 今天 / 一周内 / 章节）', keys, ['expired', 'today', 'week', 'chapter'])
eq(
  '每组条数',
  (page.data.groups || []).map((g) => g.key + ':' + g.count),
  ['expired:1', 'today:1', 'week:2', 'chapter:15']
)
eq('章节组默认收起（不给 items，但计数还在）', page.data.groups[3].items.length, 0)
eq(
  '空态判断用 groups.length，非空时不显示空态',
  page.data.groups.length === 0,
  false
)

console.log('\n[点课程芯片：只留这门课的任务]')
page.onCourseFilter({ currentTarget: { dataset: { key: '大英3-新一代大学英语' } } })
eq('courseFilter 切过去', page.data.courseFilter, '大英3-新一代大学英语')
eq(
  '只剩这门课的两组',
  (page.data.groups || []).map((g) => g.key + ':' + g.count),
  ['expired:1', 'today:1']
)

page.onCourseFilter({ currentTarget: { dataset: { key: 'all' } } })
eq('点回全部课程 → 四组回来', (page.data.groups || []).length, 4)

console.log('\n[点平台分段：芯片和分组一起收窄]')
page.onFilter({ currentTarget: { dataset: { key: 'unipus' } } })
eq(
  '只剩 U校园的章节组',
  (page.data.groups || []).map((g) => g.key + ':' + g.count),
  ['chapter:15']
)
eq('顶部大数字是全局的，不随平台筛选变', page.data.stats.todo, 19)
eq(
  '筛完只剩一门课 → 课程芯片整行不显示（没有可筛的）',
  page.data.courseChips.map((c) => c.key),
  []
)
page.onFilter({ currentTarget: { dataset: { key: 'all' } } })
eq('切回全部 → 四组回来', (page.data.groups || []).length, 4)

console.log('\n[全空：没有任何任务时给出空态]')
page.applyData(Object.assign({}, dash, { tasks: [] }))
eq('groups 为空 → 空态会显示', page.data.groups.length, 0)
eq('有账号但没任务，也不该退回「去绑定」引导', page.data.hasAccount, true)

console.log('\n[同一份作业被抓成两条：合并成已完成]')
{
  /*
   * 超星把同一个作业在「未交」「已交」两个区块各渲染一次，workId 还不同，
   * 于是库里并存一条待做 + 一条待批阅。用户交了作业，首页还挂着一条要交。
   * 这里守的是页面这层兜底：不管云端有没有合，列表里只能看见一条。
   */
  const dup = [
    mk(101, { title: '实验报告3 C语言程序的机器表示', status: 'todo', deadline: now + 24 * H }),
    mk(102, { title: '实验报告3 C语言程序的机器表示', status: 'done', deadline: now + 24 * H })
  ]
  page.applyData(Object.assign({}, dash, { tasks: dup }))
  eq('只留 1 条', page._rawTasks.length, 1)
  eq('留下的是已完成那条', page._rawTasks[0].status, 'done')
  eq('待做 0 件（不会再挂着一条已交的作业）', page.data.stats.todo, 0)
  eq('已完成 1 件', page.data.stats.done, 1)
}

console.log('\n[同名、一盘交了：截止时间对不上也照样合]')
{
  /*
   * 上一版就是在这里漏的：两个区块渲染出的截止时间差了好几天
   * （已交区那行有时把「提交时间」当截止时间读），按时间窗口合不上，
   * 首页于是永远挂着一条已交作业。
   */
  const two = [
    mk(121, { title: '小测 1', status: 'todo', deadline: now + 24 * H }),
    mk(122, { title: '小测 1', status: 'done', deadline: now + 10 * 24 * H })
  ]
  page.applyData(Object.assign({}, dash, { tasks: two }))
  eq('合成 1 条', page._rawTasks.length, 1)
  eq('留下已完成那条', page._rawTasks[0].status, 'done')
}

console.log('\n[三条分身：两待做 + 一已完成 → 只留已完成]')
{
  const three = [
    mk(131, { title: '实验报告3 C语言程序的机器表示', status: 'todo', deadline: now + 24 * H }),
    mk(132, { title: '实验报告3 C语言程序的机器表示', status: 'todo', deadline: now + 30 * 24 * H }),
    mk(133, { title: '实验报告3 C语言程序的机器表示', status: 'done', deadline: 0 })
  ]
  page.applyData(Object.assign({}, dash, { tasks: three }))
  eq('只留 1 条', page._rawTasks.length, 1)
  eq('待做清零', page.data.stats.todo, 0)
  eq('页脚写出合并条数', page.data.mergeNote, '已合并 2 条重复记录')
}

console.log('\n[同名都未完成、截止差得远：那是两份作业，不许合]')
{
  const two = [
    mk(111, { title: '小测 1', status: 'todo', deadline: now + 24 * H }),
    mk(112, { title: '小测 1', status: 'todo', deadline: now + 72 * H })
  ]
  page.applyData(Object.assign({}, dash, { tasks: two }))
  eq('两条都在', page._rawTasks.length, 2)
  eq('都是待做', page.data.stats.todo, 2)
  eq('没合并 → 不显示页脚提示', page.data.mergeNote, '')
}

console.log('\n' + (fail ? '✗ ' + fail + ' 处失败' : '✓ 全通过') + '（' + pass + ' 项）')
process.exit(fail ? 1 : 0)
