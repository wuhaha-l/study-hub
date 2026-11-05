/**
 * 希冀「在线作业」页：作业号到底写在哪个属性上？
 *
 * 真机（2026-10-26 第四次探测）报的是：
 *   作业列表 /includes/redirect.jsp?tab=-2（22623 字节）：作业行 0 / 带截止时间 0
 *   （有作业号但一行都没解析出来，下面是原文）
 *   · 2025级认知实习报告书
 *   … 走过的路：…tab=-2 → 200 / 22623 字节 / tr 2 / 课程 0 门 / 作业 1 条
 *
 * 也就是说 `assignCount()` 数到了 1 条作业，但 `parseRows()` 一行都没解析出来。
 * 旧解析器只认「锚的 href 里有作业号」，而这一行的作业号可能写在
 * `onclick="..."` / `data-href` / 甚至单引号的 href 里。
 *
 * 这个测试把几种真实写法都摆出来，要求都能变成任务。
 *
 * 运行：node test/edu-assign-forms.js
 */
const path = require('path')
const ROOT = path.join(__dirname, '..')

const store = {}
const requests = []

const SHELL = `<!DOCTYPE html><html><head><title>计算机类课程一体化平台</title></head><body>
<form name="top" action="/main.jsp" method="post" target="mainFrame"></form>
<a href="/index.jsp"></a>
<a href="/gitlab/index.jsp">GitLab</a>
<a href="/includes/redirect.jsp?tab=-6">个人信息</a>
<div class="nav">首页 课程信息 在线作业 在线考试 在线答疑 模型</div>
</body></html>`

// ① 作业号只在 onclick 里，href 是 javascript:（老 JSP 很常见的写法）
const TAB_ONCLICK = `<!DOCTYPE html><html><head><title>在线作业</title></head><body>
<table class="list">
<tr><th>作业名称</th><th>截止时间</th><th>操作</th></tr>
<tr class="row"><td class="name">2025级认知实习报告书</td><td>2026-12-20 23:59</td>
<td><a href="javascript:;" onclick="go('index.jsp?courseID=124&assignID=802')">进入作业</a></td></tr>
</table>
<script>function go(u){location.href=u}</script>
</body></html>`

// ② 作业号在 data-* 上，href 指向详情脚本
const TAB_DATA = `<!DOCTYPE html><html><head><title>在线作业</title></head><body>
<table class="list">
<tr><th>名称</th><th>截止</th></tr>
<tr><td><a href="#" data-course="124" data-assign="803">实习总结</a></td><td>2026年12月28日</td></tr>
</table></body></html>`

// ③ 单引号 href（旧解析器只认双引号）
const TAB_SINGLE = `<!DOCTYPE html><html><head><title>在线作业</title></head><body>
<ul class="jobs">
<li><a href='index.jsp?courseID=115&assignID=901'>实验报告一</a><span>截止 2026-11-05 18:00</span><span>已提交</span></li>
</ul></body></html>`

// ④ 作业号就写在 href 里，但 href 前面还有别的锚（旧代码取「这一行的第一个 <a>」）
const TAB_TRICKY = `<!DOCTYPE html><html><head><title>在线作业</title></head><body>
<table class="list">
<tr><th>名称</th><th>截止</th></tr>
<tr><td><a href="/index.jsp">首页</a></td>
<td><a href="index.jsp?courseID=124&assignID=805">2025级认知实习报告书</a></td>
<td>2026-12-20</td></tr>
</table></body></html>`

// 每个用例：tab 号 + 期望解析出的东西（assignId / 标题 / 截止日期是几号）
// ⑤ 整页没有表格也没有列表，每条作业是一个 div 卡片
const TAB_DIV = `<!DOCTYPE html><html><head><title>在线作业</title></head><body>
<div class="job-card"><span class="t">实验报告二</span><span class="d">截止 2026-11-19 12:00</span>
<a class="go" href="/index.jsp?courseID=115&assignID=907">查看</a></div>
<div class="job-card"><span class="t">实验报告三</span><a class="go" href="/index.jsp?courseID=115&assignID=908">查看</a></div>
</body></html>`

