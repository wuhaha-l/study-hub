/**
 * 希冀（educg · 校园内网）登录链路自检
 *
 * 跑法：node test/edu-login.js
 *
 * 这里不连真服务器，而是用一台「假希冀」模拟这套 JSP 平台的行为：
 *   GET /                      → 下发 educg_session
 *   GET /cgjiaoyan             → 验证码图片（gif）
 *   POST /login/loginproc.jsp  → 校验验证码 + 解密密码，对了才放行
 *   GET /indexcs/simple.jsp    → 登录了给首页，没登录给登录表单
 *
 * 验的是四件事：
 *   1. AES-128-ECB 算出来跟 Node crypto 一模一样（差一个字节密码就登不上）
 *   2. 微信那个「多个 Set-Cookie 用逗号拼一起」的坑能正确拆开（Expires 里也有逗号）
 *   3. 学号 + 密码 + 验证码 这条路真的能拿到会话，且失败时把人话提示带出来
 *   4. 密码落本地存储时不是明文
 */
const path = require('path')
const crypto = require('crypto')
const ROOT = path.join(__dirname, '..')

/* ------------------------------------------------------------------ */
/* 内存版 wx 存储                                                      */
/* ------------------------------------------------------------------ */
const store = {}
let requests = []

/* ------------------------------------------------------------------ */
/* 假希冀服务器                                                        */
/* ------------------------------------------------------------------ */
const AES_KEY = 'Client8Sess!06ID'
const GOOD_STID = '202515020339'
const GOOD_PWD = 'MyPwd123'

const LOGIN_HTML = `<!DOCTYPE html><html><head><title></title></head><body>
<div class="err">验证码错误！</div>
<form class="forms" name="loginForm" action="/login/loginproc.jsp" method="post">
  <input name="IndexStyle" type="hidden" value="1">
  <input name="stid" type="text" placeholder="学号" id="username" required />
  <input name="pwd" type="password" placeholder="密码" id="password" required />
  <input id="captchaCode" type="text" name="captchaCode" placeholder="请输入验证码" required />
  <img src="/cgjiaoyan" />
</form></body></html>`

const HOME_HTML = `<!DOCTYPE html><html><head><title>计算机类课程一体化平台</title></head><body>
<nav><a href="/indexcs/simple.jsp">首页</a>
<a href="/courseinfo/courseindex.jsp?courseid=8801">数据结构与算法</a>
<a href="/courseinfo/courseindex.jsp?courseid=8802">计算机网络</a>
<a href="/studentinfo/stuinfo.jsp">个人信息</a>
<a href="javascript:void(0)">无效链接</a>
<a href="/logout.jsp">退出</a></nav></body></html>`

const SERVER = {
  seq: 0,
  sessions: {}, // sid -> { logged, captcha }
  rotateOnLogin: true
}

function newSid() {
  SERVER.seq++
  return 'SESS' + SERVER.seq + 'A1B2C3'
}

function setCookieHeader(sid) {
  // 故意模仿微信：多个 Set-Cookie 用逗号拼成一个串，而 Expires 自己就带逗号
  return [
    'lang=zh-CN; Expires=Mon, 02-Nov-2026 09:35:42 GMT; Path=/; HttpOnly',
    'educg_session=' + sid + '; Path=/; HttpOnly'
  ].join(',')
}

function sidOf(header) {
  const raw = (header && (header.Cookie || header.cookie)) || ''
  const m = String(raw).match(/educg_session=([^;]+)/)
  return m ? m[1] : ''
}

function decodeBody(body) {
  const out = {}
  String(body || '')
    .split('&')
    .forEach((kv) => {
      if (!kv) return
      const i = kv.indexOf('=')
      const k = decodeURIComponent(kv.slice(0, i))
      out[k] = decodeURIComponent(kv.slice(i + 1))
    })
  return out
}

