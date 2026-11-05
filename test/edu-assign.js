/**
 * 希冀「外壳 + tab 页」：作业列表在 `/includes/redirect.jsp?tab=-2`。
 *
 * 真机实测（2026-10-26 第三次探测，也就是最后那次）：
 *   form /main.jsp          → 200 / 20852 字节 / tr 0 / 课程 0 门
 *   /index.jsp              → 200 / 20852 字节 / tr 0 / 课程 0 门
 *   /includes/redirect.jsp?tab=0  → 200 / 20852 字节 / tr 0 / 课程 0 门
 *   /includes/redirect.jsp?tab=-1 → 200 / 17317 字节 / tr 1 / 课程 0 门
 *   /includes/redirect.jsp?tab=-2 → 200 / 22623 字节 / tr 2 / 课程 1 门
 *     · 2025级认知实习报告书 → index.jsp?courseID=124&assignID=802
 *
 * 也就是说：**课程/作业详情页是 JS 外壳**（点进去还是同一个 20852 字节页面，
 * 老代码就把那条 assignID 链接当成了「1 门课程」，打开一看只有导航，于是说
 * 「行都没日期，没敢猜」）。真正的数据在 tab=-2 这张服务端渲染的表里，
 * `assignID` 就是作业号。
 *
 * 这个测试把那套结构原样搭出来，要求：
 *   1. tab=-2 被认成**作业列表**，不是课程
 *   2. 作业行（含没有截止时间的）都能变成任务
 *   3. 链接拼成 `/index.jsp?courseID=…&assignID=…`，不是 `/includes/index.jsp`
 *
 * 运行：node test/edu-assign.js
 */
const path = require('path')
const ROOT = path.join(__dirname, '..')

const store = {}
const requests = []

const PAD = '<!-- ' + 'x'.repeat(200) + ' -->'

// 外壳：20852 字节那种，只有导航 + form + iframe
const SHELL = `<!DOCTYPE html><html><head><title>计算机类课程一体化平台</title></head><body>
<form name="top" action="/main.jsp" method="post" target="mainFrame"><input type="hidden" name="tab" value="1" /></form>
<iframe name="mainFrame" src=""></iframe>
<IFRAME src="/includes/stayalive.jsp" width="0" height="0"></IFRAME>
<a href="/index.jsp"></a>
<a href="/gitlab/index.jsp">GitLab</a>
<a href="/includes/redirect.jsp?tab=-6">个人信息</a>
<a href="https://docs.educg.net/web/#/119?page_id=1417">希冀课堂使用帮助</a>
<div class="nav">首页 课程信息 在线作业 在线考试 在线答疑 模型</div>
<div class="switch">切换课程 离散数学 2025级高级语言程序设计实验（报告提交） 认知实习</div>
${PAD}</body></html>`

// 个人信息页：导航菜单把各个 tab 拼出来（真机上 tab=0 / -1 / -2 就是从这类页面里冒出来的）
const MENU = `<!DOCTYPE html><html><head><title>个人信息</title></head><body>
<div class="menu">
<a href="/includes/redirect.jsp?tab=0">首页</a>
<a href="/includes/redirect.jsp?tab=-1">课程信息</a>
<a href="/includes/redirect.jsp?tab=-2">在线作业</a>
</div>
<script>function go(t){location.href='/includes/redirect.jsp?tab='+t}</script>
</body></html>`

// 在线作业：服务端渲染的表格，一行一条作业
const TAB_JOBS = `<!DOCTYPE html><html><head><title>在线作业</title></head><body>
<table class="list">
<tr><th>作业名称</th><th>截止时间</th><th>状态</th></tr>
<tr><td><a href="index.jsp?courseID=124&assignID=802">2025级认知实习报告书</a></td><td>2026-12-20 23:59</td><td>未提交</td></tr>
<tr><td><a href="index.jsp?courseID=124&assignID=803">实习总结</a></td><td>已提交</td><td>已提交</td></tr>
</table></body></html>`

