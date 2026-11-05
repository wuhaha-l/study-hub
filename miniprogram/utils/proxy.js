/**
 * 本地代理客户端（方案 A）。
 *
 * 小程序不去直连学习通，而是连你自己电脑上跑的那个 localserver。
 * 好处：
 *   1. 出口 IP 是你家宽带 / 校园网，不是云函数机房 IP
 *   2. 学习通的 Cookie 全程在电脑上，小程序连 cookie 都看不到
 *   3. 绕开「个人小程序不能配置第三方域名」的限制 —— 本地地址不需要白名单，
 *      只要在开发者工具里勾上「不校验合法域名」即可
 *
 * 抓到的任务再通过 pushTasks 上传云端，首页 / 统计 / 每日提醒照旧读云端。
 */

const BASE_KEY = 'local_proxy_base'
const DEFAULT_BASE = 'http://127.0.0.1:7788'

function getBase() {
  const v = wx.getStorageSync(BASE_KEY)
  return String(v || DEFAULT_BASE).replace(/\/+$/, '')
}

function setBase(url) {
  const v = String(url || '').trim().replace(/\/+$/, '')
  if (!v) {
    wx.removeStorageSync(BASE_KEY)
    return DEFAULT_BASE
  }
  wx.setStorageSync(BASE_KEY, v)
  return v
}

/** 把 wx.request 的各种失败翻译成人话 */
function friendly(e) {
  const msg = String((e && e.errMsg) || (e && e.message) || e || '')
  if (/url not in domain list|not in domain/i.test(msg)) {
    return '微信拦了这个地址。开发者工具右上角「详情」→「本地设置」→ 勾上「不校验合法域名」。'
  }
  if (/timeout/i.test(msg)) {
    return '本地服务没响应（超时）。确认代理窗口还开着，或者任务太多，先把课程数调小。'
  }
  if (/fail|refused|ECONN/i.test(msg)) {
    return '连不上本地服务。检查：① 那个黑色命令行窗口还开着吗 ② 地址端口对不对'
  }
  return msg || '请求本地服务失败'
}

function req(path, data, timeout) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: getBase() + path,
      method: data ? 'POST' : 'GET',
      data: data || {},
      timeout: timeout || 60000,
      header: { 'Content-Type': 'application/json' },
      success(res) {
        const d = res.data
        if (!d || typeof d !== 'object') {
          return reject(
            new Error('本地服务返回了看不懂的东西（HTTP ' + res.statusCode + '），确认端口没填错')
          )
        }
        if (!d.ok) return reject(new Error(d.error || '本地服务报错'))
        resolve(d)
      },
      fail(e) {
        reject(new Error(friendly(e)))
      }
    })
  })
}

const proxy = {
  getBase,
  setBase,
  DEFAULT_BASE,

  /** 连通性检测 */
  ping() {
    return req('/ping', null, 4000)
  },

  /** 第一步：拿二维码。返回 { token, qr, expireAt } */
  qrStart() {
    return req('/cx/qr/start', {}, 30000)
  },

  /** 第二步：轮询。返回 { state, sid?, cookie?, nickname?, keys? } */
  qrPoll(token) {
    return req('/cx/qr/poll', { token }, 15000)
  },

  /** 只抓课程列表（几秒，用来验证登录态认不认） */
  courses() {
    return req('/cx/courses', {}, 40000)
  },

  /** 抓任务。limit 为最多抓几门课 */
  sync(limit) {
    return req('/cx/sync', { limit: limit || 10 }, 60000)
  },

  /* ---------------- U校园 ---------------- */

  /** 生成 U校园 二维码，返回 { token, qr } */
  upStart() {
    return req('/up/qr/start', {}, 40000)
  },

  /** 查扫码进度，返回 { state, message, cookie? } */
  upPoll(token) {
    return req('/up/qr/poll', { token }, 15000)
  },

  /* ---------------- 教务系统（EAMS）课表 ---------------- */

  /** 探测教务系统通不通；返回 { reachable, needCaptcha, cas, hint } */
  jwProbe(base) {
    return req('/jw/probe', { base: base || '' }, 45000)
  },

  /** 用代理里已有的登录态抓课表，返回 { success, count, items, semesterName, termStart } */
  jwSchedule(base) {
    return req('/jw/schedule', { base: base || '' }, 60000)
  },

  /**
   * 一步到位：账号密码 → 探测 → 登录 → 抓课表。
   * 有验证码时返回 { needCaptcha:true, captchaImg }，带上 captcha 再调一次即可。
   */
  jwAuto(payload) {
    return req('/jw/auto', payload || {}, 60000)
  },

  /** 换一张验证码（用当前会话） */
  jwCaptcha() {
    return req('/jw/captcha', {}, 15000)
  },

  /** 代理里的教务登录态还在不在 */
  jwStatus() {
    return req('/jw/status', null, 5000)
  },

  /** 清掉代理里的教务登录态 */
  jwLogout() {
    return req('/jw/logout', {}, 5000)
  },

  /** 离线解析一段课表页 HTML / 文字 */
  jwParse(html) {
    return req('/jw/parse', { html: html || '' }, 25000)
  },

  /* ---------------- 统一身份认证 → 门户课表（外网可用） ---------------- */

  /** 探测统一认证 / 门户能不能连（外网应该都能通） */
  casProbe() {
    return req('/cas/probe', {}, 45000)
  },

  /**
   * 登录统一身份认证。
   * 第一次不给 captcha → 返回 { needCaptcha:true, captchaImg }，让用户照着填；
   * 带上 captcha 再调一次即可。也可以只传 tgc（浏览器里的 CASTGC）绕开密码。
   */
  casLogin(payload) {
    return req('/cas/login', payload || {}, 60000)
  },

  /** 一步到位：有凭据就登录，然后直接抓门户课表 */
  casAuto(payload) {
    return req('/cas/auto', payload || {}, 90000)
  },

  /** 抓门户课表（依赖代理里已有的登录态） */
  casSchedule() {
    return req('/cas/schedule', {}, 60000)
  },

  /** 门户登录态还在不在 */
  casStatus() {
    return req('/cas/status', null, 5000)
  },

  /** 清掉门户登录态 */
  casLogout() {
    return req('/cas/logout', {}, 5000)
  }
}

module.exports = proxy
