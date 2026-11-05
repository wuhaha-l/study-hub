/* 统一身份认证（CAS）+ 门户课表 测试
 *
 * 网络那一段必须真账号才能验，所以这里把「能离线验的全部钉死」：
 *   RSA 加密能不能被同一把私钥解开、登录页字段认不认得出、JWT 中间段解不解得开、
 *   ticket 从 URL 里提不提得出来、门户回的那坨 JSON 拍不拍得平。
 * 门户字段名各校不同，所以 parseEvents 专门做了多名字兜底，这里逐个覆盖。
 */
const path = require('path')
const crypto = require('crypto')
const C = require(path.join(__dirname, '..', 'localserver', 'cas'))
const I = C._internal

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

/* ---------------- RSA ---------------- */
console.log('\n【RSA 密码加密】')
{
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 })
  const pem = publicKey.export({ type: 'spki', format: 'pem' })
  const plain = 'Zz@2025!abc'
  const enc = I.rsaEncrypt(plain, pem)

  ok('输出是 base64', /^[A-Za-z0-9+/=]+$/.test(enc))
  ok('长度等于模长（1024 位 = 172 字符 base64）', enc.length === 172, enc.length)

  const back = crypto
    .privateDecrypt(
      { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(enc, 'base64')
    )
    .toString('utf8')
  ok('用同一把私钥能解回原文', back === plain, back)

  const enc2 = I.rsaEncrypt(plain, pem)
  ok('两次加密结果不同（PKCS#1 v1.5 有随机填充）', enc !== enc2)

  ok('中文密码也能加密', I.rsaEncrypt('密码123', pem).length === 172)
  ok('公钥格式不对会抛错', (() => {
    try {
      I.rsaEncrypt('x', 'not-a-key')
      return false
    } catch (e) {
      return true
    }
  })())
}

/* ---------------- 登录页解析 ---------------- */
console.log('\n【登录页字段识别】')
{
  const html = `
    <form method="post" id="fm1" action="login">
      <input type="hidden" name="execution" value="abc-123_ZXlK&def"/>
      <input type="hidden" id="captcha" name="captcha" value=""/>
      <input type="hidden" name="mfaState" value=""/>
      <input type="hidden" name="_eventId" value="submit"/>
    </form>
    <script>
      var CaptchaEnabled = true;
      var mfaEnabled = "true" == "true";
      var mfaTypeSecurePhone = "true" == "true";
      var mfaTypeQrCode = "true" == "true";
      var mfaTypeAppPush = "false" == "true";
    </script>`
  const p = I.parseLoginPage(html)
  ok('认出登录表单', p.ok === true)
  ok('execution 取到并解码 &', p.execution === 'abc-123_ZXlK&def', p.execution)
  ok('识别出图形验证码（系统支持）', p.captcha === true)
  ok('默认这次不要验证码', p.captchaShown === false, p.captchaShown)
  ok('识别出双因子', p.mfa === true)
  ok('认出短信方式', p.mfaTypes.indexOf('SecurePhone') >= 0, p.mfaTypes)
  ok('认出扫码方式', p.mfaTypes.indexOf('QrCode') >= 0, p.mfaTypes)
  ok('没开的 appPush 不算', p.mfaTypes.indexOf('AppPush') < 0, p.mfaTypes)
}
{
  const p = I.parseLoginPage('<html><body>用户名或密码错误，请重新输入</body></html>')
  ok('报错文案能认出来', p.err === '账号或密码错误', p.err)
  ok('没有表单就不算 ok', p.ok === false)
}
{
  const p = I.parseLoginPage(
    '<form id="fm1"><input name="captcha"/></form><script>casServerCaptchaShow = true;</script>'
  )
  ok('被要求填验证码时能认出来', p.captchaShown === true)
}
{
  const p = I.parseLoginPage('{"code":500,"message":"系统维护"}')
  ok('JSON 错误也能兜', p.err === '系统维护', p.err)
}

