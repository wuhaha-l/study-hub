/**
 * 希冀「交没交」：平台上提交过的作业要自动变成已完成。
 *
 * 用户报障（2026-10-27）：「集合的概念完成了咋不自己变成已完成」。
 *
 * 真机结构（同 edu-realpage.js）：
 *   左栏  <a href="index.jsp?courseID=40&assignID=861"> 序偶和关系 - 2026-2027(1) </a>
 *   右栏  <h4> 序偶和关系 - 2026-2027(1)</h4>
 *         <p> 作业时间：<b>…</b> 至 <b>…</b> </p>
 *         <table><tr><td>100.00</td><td>初次提交时间: … 最近一次提交时间: …</td></tr></table>
 *
 * 「已提交」这三个字在左栏锚上一个都没有，只体现在右栏那块里。所以解析行时
 * 永远判成「待完成」——这就是本文件要钉住的行为：
 *   1. 右栏那块「初次提交时间 / 最近一次提交时间」按标题绑回**那一条** → done
 *   2. 同页其它作业不许跟着变 done（不平摊）
 *   3. 页面明确写「未提交」时，不许标 done（否定优先，能撤掉历史作业区的误标）
 *   4. 端到端：sync() 出来的任务 status 真的是 done（不是只有 row 上写了个字段）
 *
 * 运行：node test/edu-done.js
 */
const path = require('path')
const ROOT = path.join(__dirname, '..')

const store = {}
const requests = []
// 打开「点一下 858」时返回什么：默认还是外壳（真机就是这样），
// [9] 里单独打开，模拟「点开之后右栏切到它、露出提交时间」
let click858 = false

const PAD = '<!-- ' + 'x'.repeat(300) + ' -->'

const SHELL = `<!DOCTYPE html><html><head><title>计算机类课程一体化平台</title></head><body>
<form name="top" action="/main.jsp" method="post" target="mainFrame"><input type="hidden" name="tab" value="1" /></form>
<iframe name="mainFrame" src=""></iframe>
${PAD}</body></html>`

/**
 * 在线作业页：左栏清单（当前作业 / 历史作业），右栏只渲染当前选中的那一条。
 * `active` 的每项可以带 score / submit —— 有 submit 就渲染成「已交」的表格。
 */
function listPage(courseId, items, active) {
  const cur = items.filter((x) => x.current)
  const hist = items.filter((x) => !x.current)
  const line = (x) =>
    `<a href="index.jsp?courseID=${courseId}&assignID=${x.id}" class="list-group-item list-group-item-action${
      String(active) === String(x.id) ? ' active' : ''
    }"> ${x.title} </a>`
  const shown = items.filter((x) => String(x.id) === String(active))[0]
  let detail = '  <h4> 作业列表</h4>'
  if (shown) {
    detail =
      `  <h4> ${shown.title} </h4>\n` +
      `  <p> 作业时间：<b>${shown.from}</b> 至 <b>${shown.to}</b> </p>\n` +
      (shown.state === 'todo'
        ? '  <p class="text-danger"> 未提交 </p>'
        : shown.submit
        ? `  <table><tr><td>${shown.score || '--'}</td><td>初次提交时间: ${shown.submit}&nbsp;&nbsp;&nbsp;最近一次提交时间: ${shown.submit}</td></tr></table>`
        : '')
  }
  return `<!DOCTYPE html><html><head><title>在线作业</title></head><body>
<div class="col-2 mr-2-box">
  <span class="text-muted"><strong> 当前作业</strong></span>
  <div class="list-group list-group-flush mb-4">
    ${cur.map(line).join('\n    ')}
  </div>
  <span class="text-muted"><strong> 历史作业</strong></span>
  <div class="list-group list-group-flush">
    ${hist.map(line).join('\n    ')}
  </div>
</div>
<div class="col">
${detail}
</div>
${PAD}</body></html>`
}

const BASE_ITEMS = [
  { id: 861, title: '序偶和关系 - 2026-2027(1)', current: true, from: '2026-10-26 20:00:00', to: '2026-11-07 23:59:00' },
  { id: 858, title: '集合的概念 - 2026-2027(1)', current: true, from: '2026-11-08 08:00:00', to: '2026-11-20 23:59:00' },
  { id: 857, title: '命题逻辑 - 2026-2027(1)', current: false },
  { id: 856, title: '谓词逻辑 - 2026-2027(1)', current: false }
]