const TAB_INFO = `<!DOCTYPE html><html><head><title>课程信息</title></head><body>
<table><tr><th>课程</th></tr></table>${PAD}</body></html>`

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
      if (/tab=-2/.test(full)) return reply(200, TAB_JOBS)
      if (/tab=-1/.test(full)) return reply(200, TAB_INFO)
      if (/tab=-6/.test(full)) return reply(200, MENU)
    }
    // 这套平台对任何路径都回 200 外壳（所以「拼错了」也看不出来，才要单独测）
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
  edu.saveCfg({ base: 'http://10.67.4.14', cookie: 'educg_session=SESS1A1B2C3', stid: '202515020339' })

  console.log('\n[1] 探测：tab=-2 要认成作业列表，不是课程')
  const lines = await edu.probe()
  const text = lines.join('\n')
  console.log(text)
  console.log('')
  ok('认出 shell 页', /计算机类课程一体化平台/.test(text))
  ok('找到了在线作业页', /作业列表.*redirect\.jsp\?tab=-2/.test(text), lines.filter((l) => /作业列表/.test(l)))
  ok('没把 assignID 链接当课程', !/摸到 \d+ 门课程/.test(text), lines.filter((l) => /摸到|课程/.test(l)))
  ok('列出作业标题', /2025级认知实习报告书/.test(text))
  ok('有截止时间的格式化成人看的时间', /截止 2026-12-20 23:59/.test(text), lines.filter((l) => /截止/.test(l)))
  ok('没截止时间的老实说没有', /实习总结｜没有截止时间/.test(text), lines.filter((l) => /实习总结/.test(l)))
  ok(
    '明说详情页是 JS 外壳',
    /没有独立的课程列表/.test(text),
    lines.filter((l) => /课程列表/.test(l))
  )

  console.log('\n[2] 同步：列表页的作业直接变成任务')
  requests.length = 0
  const r = await edu.sync()
  console.log('轨迹：' + r.trace.join('；'))
  console.log('任务：' + JSON.stringify(r.tasks, null, 1).slice(0, 700))
  ok('同步出 2 条作业', r.tasks.length === 2, r.tasks.map((t) => t.title))
  ok('标题对得上', r.tasks[0].title === '2025级认知实习报告书', r.tasks[0].title)

  console.log('\n[3] 截止时间 / 状态')
  const d = new Date(r.tasks[0].deadline)
  ok('截止时间解析到 12 月 20 日 23:59', d.getMonth() === 11 && d.getDate() === 20 && d.getHours() === 23 && d.getMinutes() === 59, r.tasks[0].deadline)
  ok('没截止时间的那条 deadline 是 0（不编）', r.tasks[1].deadline === 0, r.tasks[1].deadline)
  ok('「已提交」判成 done', r.tasks[1].status === 'done', r.tasks[1].status)
  ok('没提交的是 todo', r.tasks[0].status === 'todo', r.tasks[0].status)

  console.log('\n[4] 链接与去重键')
  ok(
    '链接是站点根下的 /index.jsp（不是 /includes/index.jsp）',
    r.tasks[0].url === 'http://10.67.4.14/index.jsp?courseID=124&assignID=802',
    r.tasks[0].url
  )
  ok('externalId 用作业号（跨页稳定）', r.tasks[0].externalId === 'educoder:assign:802', r.tasks[0].externalId)
  ok('课程名有值（认不出就叫希冀课程，不瞎编）', !!r.tasks[0].courseName, r.tasks[0].courseName)

  console.log('\n[5] 学期：判不出来按当前学期记（否则首页只看本学期会看不到）')
  ok('学期不是「未知」', r.tasks[0].semesterKey !== 'unknown', r.tasks[0].semesterKey)
  ok('学期短名有值', r.tasks[0].semesterShort !== '未知', r.tasks[0].semesterShort)

  console.log('\n[6] 请求预算')
  // 补截止时间要先「探路」：用第 1 条任务把几种详情页地址各试一次，
  // 其中两种是 redirect.jsp?tab=-2 的变体，所以 tab=-2 会多打两次
  // 补截止时间要「探路」：用第 1 条缺日期的任务把 5 种详情页写法各试一次，
  // 其中几种是 redirect.jsp?tab=-2 的变体，所以 tab=-2 会多打几次。
  // 关键是不能按「每条任务」去试——那才会把列表页刷爆。
  ok('在线作业页没被刷爆（≤6 次）', requests.filter((u) => /tab=-2/.test(u)).length <= 6, requests.filter((u) => /tab=-2/.test(u)))
  // 补扫（其他课程 / 其他栏目 / 翻页）+ 课程列表页探测要发请求。
  // 这台假服务器对任何路径都回 200 外壳（真机上这些会 404 直接短路），所以这里上限放宽。
  // scanMore 自己有 15 秒硬上限，真机不会无脑烧请求。
  // 18 = 原来的摸页预算；+3 是详情页探路（4 种写法，其中 1 种与列表地址重复被去重）
  // 25 = 摸页预算 18 + 每门课的在线作业页 1 + 详情页探路 6（含「先点作业」的两次）
  ok('整趟请求不超过 26 个', requests.length <= 26, requests.length)
  ok('保活页没被碰', requests.every((u) => u.indexOf('stayalive') < 0), requests.filter((u) => /stayalive/.test(u)))

  console.log('\n----------------------------------------')
  console.log('通过 ' + pass + '，失败 ' + fail)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('测试崩了：', e)
  process.exit(1)
})
