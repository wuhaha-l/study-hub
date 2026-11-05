/**
 * 「当前作业」区里的作业，不许补成过去的截止日期。
 *
 * 用户报障（2026-10-27）：「咋集合的概念截止 176 天了」。
 * 一条 11-20 才交的作业，被塞了个半年多以前的日期，于是从「更晚 / 无期限」
 * 跳到「已过期」，还一直催你交；而平台上它明明还在「当前作业」区。
 *
 * 判据：希冀把还没截止的作业放在「当前作业」区，把过期/已交的放在「历史作业」区。
 * 既然它还在当前区，截止就不可能在过去——这时候拿到一个过去日期，只能是绑错了
 * （串到别的作业、或者把「初次提交时间 / 学期结束」当成了截止）。
 *
 * 这个文件钉住：
 *   1. 当前区的作业 + 过去日期 → 不采用（保持「无截止」，比「已截止 176 天」好）
 *   2. 历史区的作业 + 过去日期 → 照常采用（历史作业的截止本来就是过去的）
 *   3. 当前区的作业 + 未来日期 → 照常采用（正常情况不能被误伤）
 *   4. 补日期那条路（fillDeadlines 开详情页）也守同一条规矩
 *
 * 运行：node test/edu-past.js
 */
const path = require('path')
const ROOT = path.join(__dirname, '..')

const store = {}

const PAGE_CURRENT_PAST = `<!DOCTYPE html><html><body>
<div class="col-2">
  <span class="text-muted"><strong> 当前作业</strong></span>
  <div class="list-group">
    <a href="index.jsp?courseID=40&assignID=858" class="list-group-item active"> 集合的概念 - 2026-2027(1) </a>
  </div>
  <span class="text-muted"><strong> 历史作业</strong></span>
  <div class="list-group">
    <a href="index.jsp?courseID=40&assignID=857" class="list-group-item"> 命题逻辑 - 2026-2027(1) </a>
  </div>
</div>
<div class="col">
  <h4> 集合的概念 - 2026-2027(1) </h4>
  <p> 作业时间：<b>2026-04-27 08:00:00</b> 至 <b>2026-05-04 23:59:00</b> </p>
</div>
</body></html>`

const PAGE_HIST_PAST = `<!DOCTYPE html><html><body>
<div class="col-2">
  <span class="text-muted"><strong> 当前作业</strong></span>
  <div class="list-group">
    <a href="index.jsp?courseID=40&assignID=858" class="list-group-item"> 集合的概念 - 2026-2027(1) </a>
  </div>
  <span class="text-muted"><strong> 历史作业</strong></span>
  <div class="list-group">
    <a href="index.jsp?courseID=40&assignID=856" class="list-group-item active"> 谓词逻辑 - 2026-2027(1) </a>
  </div>
</div>
<div class="col">
  <h4> 谓词逻辑 - 2026-2027(1) </h4>
  <p> 作业时间：<b>2025-09-01 08:00:00</b> 至 <b>2025-09-30 23:59:00</b> </p>
</div>
</body></html>`

const PAGE_CURRENT_FUTURE = `<!DOCTYPE html><html><body>
<div class="col-2">
  <span class="text-muted"><strong> 当前作业</strong></span>
  <div class="list-group">
    <a href="index.jsp?courseID=40&assignID=858" class="list-group-item active"> 集合的概念 - 2026-2027(1) </a>
  </div>
</div>
<div class="col">
  <h4> 集合的概念 - 2026-2027(1) </h4>
  <p> 作业时间：<b>2026-11-08 08:00:00</b> 至 <b>2026-11-20 23:59:00</b> </p>
</div>
</body></html>`

/**
 * 没有「当前作业 / 历史作业」分区的一页（老版部署就是这样）：
 * 判不出在哪一区，就不能拿「在不在当前区」去挡日期，过去日期照常采用。
 */
const PAGE_SINGLE_PAST = `<!DOCTYPE html><html><body>
<a href="index.jsp?courseID=115&assignID=573">2025级高级语言程序设计实验报告</a>
<h4> 2025级高级语言程序设计实验报告 </h4>
<p> 作业时间：<b>2025-01-16 20:31:00</b> 至 <b>2025-01-28 15:35:00</b> </p>
</body></html>`