function decryptPwd(b64) {
  const d = crypto.createDecipheriv('aes-128-ecb', Buffer.from(AES_KEY, 'utf8'), null)
  d.setAutoPadding(true)
  return Buffer.concat([d.update(Buffer.from(b64, 'base64')), d.final()]).toString('utf8')
}

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
    const p = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
    let sid = sidOf(opt.header)
    const isBin = opt.responseType === 'arraybuffer'
    requests.push({ path: p, sid: sid, method: opt.method || 'GET' })

    const reply = (status, body, headers) => {
      setTimeout(() => {
        opt.success({
          statusCode: status,
          data: body,
          header: headers || {}
        })
      }, 0)
    }

    // 任何请求都可能顺手建会话
    if (!sid) {
      sid = newSid()
      SERVER.sessions[sid] = { logged: false, captcha: 'AB12' }
    }
    if (!SERVER.sessions[sid]) SERVER.sessions[sid] = { logged: false, captcha: 'AB12' }
    const sess = SERVER.sessions[sid]

    if (p === '/') {
      return reply(200, LOGIN_HTML, { 'Set-Cookie': setCookieHeader(sid) })
    }

    if (p === '/cgjiaoyan') {
      // 换个会话顺便换验证码；这里固定成 AB12，方便断言
      sess.captcha = 'AB12'
      // GIF89a + 宽 200 + 高 60（都是小端），尺寸要能算出来，界面靠它撑图片框
      const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 200, 0, 60, 0])
      return reply(200, isBin ? gif.buffer : 'GIF89a', {
        'Content-Type': 'image/gif',
        'Set-Cookie': setCookieHeader(sid)
      })
    }

    if (p === '/login/loginproc.jsp') {
      const body = decodeBody(opt.data)
      const pwdOk = (() => {
        try {
          return decryptPwd(body.pwd) === GOOD_PWD
        } catch (e) {
          return false
        }
      })()
      if (body.captchaCode !== sess.captcha) {
        return reply(302, LOGIN_HTML, { 'Set-Cookie': setCookieHeader(sid) })
      }
      if (body.stid !== GOOD_STID || !pwdOk) {
        return reply(302, LOGIN_HTML, { 'Set-Cookie': setCookieHeader(sid) })
      }
      sess.logged = true
      // 登录成功后服务器轮换会话（真实平台常见做法），必须能接住
      let next = sid
      if (SERVER.rotateOnLogin) {
        next = newSid()
        SERVER.sessions[next] = { logged: true, captcha: '' }
        delete SERVER.sessions[sid]
      }
      return reply(302, HOME_HTML, { 'Set-Cookie': setCookieHeader(next) })
    }

    if (p === '/indexcs/simple.jsp' || p === '/index.jsp') {
      return reply(200, sess.logged ? HOME_HTML : LOGIN_HTML, {
        'Set-Cookie': setCookieHeader(sid)
      })
    }

    return reply(404, '<html><head><title>404</title></head><body>Not Found</body></html>', {})
  }
}

const AES = require(path.join(ROOT, 'miniprogram', 'utils', 'aes'))
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
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected })
}
async function rejects(name, fn, keyword) {
  try {
    await fn()
  } catch (e) {
    const msg = String((e && e.message) || e)
    ok(name + '（' + msg + '）', !keyword || msg.indexOf(keyword) > -1)
    return
  }
  ok(name, false, '没有抛错')
}

