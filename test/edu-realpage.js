/**
 * 真机页面复现：在线作业页「左边清单 + 右边当前作业的作业时间」。
 *
 * 2026-10-27 的真机轨迹（用户「复制详情」发回来的）：
 *
 *   补充 切到「离散数学」后的在线作业：作业行 10 条 / 带截止时间 0
 *     首行：只有锚 206 字，在 tr 内：否，全页日期痕迹 2 处
 *     锚原文：<a href="index.jsp?courseID=40&assignID=861" class="…active"> 序偶和关系 - 2026-2027(1) </a>
 *     日期出现在：…<h4> 序偶和关系 - 2026-2027(1)</h4>
 *                <p> 作业时间：<b>2026-10-26 20:00:00</b> 至 <b>2026-11-07 23:59:00</b> </p>
 *
 * 也就是说：日期**就在这一页上**，只是渲染在右栏、挂在 <h4> 标题下，
 * 而解析行的时候只看锚（或锚所在的那一行），永远看不到右栏。
 *
 * 这个测试用真机的页面结构钉住三件事：
 *   1. 页面级绑定：右栏那一段绑回左边对应的那条（861 → 2026-11-07 23:59）
 *   2. 绝不平摊：同页另外 9 条保持 0（平台确实没渲染它们的时间）
 *   3. 补日期优先复用扫描已经抓下来的页面：3 门课不该再打 3 次同一个 session 页
 *
 * 运行：node test/edu-realpage.js
 */
const path = require('path')
const ROOT = path.join(__dirname, '..')

const store = {}
const requests = []

const PAD = '<!-- ' + 'x'.repeat(300) + ' -->'

// 真机：任何 index.jsp / main.jsp 都只回这个外壳（20852 字节，只有一个 iframe）
const SHELL = `<!DOCTYPE html><html><head><title>计算机类课程一体化平台</title></head><body>
<form name="top" action="/main.jsp" method="post" target="mainFrame"><input type="hidden" name="tab" value="1" /></form>
<iframe name="mainFrame" src=""></iframe>
<div class="nav">首页 课程信息 在线作业 在线考试 在线答疑 模型</div>
${PAD}</body></html>`

/** 左栏清单 + 右栏「当前作业」的作业时间 —— 真机结构 */
function listPage(courseId, items, current) {
  const cur = items.filter((x) => x.current)
  const hist = items.filter((x) => !x.current)
  const line = (x) =>
    `<a href="index.jsp?courseID=${courseId}&assignID=${x.id}" class="list-group-item list-group-item-action${
      String(current) === String(x.id) ? ' active' : ''
    }${x.current ? '' : ' list-group-item-primary'}"> ${x.title} </a>`
  const shown = items.filter((x) => String(x.id) === String(current))[0]
  return `<!DOCTYPE html><html><head><title>在线作业</title></head><body>
<div class="col-2 mr-2-box">
  <span class="text-muted"><strong> <i class="fas fa-clock"></i> 当前作业</strong></span>
  <div class="list-group list-group-flush mb-4">
    ${cur.map(line).join('\n    ')}
  </div>
  <span class="text-muted"><strong> <i class="fas fa-history"></i> 历史作业</strong></span>
  <div class="list-group list-group-flush">
    ${hist.map(line).join('\n    ')}
  </div>
</div>
<div class="col">
${
  shown
    ? `  <h4> ${shown.title}</h4>
  <p> 作业时间：<b>${shown.from}</b> 至 <b>${shown.to}</b> </p>
  <table><tr><td>100.00</td><td>初次提交时间: 2026-10-27 11:08:40&nbsp;&nbsp;&nbsp;最近一次提交时间: 2026-10-27 16:20:00</td></tr></table>`
    : '  <h4> 作业列表</h4>'
}
</div>
${PAD}</body></html>`
}

// 离散数学：当前作业 861 / 858，其余 8 条历史作业；真机只渲染 861 的时间
const MATH = [
  { id: 861, title: '序偶和关系 - 2026-2027(1)', current: true, from: '2026-10-26 20:00:00', to: '2026-11-07 23:59:00' },
  { id: 858, title: '集合的概念 - 2026-2027(1)', current: true, from: '2026-11-08 08:00:00', to: '2026-11-20 23:59:00' },
  { id: 857, title: '命题逻辑 - 2026-2027(1)', current: false },
  { id: 856, title: '谓词逻辑 - 2026-2027(1)', current: false },
  { id: 855, title: '集合论基础 - 2026-2027(1)', current: false },
  { id: 854, title: '关系与函数 - 2026-2027(1)', current: false },
  { id: 853, title: '图论初步 - 2026-2027(1)', current: false },
  { id: 852, title: '树与生成树 - 2026-2027(1)', current: false },
  { id: 851, title: '布尔代数 - 2026-2027(1)', current: false },
  { id: 850, title: '组合计数 - 2026-2027(1)', current: false }
]
const PAGE40 = listPage(40, MATH, '861')

// 高级语言程序设计：唯一那条在历史作业区，但它就是右栏显示的那条
const PAGE115 = listPage(
  115,
  [
    {
      id: 573,
      title: '2025级高级语言程序设计实验报告',
      current: false,
      from: '2026-01-16 20:31:00',
      to: '2026-01-28 15:35:00'
    }
  ],
  '573'
)

const PAGE124 = listPage(
  124,
  [
    {
      id: 802,
      title: '2025级认知实习报告书',
      current: false,
      from: '2026-07-09 10:52:00',
      to: '2026-07-16 18:00:00'
    }
  ],
  '802'
)

