/**
 * 本地代理服务的集成测试。
 *
 * 真的把 server.js 拉起来（用 7799 端口，不冲突），逐个打接口。
 * 全部走「无登录态 / 假 token」路径，不会访问学习通，离线可跑。
 */
const { spawn } = require('child_process')
const path = require('path')

const PORT = 7799
const BASE = 'http://127.0.0.1:' + PORT
const SERVER = path.join(__dirname, '..', 'localserver', 'server.js')

let pass = 0
let fail = 0

function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + (extra ? '  → ' + extra : ''))
  }
}

function get(p) {
  return fetch(BASE + p).then((r) => r.json())
}

function post(p, body) {
  return fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  }).then((r) => r.json())
}

async function waitReady(times) {
  for (let i = 0; i < (times || 40); i++) {
    try {
      const r = await get('/ping')
      if (r && r.pong) return true
    } catch (e) {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

async function main() {
  console.log('\n本地代理服务测试（端口 ' + PORT + '）\n')

  const TMP = path.join(__dirname, '.tmp-test-session.json')
  try {
    require('fs').unlinkSync(TMP)
  } catch (e) {
    /* 本来就没有 */
  }

  const child = spawn(process.execPath, [SERVER, String(PORT)], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    // 用独立的会话文件，否则会读到开发者本机真实的 session.json，
    // 「初始没有本地会话」这类断言就不成立了
    env: Object.assign({}, process.env, {
      CX_SESSION_FILE: path.join(__dirname, '.tmp-test-session.json')
    })
  })

  let logs = ''
  child.stdout.on('data', (d) => (logs += d.toString()))
  child.stderr.on('data', (d) => (logs += d.toString()))

  try {
    const ready = await waitReady()
    ok('服务在 1 秒内启动完成', ready, logs.slice(0, 200))
    if (!ready) throw new Error('服务没起来：' + logs.slice(0, 400))

    // 1. 基础接口
    const ping = await get('/ping')
    ok('/ping 返回 pong', ping.ok === true && ping.pong === true)
    ok('/ping 带版本号', typeof ping.version === 'string' && ping.version.length > 0)

    const status = await get('/status')
    ok('/status 正常返回', status.ok === true && Array.isArray(status.sessions))
    ok('初始没有本地会话', status.sessions.length === 0)

    // 2. 浏览器控制台页面
    const htmlRes = await fetch(BASE + '/')
    const html = await htmlRes.text()
    ok('控制台页面返回 200', htmlRes.status === 200)
    ok(
      '控制台有扫码与抓取按钮',
      html.indexOf('/cx/qr/start') > -1 &&
        html.indexOf('/cx/courses') > -1 &&
        html.indexOf('/cx/sync') > -1
    )

    // 3. 没登录态时的报错必须是人话
    const noCookieCourses = await post('/cx/courses')
    ok('无登录态抓课程被拒绝', noCookieCourses.ok === false)
    ok(
      '提示让用户先扫码',
      /扫码登录/.test(noCookieCourses.error || ''),
      noCookieCourses.error
    )

    const noCookieSync = await post('/cx/sync')
    ok('无登录态抓任务被拒绝', noCookieSync.ok === false)
    ok('抓任务同样提示先扫码', /扫码登录/.test(noCookieSync.error || ''), noCookieSync.error)

    // 4. 假 token 不该 500，要给出可读状态
    const badPoll = await post('/cx/qr/poll', { token: 'bogus-token' })
    ok('假 token 不抛异常', badPoll.ok === true)
    ok('假 token 返回 expired', badPoll.state === 'expired', JSON.stringify(badPoll))
    ok('expired 带提示文案', !!(badPoll.message || '').length)

    // 5. 未知 sid
    const badSid = await post('/cx/courses', { sid: 'not-exist' })
    ok('未知 sid 被拒绝', badSid.ok === false)
    ok('未知 sid 提示重新扫码', /会话不存在|重新扫码/.test(badSid.error || ''), badSid.error)

    // 6. 路由兜底
    const notFound = await get('/whatever')
    ok('未知路由返回 404 语义', notFound.ok === false && /没有这个接口/.test(notFound.error || ''))

    // 7. 教务接口：不联网也要给出人话（用 127.0.0.1:1 当「连不上」的靶子）
    const jwSt = await get('/jw/status')
    ok('/jw/status 初始未登录', jwSt.ok === true && jwSt.loggedIn === false, JSON.stringify(jwSt))

    const jwNoCred = await post('/jw/auto', {})
    ok('教务自动登录要求填学号密码', jwNoCred.ok === false && /学号/.test(jwNoCred.error || ''), jwNoCred.error)

    const jwDead = await post('/jw/auto', {
      base: 'http://127.0.0.1:1',
      username: 'x',
      password: 'y'
    })
    ok(
      '教务连不上时返回可读提示而不是抛异常',
      jwDead.ok === true && jwDead.success === false && jwDead.stage === 'probe' && (jwDead.message || '').length > 5,
      JSON.stringify(jwDead).slice(0, 160)
    )

    const jwParse = await post('/jw/parse', {
      html:
        '<table><tr><td><div class="timetable_con">' +
        '<span class="title">汇编语言</span>' +
        '<p class="festival">周四第1,2节{第1-16周}</p><p>松园3-201</p>' +
        '</div></td></tr></table>'
    })
    ok(
      '离线解析认得出教务课表',
      jwParse.ok === true && jwParse.success === true && jwParse.count === 1,
      JSON.stringify(jwParse).slice(0, 160)
    )
    ok(
      '解析结果带星期/节次/地点',
      jwParse.count === 1 && jwParse.items[0].day === 4 && jwParse.items[0].start === 1 && jwParse.items[0].place === '松园3-201',
      JSON.stringify(jwParse.items && jwParse.items[0])
    )

    const jwBye = await post('/jw/logout')
    ok('清教务登录态正常', jwBye.ok === true && jwBye.cleared === true)

    // 8. CORS（浏览器手工调时需要）
    const opt = await fetch(BASE + '/ping', { method: 'OPTIONS' })
    ok('OPTIONS 预检放行', opt.status === 204)
    ok(
      '响应带跨域头',
      (opt.headers.get('access-control-allow-origin') || '') === '*'
    )

    // 8. 抓取逻辑复用云函数模块（不是另写一份）
    const src = require('fs').readFileSync(SERVER, 'utf8')
    ok('复用 cloudfunctions 的 qrlogin', src.indexOf("'lib', 'qrlogin'") > -1 || src.indexOf("lib/qrlogin") > -1)
    ok('复用 cloudfunctions 的 chaoxing 适配器', src.indexOf("'adapters', 'chaoxing'") > -1 || src.indexOf("adapters/chaoxing") > -1)

    // 9. 会话存档文件不该有明文 cookie 泄漏到 stdout
    ok('启动日志不打印 cookie 值', !/_uid=[0-9a-zA-Z]/.test(logs))
  } catch (e) {
    fail++
    console.log('  ✗ 异常：' + e.message)
  } finally {
    child.kill()
    // Windows 上子进程可能不响应 SIGTERM，兜一下
    setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch (e) {
        /* 已经退了 */
      }
      try {
        require('fs').unlinkSync(TMP)
      } catch (e) {
        /* 没生成就算了 */
      }
    }, 600)
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项\n')
  process.exit(fail ? 1 : 0)
}

main()
