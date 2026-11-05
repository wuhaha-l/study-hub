/**
 * 希冀「在线作业」锚列表结构：一个 <a> 就是一条作业。
 *
 * 真机（2026-10-26 第八次探测）实锤：
 *   课程「离散数学」：多抓到 10 条
 *   ✅ 切到「离散数学」后的在线作业：1 条（序偶与笛卡尔积（3-4））
 *   ⚠ 作业号附近原文：
 *     <div class="list-group list-group-flush mb-4">
 *       <a href="index.jsp?courseID=40&assignID=861" class="list-group-item ..."> 序偶和关系 - 2026-2027(1) </a>
 *       <a href="index.jsp?courseID=40&assignID=858" class="list-g...
 *
 * 老 assignRows 用 tr 切块刮到 1 条就提前收工，剩下的 9 条锚列表全丢。
 * 修法：锚不在 <tr> 里、且带 assignID 的，每个锚当一条作业。
 *
 * 运行：node test/edu-anchor-list.js
 */
const path = require('path')
const ROOT = path.join(__dirname, '..')

const store = {}
const requests = []

// 离散数学真实结构：一个 <div class="list-group"> 里一串 <a>，作业号在 href 里
const ANCHOR_LIST = `<!DOCTYPE html><html><head><title>在线作业</title></head><body>
<div class="list-group list-group-flush mb-4">
<a href="index.jsp?courseID=40&assignID=861" class="list-group-item list-group-item-action active"> 序偶和关系 - 2026-2027(1) </a>
<a href="index.jsp?courseID=40&assignID=858" class="list-group-item list-group-item-action"> 命题逻辑 - 2026-2027(1) </a>
<a href="index.jsp?courseID=40&assignID=859" class="list-group-item list-group-item-action"> 谓词逻辑 - 2026-2027(1) </a>
<a href="index.jsp?courseID=40&assignID=860" class="list-group-item list-group-item-action"> 集合论 - 2026-2027(1) </a>
<a href="index.jsp?courseID=40&assignID=862" class="list-group-item list-group-item-action"> 关系与函数 - 2026-2027(1) </a>
<a href="index.jsp?courseID=40&assignID=863" class="list-group-item list-group-item-action"> 图论初步 - 2026-2027(1) </a>
<a href="index.jsp?courseID=40&assignID=864" class="list-group-item list-group-item-action"> 代数系统 - 2026-2027(1) </a>
<a href="index.jsp?courseID=40&assignID=865" class="list-group-item list-group-item-action"> 格与布尔代数 - 2026-2027(1) </a>
<a href="index.jsp?courseID=40&assignID=866" class="list-group-item list-group-item-action"> 组合数学 - 2026-2027(1) </a>
<a href="index.jsp?courseID=40&assignID=867" class="list-group-item list-group-item-action"> 复习与答疑 - 2026-2027(1) </a>
</div>
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
    requests.push(full)
    const reply = (status, body) => setTimeout(() => opt.success({ statusCode: status, data: body, header: {} }), 0)
    const p = full.split('?')[0]
    if (p === '/includes/redirect.jsp') return reply(200, ANCHOR_LIST)
    return reply(200, ANCHOR_LIST)
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
    console.log('  ✗ ' + name + ' → ' + (extra === undefined ? '' : JSON.stringify(extra)))
  }
}

function main() {
  console.log('[1] 锚列表：一个 <a> 就是一条作业')
  const rows = edu.assignRows(ANCHOR_LIST)
  ok('10 条作业全解析出来', rows.length === 10, rows.length)
  ok('作业号按出现顺序', rows[0].assignId === '861' && rows[9].assignId === '867', rows.map((r) => r.assignId))
  ok('标题是锚文字（不是「进入作业」）', rows[0].title.indexOf('序偶和关系') === 0, rows[0].title)
  ok('课程号取到了', rows.every((r) => r.courseId === '40'), rows.map((r) => r.courseId))
  ok('href 指向作业详情', /assignID=861/.test(rows[0].href), rows[0].href)
  ok('没有重复作业号', new Set(rows.map((r) => r.assignId)).size === 10)

  console.log('\n[2] 表格结构不受影响（锚在 <tr> 里，日期状态在 td 里）')
  const TABLE = `<!DOCTYPE html><html><body><table>
<tr><th>作业</th><th>截止</th><th>状态</th></tr>
<tr><td><a href="index.jsp?courseID=124&assignID=802">2025级认知实习报告书</a></td><td>2026-12-20 23:59</td><td>未提交</td></tr>
<tr><td><a href="index.jsp?courseID=124&assignID=803">实习总结</a></td><td>已提交</td><td>已提交</td></tr>
</table></body></html>`
  const tr = edu.assignRows(TABLE)
  ok('表格行照旧走 tr 切块（2 条）', tr.length === 2, tr.length)
  ok('表格行的截止时间没丢', tr[0].deadline > 0, tr[0].deadline)
  ok('表格行的提交状态没丢', tr[1].done === true, tr[1].done)

  console.log('\n[3] 混合：锚列表里夹着导航锚，不误伤')
  const MIXED = `<!DOCTYPE html><html><body>
<a href="/index.jsp">首页</a>
<a href="/gitlab/index.jsp">GitLab</a>
<div class="list-group">
<a href="index.jsp?courseID=40&assignID=900">作业一</a>
<a href="index.jsp?courseID=40&assignID=901">作业二</a>
<a href="index.jsp?courseID=40&assignID=902">作业三</a>
</div></body></html>`
  const mx = edu.assignRows(MIXED)
  ok('只收带作业号的锚（3 条，不混入导航）', mx.length === 3, mx.map((r) => r.assignId))

  console.log('\n[4] 分区：当前作业=未完成，历史作业=已完成')
  const SECTIONED = `<!DOCTYPE html><html><body>
<i class="fas fa-clock"></i> 当前作业</strong></span>
<div class="list-group list-group-flush mb-4">
<a href="index.jsp?courseID=40&assignID=861" class="list-group-item list-group-item-action active"> 序偶和关系 - 2026-2027(1) </a>
<a href="index.jsp?courseID=40&assignID=858" class="list-group-item list-group-item-action"> 命题逻辑 - 2026-2027(1) </a>
</div>
<i class="fas fa-history"></i> 历史作业</strong></span>
<div class="list-group list-group-flush mb-4">
<a href="index.jsp?courseID=40&assignID=801" class="list-group-item list-group-item-action"> 集合论 - 2025-2026(2) </a>
<a href="index.jsp?courseID=40&assignID=800" class="list-group-item list-group-item-action"> 图论初步 - 2025-2026(2) </a>
</div>
</body></html>`
  const sc = edu.assignRows(SECTIONED)
  ok('4 条作业全解析出来', sc.length === 4, sc.length)
  ok('当前作业区判为未完成', sc.find((r) => r.assignId === '861').done === false, sc.find((r) => r.assignId === '861').done)
  ok('历史作业区判为已完成', sc.find((r) => r.assignId === '801').done === true, sc.find((r) => r.assignId === '801').done)
  ok('历史作业区另一条也已完成', sc.find((r) => r.assignId === '800').done === true, sc.find((r) => r.assignId === '800').done)

  console.log('\n----------------------------------------')
  console.log('通过 ' + pass + '，失败 ' + fail)
  process.exit(fail ? 1 : 0)
}

main()