;(async () => {
  /* ---------------- 1. AES ---------------- */
  console.log('\n[1] AES-128-ECB（key = Client8Sess!06ID）')
  const vectors = ['', 'a', '0123456789abcdef', 'abcdefghijklmnopq', '我的密码123', 'P@ssw0rd!' + 'x'.repeat(40)]
  let aesBad = 0
  vectors.forEach((plain) => {
    const c = crypto.createCipheriv('aes-128-ecb', Buffer.from(AES_KEY, 'utf8'), null)
    c.setAutoPadding(true)
    const ref = Buffer.concat([c.update(Buffer.from(plain, 'utf8')), c.final()]).toString('base64')
    if (AES.encryptEcb(plain, AES_KEY) !== ref) aesBad++
  })
  eq('六组明文与 Node crypto 逐字节一致', aesBad, 0)
  eq('空密码也要补满一整块', AES.encryptEcb('', AES_KEY).length, 24)
  eq(
    '中文按 UTF-8 编码',
    AES.encryptEcb('密码', AES_KEY),
    (() => {
      const c = crypto.createCipheriv('aes-128-ecb', Buffer.from(AES_KEY, 'utf8'), null)
      return Buffer.concat([c.update(Buffer.from('密码', 'utf8')), c.final()]).toString('base64')
    })()
  )

  /* ---------------- 2. Cookie 解析 ---------------- */
  console.log('\n[2] Set-Cookie（微信会把多条用逗号拼一起）')
  const raw = setCookieHeader('SESS9X')
  const parts = edu.splitSetCookie(raw)
  eq('Expires 里的逗号没被切坏', parts.length, 2)
  ok('第一条是 lang', /^lang=zh-CN/.test(parts[0]), parts[0])
  ok('第二条是 session', /^educg_session=SESS9X/.test(parts[1]), parts[1])

  const merged = edu.mergeCookie('', raw)
  ok('合并后带上了 session', /educg_session=SESS9X/.test(merged), merged)
  ok('合并后也带上了 lang', /lang=zh-CN/.test(merged), merged)

  const overwrite = edu.mergeCookie('educg_session=OLD; lang=zh-CN', setCookieHeader('NEW1'))
  ok('同名 Cookie 以最新的为准', /educg_session=NEW1/.test(overwrite) && !/OLD/.test(overwrite), overwrite)

  /* ---------------- 3. 验证码 ---------------- */
  console.log('\n[3] 验证码')
  const cap = await edu.captcha()
  ok('拿到 base64 图片', /^data:image\/gif;base64,/.test(cap.img), cap.img.slice(0, 32))
  ok('图片不是空的', cap.bytes > 0, cap.bytes)
  ok('这一步顺手把会话存下来了', edu.getCfg().cookie.indexOf('educg_session=') === 0 || /educg_session=/.test(edu.getCfg().cookie), edu.getCfg().cookie)
  // 图片框按真实宽高比撑开，否则固定框 + aspectFit 会缩成中间一小条
  ok('从 gif 头读出宽高比（200×60）', Math.abs(cap.ratio - 200 / 60) < 0.01, cap.ratio)
  eq('不是 gif 就不给比例（界面回落固定宽度）', edu.gifRatio(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])), 0)
  eq('太短也安全返回 0', edu.gifRatio(new Uint8Array([0x47, 0x49, 0x46])), 0)

  /* ---------------- 4. 登录失败 ---------------- */
  console.log('\n[4] 登录失败要说人话')
  await rejects(
    '验证码填错 → 页面上的提示原样带出来',
    () => edu.login({ stid: GOOD_STID, password: GOOD_PWD, code: '9999' }),
    '验证码错误'
  )
  await rejects('密码错 → 不通过', () => edu.login({ stid: GOOD_STID, password: 'wrongpwd', code: 'AB12' }), '')
  await rejects('没填学号', () => edu.login({ stid: '', password: GOOD_PWD, code: 'AB12' }), '学号')
  await rejects('没填验证码', () => edu.login({ stid: GOOD_STID, password: GOOD_PWD, code: '' }), '验证码')

  /* ---------------- 5. 登录成功 ---------------- */
  console.log('\n[5] 登录成功')
  const r = await edu.login({ stid: GOOD_STID, password: GOOD_PWD, code: 'AB12' })
  eq('返回学号', r.stid, GOOD_STID)
  ok('首页标题读到了', String(r.homeTitle).indexOf('一体化平台') > -1, r.homeTitle)
  ok('会话被换了新的一版（服务器轮换 session 也接得住）', /educg_session=SESS\d+A/.test(edu.getCfg().cookie), edu.getCfg().cookie)

  const st = await edu.status()
  eq('登录态查询：已登录', st.logged, true)
  eq('记着学号', st.stid, GOOD_STID)

  console.log('\n[6] 密码怎么存的')
  const rawStore = JSON.stringify(store['edu_intranet_cfg'] || {})
  ok('存储里没有密码明文', rawStore.indexOf(GOOD_PWD) === -1, rawStore)
  eq('但读出来还是原密码', edu.getCfg().password, GOOD_PWD)

  /* ---------------- 7. 探测 ---------------- */
  console.log('\n[7] 连通性探测')
  const lines = await edu.probe()
  const text = lines.join('\n')
  ok('列出了学生首页状态', /学生首页 .*HTTP 200/.test(text), text)
  ok('给出了页面链接', /courseinfo\/courseindex\.jsp\?courseid=8801/.test(text), text)
  ok('跳过了退出链接', !/logout\.jsp/.test(text), text)
  ok('跳过了 javascript: 假链接', !/javascript:void/.test(text), text)

  /* ---------------- 8. 抓任务（还没写解析） ---------------- */
  console.log('\n[8] 抓任务：结构没摸清时要给出可执行的下一步')
  await rejects('提示去点探测，而不是干巴巴一句失败', () => edu.sync(), '探测')
  // 页面模式的课程只有 href、没有数字 id。绝不能拿 href 去拼 /api/courses/{id}/…，
  // 否则会打出一串必然 404 的地址（曾经真这么干过），既刷满轨迹又拖慢同步。
  let syncMsg = ''
  try {
    await edu.sync()
  } catch (e) {
    syncMsg = String((e && e.message) || e)
  }
  ok('不拿页面路径去拼 JSON 接口（不出现 /api/courses//…）', syncMsg.indexOf('/api/courses//') < 0, syncMsg)
  ok('页面模式的课程会被真的打开看一眼', /数据结构与算法 (打不开|\d+ 字节)/.test(syncMsg), syncMsg)
  // 打不开也要说清楚是哪种拼法 404 了，别只丢一句「失败」
  ok('打不开时把拼法与状态码写进轨迹', /courseinfo\/courseindex\.jsp\?courseid=8801 → 404/.test(syncMsg), syncMsg)

  /* ---------------- 9. 退出 ---------------- */
  console.log('\n[9] 退出')
  eq('登出返回学号', edu.logout(), GOOD_STID)
  eq('会话清空', edu.getCfg().cookie, '')
  const st2 = await edu.status()
  eq('退出后是未登录', st2.logged, false)

  console.log('\n----------------------------------------')
  console.log(`通过 ${pass}  失败 ${fail}`)
  process.exit(fail ? 1 : 0)
})()