/* ---------------- JWT / ticket ---------------- */
console.log('\n【ticket 提取与 JWT 解码】')
{
  const payload = { idToken: 'ID-TOKEN-XYZ', identityTypeCode: 'student', organizationName: '郑州大学' }
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64').replace(/=+$/, '')
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.' + b64 + '.sig'

  const j = I.jwtPayload(jwt)
  ok('解出 idToken', j && j.idToken === 'ID-TOKEN-XYZ', j)
  ok('解出身份', j && j.identityTypeCode === 'student')
  ok('解出学校', j && j.organizationName === '郑州大学')
  ok('乱字符串返回 null', I.jwtPayload('not-a-jwt') === null)
  ok('空值返回 null', I.jwtPayload('') === null)

  ok(
    '问号后面的 ticket',
    I.findTicket('https://info.s.zzu.edu.cn/?path=x&ticket=ST-1-abc') === 'ST-1-abc'
  )
  ok(
    'hash 里的 ticket',
    I.findTicket('https://info.s.zzu.edu.cn/main.html#/main?ticket=ST-2-def') === 'ST-2-def'
  )
  ok('ticket 会被 URL 解码', I.findTicket('http://a/b?ticket=eyJ%2Bx%2Fy') === 'eyJ+x/y')
  ok('没有 ticket 返回空串', I.findTicket('https://cas.s.zzu.edu.cn/cas/login') === '')
  ok('取其它参数', I.findQuery('http://a/b?path=%2Fmain&ticket=t1', 'path') === '/main')
}

/* ---------------- 节次换算 ---------------- */
console.log('\n【钟点 → 节次】')
ok('08:00 = 第 1 节', I.timeToPeriod('08:00') === 1)
ok('08:55 = 第 2 节', I.timeToPeriod('08:55') === 2)
ok('10:05 = 第 3 节（容差内就近）', I.timeToPeriod('10:05') === 3, I.timeToPeriod('10:05'))
ok('14:00 = 第 5 节', I.timeToPeriod('14:00') === 5)
ok('19:00 = 第 9 节', I.timeToPeriod('19:00') === 9)
ok('19:45 算第 10 节', I.timeToPeriod('19:45') === 10, I.timeToPeriod('19:45'))
ok('下课时间用 end 模式：09:40 → 第 2 节', I.timeToPeriod('09:40', 'end') === 2, I.timeToPeriod('09:40', 'end'))
ok('下课时间 15:40 → 第 6 节', I.timeToPeriod('15:40', 'end') === 6, I.timeToPeriod('15:40', 'end'))
ok('下课时间 11:40 → 第 4 节', I.timeToPeriod('11:40', 'end') === 4, I.timeToPeriod('11:40', 'end'))
ok('深夜 23:59 认不出', I.timeToPeriod('23:59') === 0)
ok('乱写认不出', I.timeToPeriod('中午') === 0)

