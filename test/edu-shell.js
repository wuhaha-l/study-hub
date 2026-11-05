/**
 * 希冀「外壳页」：学生首页是个框架页，课程不在首页里。
 *
 * 真机实测（2026-10-26 第二次探测）：登录后 `/indexcs/simple.jsp` 是
 * 20852 字节的「计算机类课程一体化平台」，但首页上只有 4 个链接：
 *   · （无文字）→ /index.jsp     · GitLab → /gitlab/index.jsp
 *   · 个人信息 → /includes/redirect.jsp?tab=-6
 *   · 希冀课堂使用帮助 → docs.educg.net/...
 * 外加 `form /main.jsp`、`iframe`（空）、`IFRAME /includes/stayalive.jsp`。
 * 老代码只数 `<a href>`，于是「没找到像课程/作业的链接」，一门课都认不出来。
 *
 * 这个测试把那套结构原样搭出来：课程在 /main.jsp 的表格里，作业页是
 * `/courselist.jsp?courseID=N`（首页在 /indexcs/ 下，但课程的相对地址是相对
 * 站点根目录的，`/indexcs/courselist.jsp` 一定 404 —— 这个坑必须自己试出来）。
 *
 * 运行：node test/edu-shell.js
 */
const path = require('path')
const ROOT = path.join(__dirname, '..')

const store = {}
const requests = []

// 首页：只有导航，没有课程
const SHELL_HTML = `<!DOCTYPE html><html><head><title>计算机类课程一体化平台</title></head><body>
<form name="top" action="/main.jsp" method="post" target="mainFrame">
<input type="hidden" name="tab" value="1" />
</form>
<iframe name="mainFrame" src=""></iframe>
<IFRAME src="/includes/stayalive.jsp" width="0" height="0"></IFRAME>
<a href="/index.jsp"></a>
<a href="/gitlab/index.jsp">GitLab</a>
<a href="/includes/redirect.jsp?tab=-6">个人信息</a>
<a href="https://docs.educg.net/web/#/119?page_id=1417">希冀课堂使用帮助</a>
<div class="copyright">© 希冀教育</div>
</body></html>`

// 真正的课程列表在 main.jsp 里
const MAIN_HTML = `<!DOCTYPE html><html><head><title>我的课程</title></head><body>
<table class="clist">
<tr><th>课程名称</th><th>教师</th><th>操作</th></tr>
<tr><td><a href="courselist.jsp?courseID=40">离散数学</a></td><td>王老师</td><td>进入</td></tr>
<tr><td><a href="courselist.jsp?courseID=115">2025级高级语言程序设计实验（报告提交）</a></td><td>穆老师</td><td>进入</td></tr>
<tr><td><a href="courselist.jsp?courseID=124">认知实习</a></td><td>李老师</td><td>进入</td></tr>
</table></body></html>`

const COURSE_40 = `<!DOCTYPE html><html><head><title>离散数学</title></head><body>
<table class="list">
<tr><th>作业名称</th><th>截止时间</th><th>状态</th></tr>
<tr><td><a href="jobdetail.jsp?jobID=1001">第1章 命题逻辑</a></td><td>2026-11-01 23:59</td><td>未提交</td></tr>
<tr><td><a href="jobdetail.jsp?jobID=1002">第2章 谓词逻辑</a></td><td>2026-11-08 23:59</td><td>已提交</td></tr>
</table></body></html>`

