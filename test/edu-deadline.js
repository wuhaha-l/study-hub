/**
 * 希冀「截止时间」解析：列表页 / 属性里 / 详情页三条来源。
 *
 * 真机背景：作业列表页往往不直接给日期，或者只给「12-20 23:59」这种没年份的
 * 写法，解析出来 deadline 全是 0，首页只能显示「无截止」。
 * 这里把三种来源各演一遍：
 *   1. 日期只在 title 属性里（去掉标签后文本里没有）
 *   2. 日期只写了月日（当年）
 *   3. 列表完全没日期 → 同步时逐条打开详情页补
 * 另外钉死「详情页有一堆日期但都不是截止时间」时不许瞎猜。
 *
 * 运行：node test/edu-deadline.js
 */
const path = require('path')
const ROOT = path.join(__dirname, '..')

const store = {}
const requests = []

const PAD = '<!-- ' + 'x'.repeat(200) + ' -->'

const SHELL = `<!DOCTYPE html><html><head><title>计算机类课程一体化平台</title></head><body>
<form name="top" action="/main.jsp" method="post" target="mainFrame"><input type="hidden" name="tab" value="1" /></form>
<iframe name="mainFrame" src=""></iframe>
<IFRAME src="/includes/stayalive.jsp" width="0" height="0"></IFRAME>
<a href="/index.jsp"></a>
<a href="/gitlab/index.jsp">GitLab</a>
<a href="/includes/redirect.jsp?tab=-6">个人信息</a>
<div class="nav">首页 课程信息 在线作业 在线考试 在线答疑 模型</div>
${PAD}</body></html>`

const MENU = `<!DOCTYPE html><html><head><title>个人信息</title></head><body>
<div class="menu">
<a href="/includes/redirect.jsp?tab=0">首页</a>
<a href="/includes/redirect.jsp?tab=-1">课程信息</a>
<a href="/includes/redirect.jsp?tab=-2">在线作业</a>
</div>
<script>function go(t){location.href='/includes/redirect.jsp?tab='+t}</script>
</body></html>`

// 作业列表：三种「没日期」的写法各来一条
const JOBS = `<!DOCTYPE html><html><head><title>在线作业</title></head><body>
<table class="list">
<tr><th>作业名称</th><th>截止时间</th><th>状态</th></tr>
<tr><td title="截止时间：2026-12-20 23:59"><a href="index.jsp?courseID=124&assignID=802">2025级认知实习报告书</a></td><td>未提交</td></tr>
<tr><td><a href="index.jsp?courseID=124&assignID=803">实习总结</a></td><td>12-25 23:59</td><td>未提交</td></tr>
<tr><td><a href="index.jsp?courseID=124&assignID=804">实习日志</a></td><td>未提交</td></tr>
</table></body></html>`

// 804 的详情页：日期在「提交截止时间」后面
const DETAIL_804 = `<!DOCTYPE html><html><head><title>实习日志</title></head><body>
<div class="info">课程：认知实习</div>
<div class="info">提交截止时间：2027-01-10 23:59</div>
</body></html>`

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
    const reply = (status, body) =>
      setTimeout(() => opt.success({ statusCode: status, data: body, header: {} }), 0)

    if (p === '/includes/redirect.jsp') {
      if (/tab=-2/.test(full)) return reply(200, JOBS)
      if (/tab=-6/.test(full)) return reply(200, MENU)
    }
    // 作业详情页：只有 804 有条目，其余回外壳（真机上大多数就是这个壳）
    if (p === '/index.jsp' && /assignID=804/.test(full)) return reply(200, DETAIL_804)
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
    console.log('  ✗ ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''))
  }
}

function ymd(ts) {
  const d = new Date(ts)
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() + ' ' + d.getHours() + ':' + d.getMinutes()
}

