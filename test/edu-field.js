/**
 * 希冀验证码输入框：值到底有没有被读到。
 *
 * 起因（真机上连撞两次）：
 *   1) 验证码填了，点「登录」却弹「先填验证码」，界面上的「n/6」计数也没出现
 *      → 说明 bindinput 里 `e.currentTarget.dataset.field` 取不到东西，
 *        整个 handler 直接 return 了。同页「课表导入」那几个框用的是一对一函数，
 *        一直是好的，所以希冀这边也改成一栏一个函数（eduInBase/eduInStid/…）。
 *   2) 光靠事件还是不稳，于是又加了一条**完全不依赖 bindinput** 的路：
 *      四个 input 用 form 包起来，点登录时 e.detail.value 里是 input 原生值。
 *
 * 所以这里钉四件事：
 *   1. 一对一 handler 触发后，eduField 一定拿得到值（哪怕 setData 没落地）
 *   2. 事件压根没触发（真机情况）时，form 提交的原生值也能登录
 *   3. 同一个 form 里别的按钮顺带触发的 submit 不算登录
 *   4. 提交也没来时的 tap 兜底能顶上
 *
 * 运行：node test/edu-field.js
 */
const Module = require('module')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const ACCOUNTS = path.join(ROOT, 'miniprogram', 'pages', 'accounts', 'accounts.js')

/* ---------------- 给页面依赖打桩（只关心输入框那几行） ---------------- */

const loginCalls = []

const stubs = {
  '../../utils/api': {},
  '../../utils/model': {},
  '../../utils/cookie': {},
  '../../utils/edu': {
    // 卡在这里不让它 resolve，避免走到 this.load() 那些跟本节无关的分支
    login: (o) => {
      loginCalls.push(o)
      return new Promise(() => {})
    },
    saveCfg: (o) => Object.assign({}, o),
    captcha: () => new Promise(() => {})
  },
  '../../utils/proxy': {},
  '../../utils/jwcred': { SCHOOLS: [{ id: 'zzu', name: '郑州大学' }], get: () => ({}) },
  '../../utils/timetable': {},
  '../../utils/auth': { isGuest: () => false, role: () => 'school' },
  '../../utils/theme': { apply() {} }
}

const origLoad = Module._load
Module._load = function (req, parent) {
  if (parent && parent.filename === ACCOUNTS && stubs[req]) return stubs[req]
  return origLoad.apply(this, arguments)
}

let captured = null
const toasts = []
global.Page = (cfg) => {
  captured = cfg
}
global.getApp = () => ({ globalData: {} })
global.wx = {
  getStorageSync: () => ({}),
  setStorageSync() {},
  showToast: (o) => toasts.push(o && o.title),
  showModal() {}
}

require(ACCOUNTS)
Module._load = origLoad

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
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected })
}

/** 造一个页面实例；setDataWorks=false 用来模拟「setData 没落到 data」 */
function makePage(setDataWorks) {
  const page = Object.assign({}, captured)
  page.data = JSON.parse(JSON.stringify(captured.data))
  page.setData = function (patch) {
    if (!setDataWorks) return
    Object.keys(patch).forEach((k) => {
      const seg = String(k).split('.')
      let o = this.data
      for (let i = 0; i < seg.length - 1; i++) {
        if (!o[seg[i]] || typeof o[seg[i]] !== 'object') o[seg[i]] = {}
        o = o[seg[i]]
      }
      o[seg[seg.length - 1]] = patch[k]
    })
  }
  return page
}

/** 真机上的写法：一栏一个函数，事件里没有 dataset */
const HANDLERS = { base: 'eduInBase', stid: 'eduInStid', password: 'eduInPwd', code: 'eduInCode' }

function type(page, field, value) {
  page[HANDLERS[field]]({ detail: { value: value } })
}

function fill(page, vals) {
  Object.keys(vals).forEach((k) => type(page, k, vals[k]))
}

console.log('\n[1] 一对一 handler：不靠 dataset 也能拿到值')
const p1 = makePage(true)
type(p1, 'code', 'ab12')
eq('data.edu.code 已更新', p1.data.edu.code, 'ab12')
eq('eduField 读到 ab12', p1.eduField('code'), 'ab12')
eq('已输入位数给到界面（那个 n/6 计数）', p1.data.eduCodeLen, 4)
ok('handler 不再依赖 dataset.field', typeof p1.eduInput === 'undefined')

console.log('\n[2] setData 没落地：也不能丢')
const p2 = makePage(false)
fill(p2, { stid: '202515020339', password: 'p@ss', code: '7h2k' })
eq('data 里没有验证码', p2.data.edu.code, '')
eq('但 eduField 照样读到（实例兜底）', p2.eduField('code'), '7h2k')
eq('学号也读得到', p2.eduField('stid'), '202515020339')