/* ---------------- 门户日程拍平 ---------------- */
console.log('\n【门户日程 → 课表条目】')
{
  // 形态 A：events 包一层，字段是驼峰英文
  const a = I.parseEvents({
    code: 0,
    data: {
      events: [
        {
          title: '高等数学A(I)',
          location: '二教101',
          weekDay: 2,
          startSection: 1,
          endSection: 2,
          startWeek: 1,
          endWeek: 16
        },
        {
          title: '汇编语言',
          location: '松园3-201',
          weekDay: 4,
          startSection: 3,
          endSection: 4,
          startWeek: 1,
          endWeek: 16,
          weekType: '单'
        }
      ]
    }
  })
  ok('认出 events 这一层', a.meta.shape === 'events', a.meta.shape)
  ok('拍出 2 条', a.items.length === 2, a.items.length)
  ok('课名叫对', a.items[0] && a.items[0].name === '高等数学A(I)', a.items[0])
  ok('星期对（周二 = 2）', a.items[0] && a.items[0].day === 2, a.items[0] && a.items[0].day)
  ok('节次对', a.items[0] && a.items[0].start === 1 && a.items[0].end === 2, a.items[0])
  ok('地点对', a.items[0] && a.items[0].place === '二教101')
  ok('周次对', a.items[0] && a.items[0].weeks && a.items[0].weeks.from === 1 && a.items[0].weeks.to === 16)
  // 小程序的周次约定是 parity：1 单周、2 双周（以前用 odd/even，界面认不出来）
  ok(
    '单周标记转成 parity=1',
    a.items[1] && a.items[1].weeks && a.items[1].weeks.parity === 1,
    a.items[1] && a.items[1].weeks
  )
  ok('周次范围也一起带上', a.items[1] && a.items[1].weeks.from === 1 && a.items[1].weeks.to === 16)
}
{
  // 形态 B：data 直接是数组，字段换一套名字
  const b = I.parseEvents({
    code: 0,
    data: [
      { courseName: '大学物理', room: '北3-105', dayOfWeek: 3, startPeriod: 5, endPeriod: 6 },
      { courseName: '大学英语', classroom: '北3-201', dayOfWeek: 1, startPeriod: 7, endPeriod: 8 }
    ]
  })
  ok('data 裸数组也能吃', b.items.length === 2, b.items.length)
  ok('courseName/room 认得', b.items[0] && b.items[0].name === '大学物理' && b.items[0].place === '北3-105', b.items[0])
  ok('dayOfWeek/startPeriod 认得', b.items[0] && b.items[0].day === 3 && b.items[0].start === 5 && b.items[0].end === 6)
  ok('没给周次就不编', b.items[0] && b.items[0].weeks === null)
}
{
  // 形态 C：只给日期和时间，星期和节次都要推
  const c = I.parseEvents({
    code: 0,
    data: {
      list: [
        { summary: '数据结构', address: '松园2-301', startDate: '2026-09-08', startTime: '08:00', endTime: '09:40' },
        { summary: '操作系统', address: '松园2-302', startDate: '2026-09-10', startTime: '14:00', endTime: '15:40' }
      ]
    }
  })
  ok('list 这一层也认', c.meta.shape === 'list', c.meta.shape)
  ok('从日期推星期（9/8 是周二）', c.items[0] && c.items[0].day === 2, c.items[0] && c.items[0].day)
  ok('从钟点推节次（08:00 → 1）', c.items[0] && c.items[0].start === 1, c.items[0] && c.items[0].start)
  ok('结束节次（09:40 → 2）', c.items[0] && c.items[0].end === 2, c.items[0] && c.items[0].end)
  ok('14:00 → 第 5 节', c.items[1] && c.items[1].start === 5)
  ok('9/10 是周四', c.items[1] && c.items[1].day === 4, c.items[1] && c.items[1].day)
}
{
  // 脏数据：没课名、没星期、节次越界、非数组
  const d1 = I.parseEvents({ code: 0, data: { events: [{ location: '某处' }, null, { title: '有课名没星期' }] } })
  ok('缺课名/缺星期的都丢掉', d1.items.length === 0, d1.items.length)

  const d2 = I.parseEvents({ code: 0, data: { events: [{ title: '晚课', weekDay: 7, startSection: 11, endSection: 99 }] } })
  ok('节次上限收到 12', d2.items[0] && d2.items[0].end === 12, d2.items[0])

  const d3 = I.parseEvents({ code: -1, data: null })
  ok('没权限时返回空', d3.items.length === 0)

  const d4 = I.parseEvents({ code: 0, data: { foo: 1 } })
  ok('认不出的结构会记 shape', d4.meta.shape.indexOf('object:') === 0, d4.meta.shape)

  ok('null 不炸', I.parseEvents(null).items.length === 0)
}
{
  // 周日：JS 里 getDay()=0，课表要的是 7
  const e = I.parseEvents({ code: 0, data: [{ title: '周日课', startDate: '2026-09-13', startTime: '08:00' }] })
  ok('周日算第 7 天', e.items[0] && e.items[0].day === 7, e.items[0] && e.items[0].day)
}

/* ---------------- 默认取数范围 ---------------- */
console.log('\n【学期取数范围】')
{
  const oct = I.defaultRange('2026-10-24')
  ok('10 月：本年 8 月开学', oct.from === '2026-08-01', oct.from)
  ok('10 月：抓到次年 3 月', oct.to === '2027-03-31', oct.to)

  const mar = I.defaultRange('2026-03-05')
  ok('3 月：去年 8 月开学', mar.from === '2025-08-01', mar.from)
  ok('3 月：抓到今年 3 月', mar.to === '2026-03-31', mar.to)

  const jan = I.defaultRange('2027-01-10')
  ok('1 月仍算前一年秋季', jan.from === '2026-08-01', jan.from)
}

/* ---------------- 连接信息 ---------------- */
console.log('\n【内置常量】')
ok('CAS 地址正确', C.CAS_BASE === 'https://cas.s.zzu.edu.cn')
ok('门户 API 地址正确', C.PORTAL_API === 'https://info.s.zzu.edu.cn/portal-api/', C.PORTAL_API)
ok('回跳 service 指向门户', /info\.s\.zzu\.edu\.cn/.test(C.SERVICE), C.SERVICE)
ok('对外导出登录函数', typeof C.login === 'function')
ok('对外导出课表函数', typeof C.fetchSchedule === 'function')

console.log('\n' + (fail === 0 ? '✅ ' : '❌ ') + '通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
