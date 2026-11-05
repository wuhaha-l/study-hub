/**
 * 希冀「作业时间：A 至 B」——这套平台唯一给出截止的地方。
 *
 * 真机轨迹（2026-10-27）里的原文：
 *   <h4> 序偶和关系 - 2026-2027(1)</h4>
 *   <p> 作业时间：<b>2026-10-26 20:00:00</b> 至 <b>2026-11-07 23:59:00</b> </p>
 *   <td>100.00</td><td>初次提交时间: 2026-07-11 11:08:40 最近一次提交时间: 2026-07-13 …
 *
 * 四个坑都用真数据钉住：
 *   1. 截止是 `至` 后面那个时间，不是前面那个
 *   2. 「初次提交时间 / 最近一次提交时间」是交作业的时刻，绝不能当截止
 *   3. 列表页只渲染「当前作业」这一段，[不能]拿它去填同页的历史作业
 *   4. 想拿别人的时间，得先「点」它一下（服务端记住当前选中哪条）
 *
 * 运行：node test/edu-range.js
 */
const path = require('path')
const ROOT = path.join(__dirname, '..')

const store = {}
const requests = []

const PAD = '<!-- ' + 'x'.repeat(200) + ' -->'

// 真机上 index.jsp?courseID=&assignID= 一律返回这个 20852 字节的外壳
const SHELL = `<!DOCTYPE html><html><head><title>计算机类课程一体化平台</title></head><body>
<form name="top" action="/main.jsp" method="post" target="mainFrame"><input type="hidden" name="tab" value="1" /></form>
<iframe name="mainFrame" src=""></iframe>
<div class="nav">首页 课程信息 在线作业 在线考试 在线答疑 模型</div>
${PAD}</body></html>`

// 「离散数学」三条作业；只有服务器记住的「当前选中」那条会渲染出作业时间
const MATH = {
  861: { title: '序偶和关系 - 2026-2027(1)', from: '2026-10-26 20:00:00', to: '2026-11-07 23:59:00' },
  858: { title: '集合的概念 - 2026-2027(1)', from: '2026-11-08 08:00:00', to: '2026-11-20 23:59:00' }
}
const TITLES = { 861: MATH[861].title, 858: MATH[858].title, 857: '命题逻辑 - 2026-2027(1)' }

function page40(cur) {
  const j = MATH[cur]
  const line = (id) =>
    `<a href="index.jsp?courseID=40&assignID=${id}" class="list-group-item list-group-item-action${String(cur) === String(id) ? ' active' : ''}"> ${TITLES[id]} </a>`
  return `<!DOCTYPE html><html><head><title>在线作业</title></head><body>
<div class="col-2 mr-2-box">
  <span class="text-muted"><strong><i class="fas fa-clock"></i> 当前作业</strong></span>
  <div class="list-group list-group-flush mb-4">
    ${line(861)}${line(858)}${line(857)}
  </div>
  <span class="text-muted"><strong><i class="fas fa-history"></i> 历史作业</strong></span>
  <div class="list-group list-group-flush"></div>
</div>
<div class="col">
${
  j
    ? `  <h4> ${j.title}</h4>
  <p> 作业时间：<b>${j.from}</b> 至 <b>${j.to}</b> </p>
  <table><tr><td>100.00</td><td>初次提交时间: 2026-10-27 11:08:40&nbsp;&nbsp;&nbsp;最近一次提交时间: 2026-10-27 16:20</td></tr></table>`
    : '  <h4> 作业列表</h4>'
}
</div>
</body></html>`
}

const COURSE40 = page40('861')

// 「认知实习」：唯一那条在历史作业区，作业时间 + 提交时间都印在同一页上
const COURSE124 = `<!DOCTYPE html><html><head><title>在线作业</title></head><body>
<div class="col-2 mr-2-box">
  <span class="text-muted"><strong><i class="fas fa-clock"></i> 当前作业</strong></span>
  <div class="list-group list-group-flush mb-4"></div>
  <span class="text-muted"><strong><i class="fas fa-history"></i> 历史作业</strong></span>
  <div class="list-group list-group-flush">
    <a href="index.jsp?courseID=124&assignID=802" class="list-group-item list-group-item-primary"> 2025级认知实习报告书 </a>
  </div>
</div>
<div class="col">
  <h4>2025级认知实习报告书</h4>
  <p> 作业时间：<b>2026-07-09 10:52:00</b> 至 <b>2026-07-16 18:00:00</b> </p>
  </td><td>100.00</td><td>初次提交时间: 2026-07-11 11:08:40&nbsp;&nbsp;&nbsp;最近一次提交时间: 2026-07-13 16:20:00
</div>
</body></html>`