global.wx = {
  getStorageSync(k) {
    return Object.prototype.hasOwnProperty.call(store, k) ? JSON.parse(JSON.stringify(store[k])) : ''
  },
  setStorageSync(k, v) {
    store[k] = JSON.parse(JSON.stringify(v))
  },
  removeStorageSync(k) {
    delete store[k]
  },
  request(opt) {
    const full = String(opt.url || '').replace(/^https?:\/\/[^/]+/, '')
    const p = full.split('?')[0]
    requests.push(full)
    const reply = (status, body) => setTimeout(() => opt.success({ statusCode: status, data: body, header: {} }), 0)
    // 真机：地址里的 courseID / assignID 基本被忽略，redirect.jsp?tab=-2 一律是
    // session 里那门课（认知实习 124）
    if (p === '/includes/redirect.jsp' && /tab=-2/.test(full)) return reply(200, PAGE124)
    if (p === '/includes/redirect.jsp') return reply(200, SHELL)
    return reply(200, SHELL)
  }
}

const edu = require(path.join(ROOT, 'miniprogram', 'utils', 'edu'))

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + (extra === undefined ? '' : ' → ' + JSON.stringify(extra)))
  }
}

function ymd(ts) {
  if (!ts) return '0'
  const d = new Date(ts)
  const p2 = (n) => ('0' + n).slice(2 - String(n).length)
  return (
    d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) +
    ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2)
  )
}

function mkTask(c, x) {
  return {
    externalId: 'educoder:assign:' + x.id,
    courseId: String(c.id),
    courseName: c.name,
    title: x.title,
    deadline: 0,
    url: 'http://10.67.4.14/index.jsp?courseID=' + c.id + '&assignID=' + x.id
  }
}

async function main() {
  console.log('[1] 真机这一页：10 条作业，只有 1 段作业时间')
  const rows = edu.assignRows(PAGE40)
  ok('解析出 10 条作业', rows.length === 10, rows.length)
  ok('光解析行的话，一条日期都拿不到（真机就是这么显示的）', rows.every((r) => !r.deadline), rows.map((r) => r.deadline))
  const blocks = edu.rangeBlocks(PAGE40)
  ok('但页面上确实有 1 段作业时间', blocks.length === 1, blocks.length)
  ok('这段挂在「序偶和关系」标题下', /序偶和关系/.test(blocks[0].title), blocks[0].title)

  console.log('\n[2] 页面级绑定：把右栏那一段绑回左边对应的那条')
  edu.bindPageDeadlines(PAGE40, rows)
  const byId = {}
  rows.forEach((r) => {
    byId[r.assignId] = r
  })
  ok('861 绑上了 2026-11-07 23:59', ymd(byId['861'] && byId['861'].deadline) === '2026-11-07 23:59', ymd(byId['861'] && byId['861'].deadline))
  ok('858 没有被塞上 861 的时间（保持 0）', byId['858'].deadline === 0, ymd(byId['858'].deadline))
  ok('历史作业一条都没被污染', rows.filter((r) => r.assignId !== '861' && r.deadline).length === 0, rows.filter((r) => r.deadline).map((r) => r.assignId))

  console.log('\n[3] 补日期：直接复用扫描已抓的页面，不再打 3 次 session 页')
  requests.length = 0
  const c40 = { id: 40, name: '离散数学' }
  const c115 = { id: 115, name: '2025级高级语言程序设计实验（报告提交）' }
  const c124 = { id: 124, name: '认知实习' }
  const tasks = []
    .concat(MATH.map((x) => mkTask(c40, x)))
    .concat([mkTask(c115, { id: 573, title: '2025级高级语言程序设计实验报告' })])
    .concat([mkTask(c124, { id: 802, title: '2025级认知实习报告书' })])
  const trace = []
  const got = await edu.fillDeadlines(tasks, trace, { 40: PAGE40, 115: PAGE115, 124: PAGE124 })
  const d = {}
  tasks.forEach((t) => {
    d[t.externalId.replace('educoder:assign:', '')] = t.deadline
  })
  ok('三门课各补上 1 条（共 3 条）', got === 3, got)
  ok('861 → 2026-11-07 23:59', ymd(d['861']) === '2026-11-07 23:59', ymd(d['861']))
  ok('573 → 2026-01-28 15:35', ymd(d['573']) === '2026-01-28 15:35', ymd(d['573']))
  ok('802 → 2026-07-16 18:00', ymd(d['802']) === '2026-07-16 18:00', ymd(d['802']))
  ok('858 还是 0（平台没渲染它的时间）', d['858'] === 0, ymd(d['858']))
  const line40 = trace.filter((x) => /课程 40：/.test(x))[0] || ''
  ok('轨迹写明「10 条缺日期，绑上 1 条」', /10 条缺日期/.test(line40) && /绑上 1 条/.test(line40), line40)
  ok('轨迹注明是复用扫描已抓的页面', /复用扫描已抓的页面/.test(line40), line40)
  ok('说明这页只渲染 1 条、其余不渲染', /其余不渲染时间/.test(line40), line40)
  ok('没有为三门课多发请求（≤4 次，只用于探路）', requests.filter((u) => /tab=-2/.test(u)).length <= 4, requests)

  console.log('\n[4] 探路一看是同一个页面就收手，不拿 9 条空跑')
  ok('总请求数很少（≤4）', requests.length <= 4, requests)
  ok(
    '轨迹说清了「和已解析过的页面一模一样」',
    /一模一样/.test(trace.join('；')) || /没绑上/.test(trace.join('；')),
    trace.filter((x) => /一模一样|没绑上/.test(x))
  )

  console.log('\n----------------------------------------')
  console.log('通过 ' + pass + '，失败 ' + fail)
  if (fail) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