/** 861 交过了（右栏是它） */
const PAGE_861_DONE = listPage(
  40,
  BASE_ITEMS.map((x) => (x.id === 861 ? Object.assign({}, x, { submit: '2026-10-27 16:20:00', score: '100.00' }) : x)),
  '861'
)

/** 用户点开了 858（「集合的概念」）并交了，右栏换成了它 */
const PAGE_858_DONE = listPage(
  40,
  BASE_ITEMS.map((x) => (x.id === 858 ? Object.assign({}, x, { submit: '2026-10-27 18:05:00', score: '95.00' }) : x)),
  '858'
)

/** 右栏是 861，但页面明确写着「未提交」 */
const PAGE_861_TODO = listPage(
  40,
  BASE_ITEMS.map((x) => (x.id === 861 ? Object.assign({}, x, { state: 'todo' }) : x)),
  '861'
)

/** 右边写「待批阅」：交上去了、还没批，同样算已完成 */
const PAGE_861_WAIT = listPage(40, BASE_ITEMS, '861').replace(
  '  <p> 作业时间：<b>2026-10-26 20:00:00</b> 至 <b>2026-11-07 23:59:00</b> </p>',
  '  <p> 作业时间：<b>2026-10-26 20:00:00</b> 至 <b>2026-11-07 23:59:00</b> </p>\n  <p> 状态：待批阅 </p>'
)

/** 端到端用：首页本身就是这张在线作业页 */
const HOME_PAGE = PAGE_861_DONE

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
    if (click858 && /assignID=858/.test(full)) return reply(200, PAGE_858_DONE)
    if (p === '/indexcs/simple.jsp' || p === '/index.jsp' || p === '/') return reply(200, HOME_PAGE)
    if (p === '/includes/redirect.jsp' && /tab=-2/.test(full)) return reply(200, HOME_PAGE)
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

const byId = (rows) => {
  const m = {}
  rows.forEach((r) => {
    m[r.assignId] = r
  })
  return m
}