// 一页里两条作业的时间各一段（以后平台改成全渲染也不怕）
const TWO_BLOCKS = `<div><h4>作业甲</h4><p>作业时间：<b>2026-10-01 08:00:00</b> 至 <b>2026-10-10 23:59:00</b></p></div>
<div><h4>作业乙</h4><p>作业时间：<b>2026-11-01 08:00:00</b> 至 <b>2026-11-20 12:30:00</b></p></div>`

// 服务端「当前选中的作业」——真机上由点击写入 session
let sessionAid = ''

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

    // 点作业：外壳照旧，但服务端记住「现在看的是哪条」
    if (p === '/index.jsp') {
      const m = /assignID=(\d+)/.exec(full)
      if (m) sessionAid = m[1]
      return reply(200, SHELL)
    }
    if (p === '/includes/redirect.jsp') {
      if (/tab=-2/.test(full) && /courseID=40/.test(full)) {
        return reply(200, page40(sessionAid || '861'))
      }
      if (/tab=-2/.test(full) && /courseID=124/.test(full)) {
        return reply(200, COURSE124)
      }
      if (/tab=-2/.test(full)) return reply(200, SHELL)
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

function ymd(ts) {
  if (!ts) return '0'
  const d = new Date(ts)
  const p2 = (n) => ('0' + n).slice(-2)
  return (
    d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes())
  )
}

function mkTask(aid, title) {
  return {
    externalId: 'educoder:assign:' + aid,
    courseId: '40',
    courseName: '离散数学',
    title: title,
    deadline: 0,
    url: 'http://10.67.4.14/index.jsp?courseID=40&assignID=' + aid
  }
}