console.log('\n[3] 大小写原样保留、空格自动去掉')
const p3 = makePage(true)
type(p3, 'code', 'utKYH')
eq('大小写不被改写', p3.data.edu.code, 'utKYH')
type(p3, 'code', ' ut KYH ')
eq('中间的空格被清掉', p3.eduField('code'), 'utKYH')
eq('计数按清洗后的长度', p3.data.eduCodeLen, 5)

console.log('\n[4] 清空输入框')
const p4 = makePage(true)
type(p4, 'code', 'ab12')
type(p4, 'code', '')
eq('清空后是空串', p4.eduField('code'), '')
ok('没有回落到旧值', p4.eduField('code') !== 'ab12')

console.log('\n[5] 用户没碰过输入框：读 data（onLoad 从本机存储带出来的值）')
const p5 = makePage(true)
p5.data.edu.stid = '202515020339'
p5.data.edu.base = 'http://10.67.4.14'
eq('学号来自 data', p5.eduField('stid'), '202515020339')
eq('地址来自 data', p5.eduField('base'), 'http://10.67.4.14')
eq('没填过验证码就是空', p5.eduField('code'), '')

console.log('\n[6] 点登录时没验证码：提示要分清「没取图」和「取了没填」')
const p6 = makePage(true)
toasts.length = 0
p6.data.edu.stid = '202515020339'
p6.data.edu.password = 'p@ss'
p6.eduLoginTouch()
p6.eduLogin(null)
eq('没取图 → 先取验证码', toasts[toasts.length - 1], '先取验证码')
ok('状态行给出下一步', /先点右边方框取一张图/.test(p6.data.edu.stateText), p6.data.edu.stateText)

const p7 = makePage(true)
toasts.length = 0
p7.data.edu.stid = '202515020339'
p7.data.edu.password = 'p@ss'
p7.data.eduCaptcha = 'data:image/gif;base64,AAA'
p7.eduLoginTouch()
p7.eduLogin(null)
eq('取了没填 → 先填验证码', toasts[toasts.length - 1], '先填验证码')
ok('状态行说清楚往哪填', /填进左边输入框/.test(p7.data.edu.stateText), p7.data.edu.stateText)

console.log('\n[7] 真机情况：bindinput 一次都没触发，全靠 form 的原生值')
const p8 = makePage(false) // setData 都不落地，模拟事件丢了
loginCalls.length = 0
toasts.length = 0
p8.data.eduCaptcha = 'data:image/gif;base64,AAA'
p8.eduLoginTouch() // 按钮按下（上膛）
p8.eduLogin({ detail: { value: { base: 'http://10.67.4.14', stid: '202515020339', password: 'p@ss', code: 'utKYH' } } })
eq('form 里的验证码被采纳', loginCalls[0] && loginCalls[0].code, 'utKYH')
eq('form 里的学号被采纳', loginCalls[0] && loginCalls[0].stid, '202515020339')
ok('没误报「先填验证码」', toasts.indexOf('先填验证码') < 0, toasts)

console.log('\n[8] 同一个 form 里别的按钮顺带触发 submit：不算登录')
const p9 = makePage(true)
loginCalls.length = 0
p9.data.eduCaptcha = 'data:image/gif;base64,AAA'
p9.data.edu.stid = '202515020339'
p9.data.edu.password = 'p@ss'
// 没有 eduLoginTouch（没按登录按钮），直接来一个 submit
p9.eduLogin({ detail: { value: { base: 'x', stid: '202515020339', password: 'p@ss', code: 'utKYH' } } })
eq('未上膛的 submit 被忽略', loginCalls.length, 0)

console.log('\n[9] submit 压根没来：tap 兜底顶上')
const p10 = makePage(true)
loginCalls.length = 0
p10.data.edu.stid = '202515020339'
p10.data.edu.password = 'p@ss'
p10.data.eduCaptcha = 'data:image/gif;base64,AAA'
type(p10, 'code', 'utKYH')
p10.eduLoginTouch()
p10.eduLoginTap()
clearTimeout(p10._eduTapTimer)
p10._eduTapFire()
eq('兜底路径也把验证码送进去了', loginCalls[0] && loginCalls[0].code, 'utKYH')
eq('而且只登一次', loginCalls.length, 1)

console.log('\n[10] 先 tap 后 submit：两条路不会重复登录')
const p11 = makePage(true)
loginCalls.length = 0
p11.data.edu.stid = '202515020339'
p11.data.edu.password = 'p@ss'
p11.data.eduCaptcha = 'data:image/gif;base64,AAA'
type(p11, 'code', 'utKYH')
p11.eduLoginTouch()
p11.eduLoginTap() // 排了个 150ms 后的兜底
p11.eduLogin({ detail: { value: { base: 'x', stid: '202515020339', password: 'p@ss', code: 'utKYH' } } })
eq('submit 到了就落一次登录', loginCalls.length, 1)
ok('兜底定时器被撤掉', !p11._eduTapTimer)

console.log('\n----------------------------------------')
console.log('通过 ' + pass + '，失败 ' + fail)
process.exit(fail ? 1 : 0)