// 站点的软 404：HTTP 200 也可能是「找不到页面」
const SOFT_404 = `<!DOCTYPE html><html><head><title>404 Not Found</title></head><body>
<h1>404 Not Found</h1><p>页面不存在</p>${'<!-- pad -->'.repeat(30)}</body></html>`

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

    if (p === '/indexcs/simple.jsp' || p === '/') return reply(200, SHELL_HTML)
    if (p === '/main.jsp') return reply(200, MAIN_HTML)
    if (p === '/login/loginproc.jsp') return reply(200, '<html><input id="captchaCode"></html>')
    // 站点根下的才是对的
    if (p === '/courselist.jsp') return reply(200, /courseID=40/.test(full) ? COURSE_40 : SOFT_404)
    // /indexcs/courselist.jsp 不存在
    if (p === '/indexcs/courselist.jsp') return reply(404, SOFT_404)
    return reply(404, SOFT_404)
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

  console.log('\n[1] 探测：首页是外壳，要顺着 form / iframe 往下摸')
  const lines = await edu.probe()
  const text = lines.join('\n')
  console.log(text)
  console.log('')
  ok('认出首页是「计算机类课程一体化平台」', /计算机类课程一体化平台/.test(text))
  ok('往下摸到了 /main.jsp', /\/main\.jsp → 200/.test(text), lines.filter((l) => /main\.jsp/.test(l)))
  ok('摸到 3 门课程', /摸到 3 门课程/.test(text), lines.filter((l) => /摸到|没摸到/.test(l)))
  ok('课程名从表格里读出来了', /离散数学/.test(text))
  ok(
    '第一门实测走的是站点根下的 /courselist.jsp',
    /第一门实测：✅ \/courselist\.jsp\?courseID=40/.test(text),
    lines.filter((l) => /第一门实测/.test(l))
  )
  ok(
    '没把 404 的 /indexcs/courselist.jsp 当成功',
    !/✅ \/indexcs\/courselist\.jsp/.test(text),
    lines.filter((l) => /✅/.test(l))
  )
  ok(
    '保活页 /includes/stayalive.jsp 不去碰（走了也白走）',
    requests.every((u) => u.indexOf('stayalive') < 0),
    requests.filter((u) => /stayalive/.test(u))
  )

  console.log('\n[2] 同步：外壳页也要能把作业同步下来')
  requests.length = 0
  const r = await edu.sync()
  console.log('轨迹：' + r.trace.join('；'))
  ok('同步出 2 条作业', r.tasks.length === 2, r.tasks.map((t) => t.title))
  ok('课程名对得上', r.tasks[0].courseName === '离散数学', r.tasks[0].courseName)
  ok(
    '作业链接拼成绝对地址',
    r.tasks[0].url === 'http://10.67.4.14/jobdetail.jsp?jobID=1001',
    r.tasks[0].url
  )
  ok('轨迹里写明是从页面认出的课程', /从页面认出 3 门课程/.test(r.trace.join('；')), r.trace)
  ok('已提交的那条状态是 done', r.tasks[1].status === 'done', r.tasks[1].status)
  ok(
    '课程页只请求正确的那个地址',
    requests.filter((u) => u.indexOf('/indexcs/courselist.jsp') === 0).length <= 1,
    requests.filter((u) => /courselist/.test(u))
  )

  console.log('\n[3] 摸不到课程时：说清楚走过哪些路')
  global.wx.request = function (opt) {
    const full = String(opt.url || '').replace(/^https?:\/\/[^/]+/, '')
    const p = full.split('?')[0]
    requests.push(full)
    const reply = (status, body) =>
      setTimeout(() => opt.success({ statusCode: status, data: body, header: {} }), 0)
    if (p === '/indexcs/simple.jsp' || p === '/') return reply(200, SHELL_HTML)
    // 这次 /main.jsp 也是空的
    return reply(404, SOFT_404)
  }
  const lines2 = await edu.probe()
  const text2 = lines2.join('\n')
  ok('明说没摸到课程', /没摸到课程/.test(text2))
  ok('把走过的地址列出来（带状态码）', /· form \/main\.jsp → 404/.test(text2), lines2.filter((l) => /main\.jsp/.test(l)))
  ok('把首页出现过的 .jsp 列出来', /首页里出现过的 \.jsp/.test(text2))

  console.log('\n[4] main.jsp 自己也是框架页：课程在它的 iframe 里')
  global.wx.request = function (opt) {
    const full = String(opt.url || '').replace(/^https?:\/\/[^/]+/, '')
    const p = full.split('?')[0]
    requests.push(full)
    const reply = (status, body) =>
      setTimeout(() => opt.success({ statusCode: status, data: body, header: {} }), 0)
    if (p === '/indexcs/simple.jsp' || p === '/') return reply(200, SHELL_HTML)
    // 两层框架：main.jsp 只有 frameset，课程在它指向的 left.jsp 里
    if (p === '/main.jsp') {
      return reply(
        200,
        `<!DOCTYPE html><html><head><title>main</title></head><frameset cols="220,*">
<frame name="left" src="/indexcs/left.jsp" /><frame name="right" src="/indexcs/right.jsp" />
</frameset></html>`
      )
    }
    if (p === '/indexcs/left.jsp') return reply(200, MAIN_HTML)
    if (p === '/indexcs/right.jsp') return reply(200, '<html><body><p>欢迎</p></body></html>')
    if (p === '/courselist.jsp') return reply(200, /courseID=40/.test(full) ? COURSE_40 : SOFT_404)
    return reply(404, SOFT_404)
  }
  requests.length = 0
  const r2 = await edu.sync()
  console.log('轨迹：' + r2.trace.join('；'))
  ok('两层框架页也摸到了课程', /从页面认出 3 门课程/.test(r2.trace.join('；')), r2.trace)
  ok('同步出 2 条作业', r2.tasks.length === 2, r2.tasks.map((t) => t.title))
  ok(
    '第二层的相对地址也试对了（/courselist.jsp）',
    r2.tasks[0] && r2.tasks[0].url === 'http://10.67.4.14/jobdetail.jsp?jobID=1001',
    r2.tasks[0] && r2.tasks[0].url
  )

  console.log('\n----------------------------------------')
  console.log('通过 ' + pass + '，失败 ' + fail)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('测试崩了：', e)
  process.exit(1)
})