async function main() {
  console.log('[1] 右栏是「序偶和关系」并写着提交时间 → 它算已完成，别人不算')
  {
    const rows = edu.assignRows(PAGE_861_DONE)
    ok('解析出 4 条作业', rows.length === 4, rows.length)
    const n = edu.bindPageDone(PAGE_861_DONE, rows)
    const m = byId(rows)
    ok('861 判成已提交', m['861'].done === true, m['861'].done)
    ok('858 没被连坐（仍是待完成）', !m['858'].done, m['858'].done)
    ok('返回标成已完成的条数 = 1', n === 1, n)
    ok('页面痕迹认出了「初次提交时间」', edu.submitMarks(PAGE_861_DONE).some((x) => /初次提交时间/.test(x.word)))
  }

  console.log('\n[2] 用户点开的是「集合的概念」并交了 → 换它变已完成')
  {
    const rows = edu.assignRows(PAGE_858_DONE)
    edu.bindPageDone(PAGE_858_DONE, rows)
    const m = byId(rows)
    ok('858 判成已提交', m['858'].done === true, m['858'].done)
    ok('861 这次没交（右栏没它的提交时间）→ 待完成', !m['861'].done, m['861'].done)
  }

  console.log('\n[3] 页面明确写「未提交」→ 不许标已完成（否定优先）')
  {
    const rows = edu.assignRows(PAGE_861_TODO)
    // 先人为标一次 done，模拟「历史作业区 → 已完成」那种粗标
    rows.forEach((r) => {
      if (r.assignId === '861') r.done = true
    })
    const n = edu.bindPageDone(PAGE_861_TODO, rows)
    const m = byId(rows)
    ok('861 被撤回到待完成', m['861'].done === false, m['861'].done)
    ok('这一页没有标成已完成的（返回 0）', n === 0, n)
  }

  console.log('\n[4] 「待批阅」= 交上去了，算已完成')
  {
    const rows = edu.assignRows(PAGE_861_WAIT)
    edu.bindPageDone(PAGE_861_WAIT, rows)
    ok('861 判成已完成', byId(rows)['861'].done === true, byId(rows)['861'].done)
  }

  console.log('\n[5] 没有提交痕迹的页 → 一条都不许编')
  {
    const plain = listPage(40, BASE_ITEMS, '861')
    const rows = edu.assignRows(plain)
    const before = rows.map((r) => !!r.done)
    const n = edu.bindPageDone(plain, rows)
    ok('返回 0', n === 0, n)
    ok('行上的 done 一个字都没动', JSON.stringify(rows.map((r) => !!r.done)) === JSON.stringify(before))
  }

  console.log('\n[6] 短标题不许互相命中（「集合」不该吃到「集合的概念」的提交状态）')
  {
    const page = `<!DOCTYPE html><html><body>
<a href="index.jsp?courseID=40&assignID=900">集合</a>
<a href="index.jsp?courseID=40&assignID=901">集合的概念</a>
<h4> 集合的概念 </h4><p> 初次提交时间: 2026-10-27 10:00:00 </p>
</body></html>`
    const rows = edu.assignRows(page)
    edu.bindPageDone(page, rows)
    const m = byId(rows)
    ok('「集合的概念」判成已提交', m['901'] && m['901'].done === true, m['901'] && m['901'].done)
    ok('「集合」没被连坐（只有 2 个字，不做包含匹配）', !(m['900'] && m['900'].done), m['900'] && m['900'].done)
    ok('submitStatusOf 单条查询同口径', edu.submitStatusOf(page, '900', '集合') === '', edu.submitStatusOf(page, '900', '集合'))
  }

  console.log('\n[7] 端到端：sync() 出来的任务 status 就是 done')
  {
    edu.saveCfg({ base: 'http://10.67.4.14', cookie: 'educg_session=abc123' })
    requests.length = 0
    const r = await edu.sync()
    const list = r.tasks || []
    const t861 = list.filter((t) => /:assign:861$/.test(t.externalId))[0]
    const t858 = list.filter((t) => /:assign:858$/.test(t.externalId))[0]
    ok('抓到了 861', !!t861, list.map((t) => t.externalId).slice(0, 5))
    ok('861 的 status = done', t861 && t861.status === 'done', t861 && t861.status)
    ok('858 的 status = todo', t858 && t858.status === 'todo', t858 && t858.status)
    ok('已完成的不影响截止时间（861 仍有 11-07）', t861 && !!t861.deadline, t861 && t861.deadline)
    ok(
      '轨迹里交代了「页面显示已提交 N 条」',
      (r.trace || []).some((x) => /已提交 \d+ 条/.test(String(x))),
      (r.trace || []).filter((x) => /已提交/.test(String(x)))
    )
  }

  console.log('\n[8] 状态直接写在作业那一行（表格列）→ 解析行时就该认出来')
  {
    const page = `<!DOCTYPE html><html><body><table>
<tr><td><a href="index.jsp?courseID=40&assignID=861">序偶和关系</a></td><td>2026-11-07 23:59</td><td>已提交</td></tr>
<tr><td><a href="index.jsp?courseID=40&assignID=858">集合的概念</a></td><td>2026-11-20 23:59</td><td>未提交</td></tr>
</table></body></html>`
    const rows = edu.assignRows(page)
    edu.bindPageDone(page, rows)
    const m = byId(rows)
    ok('861 行内写「已提交」→ 已完成', m['861'].done === true, m['861'].done)
    ok('858 行内写「未提交」→ 待完成', !m['858'].done, m['858'].done)
  }

  console.log('\n[9] 补日期时把作业点开了 → 顺手读到「已提交」，也标成已完成')
  {
    click858 = true
    const tasks = [
      {
        externalId: 'educoder:assign:858',
        courseId: '40',
        courseName: '离散数学',
        title: '集合的概念 - 2026-2027(1)',
        deadline: 0,
        status: 'todo',
        url: 'http://10.67.4.14/index.jsp?courseID=40&assignID=858'
      }
    ]
    const stat = { submitted: 0 }
    const trace = []
    requests.length = 0
    await edu.fillDeadlines(tasks, trace, {}, stat)
    ok('status 变成 done', tasks[0].status === 'done', tasks[0].status)
    ok('stat.submitted 记了 1 条', stat.submitted === 1, stat.submitted)
    ok('日期也一起补上了（11-20 23:59）', !!tasks[0].deadline, tasks[0].deadline)
    ok('轨迹里写明了原因', trace.some((x) => /显示已提交/.test(String(x))), trace.filter((x) => /显示已提交/.test(String(x))))
    click858 = false
  }

  console.log('\n----------------------------------------')
  console.log('通过 ' + pass + '，失败 ' + fail)
  if (fail) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