const CASES = [
  { name: 'TAB_ONCLICK', html: TAB_ONCLICK, tab: '-2', aid: '802', title: '2025级认知实习报告书', day: 20, done: false },
  { name: 'TAB_DATA', html: TAB_DATA, tab: '-3', aid: '803', title: '实习总结', day: 28, done: false },
  { name: 'TAB_SINGLE', html: TAB_SINGLE, tab: '-4', aid: '901', title: '实验报告一', day: 5, done: true },
  { name: 'TAB_TRICKY', html: TAB_TRICKY, tab: '-5', aid: '805', title: '2025级认知实习报告书', day: 20, done: false }
  // div 卡片那页放在 [4b] 单独验：摸页有预算，塞太多 tab 会挤不进来
]

let current = CASES[0]

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
      const m = /tab=(-\d+)/.exec(full)
      const hit = m && CASES.filter((c) => c.tab === m[1])[0]
      if (hit) return reply(200, hit.html)
      if (/tab=-6/.test(full)) {
        return reply(
          200,
          '<html><body><div class="menu">' +
            CASES.map((c) => '<a href="/includes/redirect.jsp?tab=' + c.tab + '">' + c.name + '</a>').join('') +
            '</div></body></html>'
        )
      }
    }
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

async function main() {
  edu.saveCfg({ base: 'http://10.67.4.14', cookie: 'educg_session=S1', stid: '202515020339' })

  for (let i = 0; i < CASES.length; i++) {
    current = CASES[i]
    console.log('\n[' + (i + 1) + '] ' + current.name + '：作业号可能写在别处')
    requests.length = 0
    const r = await edu.sync()
    console.log('任务：' + JSON.stringify(r.tasks.map((x) => ({ t: x.title, d: x.deadline, s: x.status, u: x.url })), null, 0))

    // 每趟都会把预算内的 tab 页都摸一遍，所以按作业号挑出这一页的那条
    const mine = r.tasks.filter((x) => x.externalId === 'educoder:assign:' + current.aid)
    const one = mine[0]
    ok('这条作业被解析出来了', mine.length === 1, r.tasks.map((x) => x.externalId))
    ok('标题是作业名（不是「进入作业」/表头/首页）', one && one.title === current.title, one && one.title)
    ok('截止日期认到了', one && new Date(one.deadline).getDate() === current.day, one && one.deadline)
    ok('提交状态对', one && (one.status === 'done') === current.done, one && one.status)
    ok('链接可用（不是 # / javascript:）', one && one.url.indexOf('http://10.67.4.14/index.jsp') === 0, one && one.url)
  }

  console.log('\n[4b] div 卡片页：解析器层面直接验（摸页预算挡不住这一层）')
  const divRows = edu.assignRows(TAB_DIV)
  ok('div 卡片解析出 2 条', divRows.length === 2, divRows.map((r) => r.title))
  ok('第一条标题/日期对', divRows[0] && divRows[0].title === '实验报告二' && divRows[0].deadline > 0, divRows[0] && divRows[0].title)
  ok('第二条没有日期就留 0（不编）', divRows[1] && divRows[1].deadline === 0, divRows[1] && divRows[1].deadline)
  ok('作业号在 href 里', /assignID=907/.test(divRows[0].href), divRows[0].href)

  console.log('\n[5] 一趟同步里同一份作业不重复，且探测能正常输出')
  current = CASES[0]
  const r = await edu.sync()
  const ids = r.tasks.map((t) => t.externalId)
  ok('作业号不重复', ids.length === new Set(ids).size, ids)
  ok('四页里能摸到的作业都不重复', r.tasks.length === ids.length, ids)
  const lines = await edu.probe()
  ok('探测不抛异常', Array.isArray(lines) && lines.length > 0)

  console.log('\n----------------------------------------')
  console.log('通过 ' + pass + '，失败 ' + fail)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('测试崩了：', e)
  process.exit(1)
})