// 这一份会被 [5] 换掉：默认回「当前作业区 + 过去日期」那一页
let replyPage = PAGE_CURRENT_PAST

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
    setTimeout(() => opt.success({ statusCode: 200, data: replyPage, header: {} }), 0)
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
  return (
    d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) +
    ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2)
  )
}

const byId = (rows) => {
  const m = {}
  rows.forEach((r) => {
    m[r.assignId] = r
  })
  return m
}

async function main() {
  console.log('[1] 当前作业区 + 过去日期 → 不采用（这就是「截止 176 天」的成因）')
  {
    const rows = edu.assignRows(PAGE_CURRENT_PAST)
    const m0 = byId(rows)
    ok('858 被认成「在当前作业区」', m0['858'].inCurrent === true, m0['858'].inCurrent)
    ok('857 在历史作业区', m0['857'].inCurrent === false, m0['857'].inCurrent)
    edu.bindPageDeadlines(PAGE_CURRENT_PAST, rows)
    const m = byId(rows)
    ok('858 没被塞上 2026-05-04（保持 0）', m['858'].deadline === 0, ymd(m['858'].deadline))
    ok('857 也没被连坐', m['857'].deadline === 0, ymd(m['857'].deadline))
  }

  console.log('\n[2] 历史作业区 + 过去日期 → 照常采用（历史作业本来就是过去的）')
  {
    const rows = edu.assignRows(PAGE_HIST_PAST)
    edu.bindPageDeadlines(PAGE_HIST_PAST, rows)
    const m = byId(rows)
    ok('856 绑上 2025-09-30 23:59', ymd(m['856'].deadline) === '2025-09-30 23:59', ymd(m['856'].deadline))
    ok('858 仍是 0（这页没渲染它的时间）', m['858'].deadline === 0, ymd(m['858'].deadline))
  }

  console.log('\n[3] 当前作业区 + 未来日期 → 正常绑上（护栏不能误伤）')
  {
    const rows = edu.assignRows(PAGE_CURRENT_FUTURE)
    edu.bindPageDeadlines(PAGE_CURRENT_FUTURE, rows)
    ok('858 绑上 2026-11-20 23:59', ymd(byId(rows)['858'].deadline) === '2026-11-20 23:59', ymd(byId(rows)['858'].deadline))
  }

  console.log('\n[4] 补日期那条路也守同一条规矩（详情页给过去日期 → 不采用）')
  {
    const task = {
      externalId: 'educoder:assign:858',
      courseId: '40',
      courseName: '离散数学',
      title: '集合的概念 - 2026-2027(1)',
      deadline: 0,
      status: 'todo',
      inCurrent: true,
      url: 'http://10.67.4.14/index.jsp?courseID=40&assignID=858'
    }
    const trace = []
    const got = await edu.fillDeadlines([task], trace, {}, { submitted: 0 })
    ok('没有补上日期（got = 0）', got === 0, got)
    ok('deadline 仍是 0', task.deadline === 0, ymd(task.deadline))
  }

  console.log('\n[5] 判不出在哪个区时行为不变，过去日期照常补')
  {
    const task = {
      externalId: 'educoder:assign:573',
      courseId: '115',
      courseName: '高级语言程序设计实验',
      title: '2025级高级语言程序设计实验报告',
      deadline: 0,
      status: 'todo',
      url: 'http://10.67.4.14/index.jsp?courseID=115&assignID=573'
    }
    replyPage = PAGE_SINGLE_PAST
    const trace = []
    const got = await edu.fillDeadlines([task], trace, {}, { submitted: 0 })
    ok('补上了（不因为过去就一律拒绝）', got === 1, got)
    ok('日期是 2025-01-28 15:35', ymd(task.deadline) === '2025-01-28 15:35', ymd(task.deadline))
    replyPage = PAGE_CURRENT_PAST
  }

  console.log('\n----------------------------------------')
  console.log('通过 ' + pass + '，失败 ' + fail)
  if (fail) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
