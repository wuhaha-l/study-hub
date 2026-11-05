/**
 * 希冀探测：相对链接到底该拼到哪个目录。
 *
 * 起因（真机实测）：学生首页上的链接是相对地址
 *   `courselist.jsp?courseID=40`
 * 老代码一律当成 `/indexcs/courselist.jsp?courseID=40`，整排 404：
 *   · /indexcs/courselist.jsp?courseID=40 → HTTP 404
 *   · /indexcs/courselist.jsp?courseID=115 → HTTP 404
 * 所以这里用一台「假希冀」把那个现象原样复现：只有 `/courselist.jsp` 是对的，
 * `/indexcs/courselist.jsp` 一定 404。探测必须自己试出来，并沿用正确拼法。
 *
 * 运行：node test/edu-probe.js
 */
const path = require('path')
const ROOT = path.join(__dirname, '..')

const store = {}
const requests = []

const HOME_HTML = `<!DOCTYPE html><html><head><title></title></head><body>
<div id="menu">
<a href="courselist.jsp?courseID=40">离散数学</a>
<a href="courselist.jsp?courseID=115">2025级高级语言程序设计实验（报告提交）</a>
<a href="courselist.jsp?courseID=124">认知实习</a>
<a href="javascript:void(0)">帮助</a>
</div></body></html>`

const COURSE_HTML = `<!DOCTYPE html><html><head><title>离散数学</title></head><body>
<table class="list">
<tr><th>作业名称</th><th>截止时间</th></tr>
<tr><td><a href="jobdetail.jsp?jobID=1001">第1章 命题逻辑</a></td><td>2026-11-01 23:59</td></tr>
<tr><td><a href="jobdetail.jsp?jobID=1002">第2章 谓词逻辑</a></td><td>2026-11-08 23:59</td></tr>
</table></body></html>`

const NOT_FOUND = `<!DOCTYPE html><html><head><title>404 Not Found</title></head><body>
<h1>404 Not Found</h1><p>The requested URL was not found on this server.</p>
<hr><address>Apache Server at 10.67.4.14 Port 80</address>
${'<!-- padding -->'.repeat(40)}</body></html>`

const LOGIN_HTML = `<!DOCTYPE html><html><head><title></title></head><body>
<form action="/login/loginproc.jsp" method="post">
<input name="stid" /><input name="pwd" type="password" />
<input id="captchaCode" name="captchaCode" /><img src="/cgjiaoyan" />
</form></body></html>`

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
    const url = String(opt.url || '')
    const full = url.replace(/^https?:\/\/[^/]+/, '')
    const p = full.split('?')[0]
    requests.push(full)

    const reply = (status, body) => {
      setTimeout(() => {
        opt.success({ statusCode: status, data: body, header: {} })
      }, 0)
    }
    if (p === '/indexcs/simple.jsp' || p === '/') return reply(200, HOME_HTML)
    if (p === '/login/loginproc.jsp') return reply(200, LOGIN_HTML)
    if (p === '/api') {
      return setTimeout(() => {
        opt.success({
          statusCode: 401,
          data: '{"error":"Unauthorized","message":"missing token"}',
          header: {}
        })
      }, 0)
    }
    // 真机上这两个都 404，就是它们把整排结果刷成 404 的
    if (p === '/indexcs/courselist.jsp') return reply(404, NOT_FOUND)
    if (p === '/courselist.jsp') return reply(200, COURSE_HTML)
    return reply(404, NOT_FOUND)
  }
}

const edu = require(path.join(ROOT, 'miniprogram', 'utils', 'edu'))

/* ---------------- 迷你断言 ---------------- */

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
  requests.length = 0

  const lines = await edu.probe()
  const text = lines.join('\n')
  console.log(text)
  console.log('')

  console.log('[1] 首页链接与拼法')
  ok(
    '首页按实际地址报出来',
    lines.some((l) => /^学生首页 \/indexcs\/simple\.jsp/.test(l)),
    lines.filter((l) => /学生首页/.test(l))
  )
  ok('首页链接照原样列出（相对地址）', /courselist\.jsp\?courseID=40/.test(text))

  console.log('\n[2] 相对链接：试到对的那个目录')
  ok(
    '识别出 /courselist.jsp 才是对的',
    /✅ \/courselist\.jsp\?courseID=40/.test(text),
    lines.filter((l) => /courseID=40/.test(l))
  )
  ok(
    '没把 404 的 /indexcs/ 当成成功',
    !/✅ \/indexcs\/courselist\.jsp/.test(text),
    lines.filter((l) => /✅/.test(l))
  )
  ok(
    '后面的课程沿用同一种拼法（不再重复试错）',
    // 补扫（换课程）会再碰一次第一门的另一种写法，但第二门课必须直接用对的拼法，
    // 不许再拿 404 的 /indexcs/ 试一遍
    /✅ \/courselist\.jsp\?courseID=115/.test(text) &&
      requests.filter((u) => u.indexOf('/indexcs/courselist.jsp?courseID=115') === 0).length === 0,
    requests.filter((u) => /courselist/.test(u))
  )

  console.log('\n[3] 命中页面的结构线索（写解析器要用）')
  ok('列出命中页里的链接', /页面里的链接/.test(text))
  ok('作业入口连 href 一起给出来', /jobdetail\.jsp\?jobID=1001/.test(text))
  ok('给出正文节选', /文字节选：/.test(text) && /命题逻辑/.test(text))
  ok('表格规模报出来（tr/td/li）', /tr 3 td 4 li 0/.test(text), lines.filter((l) => /✅/.test(l)))

  console.log('\n[4] 其它探针不受影响')
  ok('/api 的 401 照旧报出来', /token 接口 \/api：HTTP 401/.test(text))
  ok('站点首页照旧报出来', /站点首页 \/：HTTP 200/.test(text))

  console.log('\n----------------------------------------')
  console.log('通过 ' + pass + '，失败 ' + fail)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('测试崩了：', e)
  process.exit(1)
})