async function main() {
  edu.saveCfg({ base: 'http://10.67.4.14', cookie: 'educg_session=SESS1A1B2C3', stid: '202515020339' })

  console.log('\n[1] 「作业时间：A 至 B」认得出，取 B')
  const b40 = edu.rangeBlocks(COURSE40)
  ok('识别出 1 段', b40.length === 1, b40.length)
  ok('截止取的是「至」后面那个（2026-11-07 23:59）', ymd(b40[0].end) === '2026-11-07 23:59', ymd(b40[0].end))
  ok('开始时间是 2026-10-26 20:00', ymd(b40[0].start) === '2026-10-26 20:00', ymd(b40[0].start))
  ok('这一段挂在前面的 <h4> 标题下', /序偶和关系/.test(b40[0].title), b40[0].title)

  console.log('\n[2] 必须绑到具体那条作业，不许一页共用')
  ok(
    '861（当前作业）绑得上',
    ymd(edu.deadlineForAssignment(COURSE40, '861', MATH[861].title)) === '2026-11-07 23:59',
    ymd(edu.deadlineForAssignment(COURSE40, '861', MATH[861].title))
  )
  ok(
    '858（同页但没渲染它的时间）绑不上，返回 0',
    edu.deadlineForAssignment(COURSE40, '858', MATH[858].title) === 0,
    ymd(edu.deadlineForAssignment(COURSE40, '858', MATH[858].title))
  )
  ok(
    '标题完全对不上时也不硬塞',
    edu.deadlineForAssignment(COURSE40, '999', '完全无关的作业名') === 0,
    ymd(edu.deadlineForAssignment(COURSE40, '999', '完全无关的作业名'))
  )

  console.log('\n[3] 提交时间不能当截止时间')
  ok(
    '整页只有 1 段作业时间时，用它',
    ymd(edu.deadlineFromHtml(COURSE124)) === '2026-07-16 18:00',
    ymd(edu.deadlineFromHtml(COURSE124))
  )
  ok(
    '没被「初次提交时间 2026-07-11」骗走',
    ymd(edu.deadlineFromHtml(COURSE124)) !== '2026-07-11 11:08',
    ymd(edu.deadlineFromHtml(COURSE124))
  )
  ok(
    '只有提交时间时返回 0',
    edu.deadlineFromHtml('<td>初次提交时间: 2026-07-11 11:08:40</td><td>最近一次提交时间: 2026-07-13 16:20:00</td>') === 0,
    ymd(edu.deadlineFromHtml('<td>初次提交时间: 2026-07-11 11:08:40</td><td>最近一次提交时间: 2026-07-13 16:20:00</td>'))
  )

  console.log('\n[4] 一页多段：通用解析不敢猜，按标题绑就行')
  ok('deadlineFromHtml 返回 0（分不清是谁的）', edu.deadlineFromHtml(TWO_BLOCKS) === 0, ymd(edu.deadlineFromHtml(TWO_BLOCKS)))
  ok('作业甲 → 2026-10-10 23:59', ymd(edu.deadlineForAssignment(TWO_BLOCKS, '', '作业甲')) === '2026-10-10 23:59', ymd(edu.deadlineForAssignment(TWO_BLOCKS, '', '作业甲')))
  ok('作业乙 → 2026-11-20 12:30', ymd(edu.deadlineForAssignment(TWO_BLOCKS, '', '作业乙')) === '2026-11-20 12:30', ymd(edu.deadlineForAssignment(TWO_BLOCKS, '', '作业乙')))

  console.log('\n[5] 详情页候选：先点一下作业，再读在线作业页')
  const cands = edu.detailCandidates(mkTask('861', MATH[861].title))
  ok(
    '第一个是「先点作业再读在线作业页」',
    /redirect\.jsp\?tab=-2&courseID=40/.test(cands[0].url) && /assignID=861/.test(cands[0].prelude || ''),
    { url: cands[0].url, prelude: cands[0].prelude }
  )
  ok('第二种是 redirect.jsp?tab=-2 + 作业号', /redirect\.jsp\?tab=-2&courseID=40&assignID=861/.test(cands[1].url), cands[1].url)
  ok('列表给的原始地址也还在（别的平台靠它）', cands.some((c) => /^http:\/\/10\.67\.4\.14\/index\.jsp\?/.test(c.url)), cands.map((c) => c.url))
  ok('有 POST main.jsp 这条路（外壳里 form 的目标）', cands.some((c) => c.method === 'POST'), cands.map((c) => c.method))

  console.log('\n[6] 端到端：当前那条一次绑上，别人的先点一下再绑')
  requests.length = 0
  sessionAid = ''
  const tasks = [mkTask('861', TITLES[861]), mkTask('858', TITLES[858]), mkTask('857', TITLES[857])]
  const trace = []
  const got = await edu.fillDeadlines(tasks, trace)
  ok('补上 2 条（861 直接绑，858 点一下之后绑）', got === 2, got)
  ok('861 拿到 2026-11-07 23:59', ymd(tasks[0].deadline) === '2026-11-07 23:59', ymd(tasks[0].deadline))
  ok('858 拿到自己的 2026-11-20 23:59，不是 861 的', ymd(tasks[1].deadline) === '2026-11-20 23:59', ymd(tasks[1].deadline))
  ok('857（服务器不渲染它的时间）保持 0，不瞎填', tasks[2].deadline === 0, ymd(tasks[2].deadline))
  ok(
    '轨迹里写清了绑上几条',
    /课程 40：3 条缺日期，页面作业时间 1 段，绑上 1 条/.test(trace.join('；')),
    trace.filter((x) => /在线作业页/.test(x))
  )
  ok(
    '找到有效写法就固定用它',
    /✓ 详情页有效写法：先点作业再读在线作业页/.test(trace.join('；')),
    trace.filter((x) => /有效写法/.test(x))
  )
  ok('请求数受控（≤ 9 次）', requests.length <= 9, requests.length)

  console.log('\n[7] 全都绑不上时说清楚，不再空跑')
  requests.length = 0
  sessionAid = ''
  const lost = [mkTask('857', TITLES[857]), mkTask('900', '查无此作业')]
  const trace2 = []
  const got2 = await edu.fillDeadlines(lost, trace2)
  ok('一条都没补上', got2 === 0, got2)
  ok('明说「都绑不上」', /种详情页写法都没绑上/.test(trace2.join('；')), trace2.filter((x) => /绑不上/.test(x)))
  ok('并解释这是平台的限制', /没有单独时间可读/.test(trace2.join('；')), trace2.filter((x) => /可读/.test(x)))
  ok('没有对第 2 条重复探路（请求 ≤ 9）', requests.length <= 9, requests.length)

  console.log('\n[8] 外壳页本身不给日期')
  ok('20852 字节的外壳 → 0', edu.deadlineFromHtml(SHELL) === 0, ymd(edu.deadlineFromHtml(SHELL)))

  console.log('\n----------------------------------------')
  console.log('通过 ' + pass + '，失败 ' + fail)
  if (fail) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