async function main() {
  edu.saveCfg({ base: 'http://10.67.4.14', cookie: 'educg_session=SESS1A1B2C3', stid: '202515020339' })

  console.log('\n[1] 列表页：日期只在属性里 / 只有月日 / 完全没有')
  const rows = edu.assignRows(JOBS)
  const byId = {}
  rows.forEach((r) => {
    byId[r.assignId] = r
  })
  ok('三条作业都解析出来了', rows.length === 3, rows.map((r) => r.assignId))
  ok('802：日期在 title 属性里也认（2026-12-20 23:59）', ymd(byId['802'].deadline) === '2026-12-20 23:59', ymd(byId['802'].deadline))
  ok(
    '803：只有「12-25 23:59」也认（补当年）',
    byId['803'].deadline > 0 &&
      new Date(byId['803'].deadline).getMonth() === 11 &&
      new Date(byId['803'].deadline).getDate() === 25,
    ymd(byId['803'].deadline)
  )
  ok('804：列表里确实没有日期（deadline 是 0，不编）', byId['804'].deadline === 0, byId['804'].deadline)

  console.log('\n[2] 详情页解析')
  ok(
    '「提交截止时间：2027-01-10 23:59」认得出',
    ymd(edu.deadlineFromHtml(DETAIL_804)) === '2027-1-10 23:59',
    ymd(edu.deadlineFromHtml(DETAIL_804))
  )
  ok(
    'JSON 字段 endTime 认得出',
    ymd(edu.deadlineFromHtml('<script>var cfg={"endTime":"2026-11-25 08:30:00"}</script>')) === '2026-11-25 8:30',
    ymd(edu.deadlineFromHtml('<script>var cfg={"endTime":"2026-11-25 08:30:00"}</script>'))
  )
  ok(
    '整页只有一个日期时用它',
    ymd(edu.deadlineFromHtml('<div>本作业有效期 2026-11-30</div>')) === '2026-11-30 23:59',
    ymd(edu.deadlineFromHtml('<div>本作业有效期 2026-11-30</div>'))
  )
  ok(
    '一堆日期又没有「截止」字样时返回 0（宁缺不猜）',
    edu.deadlineFromHtml('<div>创建 2026-10-01</div><div>更新 2026-10-05</div><div>发布 2026-10-06</div>') === 0,
    edu.deadlineFromHtml('<div>创建 2026-10-01</div><div>更新 2026-10-05</div><div>发布 2026-10-06</div>')
  )

  console.log('\n[3] 同步：列表没日期的，逐条去详情页补上')
  const r = await edu.sync()
  const t804 = r.tasks.filter((t) => t.externalId === 'educoder:assign:804')[0]
  const t802 = r.tasks.filter((t) => t.externalId === 'educoder:assign:802')[0]
  ok('804 补到了详情页的截止时间', !!t804 && ymd(t804.deadline) === '2027-1-10 23:59', t804 && ymd(t804.deadline))
  ok('802 用的是列表里的日期，没被覆盖', !!t802 && ymd(t802.deadline) === '2026-12-20 23:59', t802 && ymd(t802.deadline))
  // 804 缺日期 → 探路会把它的几种详情页写法都试一遍（都失败也不算白试，
  // 试完就收手）。绝不碰 802/803 这两条已经有日期的。
  ok(
    '只给缺日期的那条试详情页（≤5 次）',
    requests.filter((x) => /assignID=804/.test(x)).length >= 1 &&
      requests.filter((x) => /assignID=804/.test(x)).length <= 5,
    requests.filter((x) => /assignID=804/.test(x))
  )
  ok('不缺日期的没去开详情页', requests.filter((x) => /assignID=802/.test(x)).length === 0, requests.filter((x) => /assignID=802/.test(x)))
  ok('轨迹里说明了补数据的战绩', /补截止时间：缺 1 条，试了 \d+ 次，补上 1 条/.test(r.trace.join('；')), r.trace.filter((x) => /补截止时间/.test(x)))

  console.log('\n[4] 详情页也拿不到时不影响别的任务')
  const t803 = r.tasks.filter((t) => t.externalId === 'educoder:assign:803')[0]
  ok('803 还是按列表里的月日算', !!t803 && t803.deadline > 0, t803 && ymd(t803.deadline))
  ok('三条任务都在', r.tasks.length === 3, r.tasks.length)

  console.log('\n----------------------------------------')
  console.log('通过 ' + pass + '，失败 ' + fail)
  if (fail) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
