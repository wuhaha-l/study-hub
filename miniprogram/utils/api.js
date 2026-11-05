/**
 * 云函数调用封装。所有请求走单入口云函数 studyHub，用 action 分发。
 */
function call(action, payload) {
  return wx.cloud
    .callFunction({
      name: 'studyHub',
      data: Object.assign({ action }, payload || {})
    })
    .then((res) => {
      const r = (res && res.result) || {}
      if (r.code !== 0) {
        const err = new Error(r.message || '服务返回异常')
        err.detail = r
        throw err
      }
      return r.data
    })
    .catch((e) => {
      // 云函数不存在 / 未部署时给出明确提示
      const msg = String((e && e.errMsg) || (e && e.message) || '')
      if (msg.indexOf('FUNCTION_NOT_FOUND') > -1 || msg.indexOf('not found') > -1) {
        throw new Error('云函数 studyHub 尚未部署，请先在开发者工具中上传部署')
      }
      throw e
    })
}

const api = {
  /** 一次拿到首页需要的一切：账号绑定、任务列表、统计 */
  getDashboard() {
    return call('getDashboard')
  },

  /** 触发抓取。platform 为 'all' 或具体平台 key */
  sync(platform) {
    return call('syncTasks', { platform: platform || 'all' })
  },

  /** 保存账号绑定 */
  saveAccount(account) {
    return call('saveAccount', account)
  },

  removeAccount(id) {
    return call('deleteAccount', { id })
  },

  /** 手动勾选完成 / 取消完成 */
  toggleTask(taskId, done) {
    return call('toggleTask', { taskId, done })
  },

  /** 新建/编辑自定义任务（带 id 为编辑）。remindAt 提醒时间戳，0 = 不提醒 */
  saveCustomTask(payload) {
    return call('saveCustomTask', payload || {})
  },

  /** 删除任务（自定义任务用） */
  deleteTask(taskId) {
    return call('deleteTask', { taskId })
  },

  /** 给任意任务设置提醒时间（0 = 关闭提醒） */
  setTaskReminder(taskId, remindAt) {
    return call('setTaskReminder', { taskId, remindAt })
  },

  /** 调试：单独验证某个平台的登录态 */
  testAccount(id) {
    return call('testAccount', { id })
  },

  /** 订阅消息授权 +1 次提醒额度 */
  addReminder() {
    return call('addReminder')
  },

  getReminder() {
    return call('getReminder')
  },

  /** 扫码登录第一步：拿二维码（返回 base64 图和一次性 token） */
  qrStart() {
    return call('qrStart')
  },

  /** 扫码登录第二步：轮询状态。返回 ok 时账号已在云端落地并同步完成 */
  qrPoll(token) {
    return call('qrPoll', { token })
  },

  /** 学习通网络自检：拿回自己的 Cookie，由小程序在本机网络上直连试一次 */
  cxSelfTest() {
    return call('cxSelfTest')
  },

  /** 学习通作业状态诊断：云端抓两门课，把平台页面上写的状态原文带回来 */
  cxWorkDiag(courses) {
    return call('cxWorkDiag', { courses: courses || 2 })
  },

  /** 小程序直连抓到的任务回传云端（校园内网平台用） */
  /**
   * 客户端抓到的任务回传云端。
   * mode: 'intranet'（校园内网直连，默认）| 'proxy'（本地代理）
   */
  pushTasks(platform, tasks, mode) {
    return call('pushTasks', { platform, tasks, mode: mode || 'intranet' })
  },

  /* ---------------- 郑大课表（云端跑 CAS，手机单独可用） ---------------- */

  /** 探测统一认证 / 门户能不能连（云函数出口） */
  zzuProbe() {
    return call('zzuProbe')
  },

  /**
   * 一步到位：登录（如果需要）→ 拉课表。
   *   第一次不给 captcha → 返回 { needCaptcha:true, captchaImg }；
   *   带上 captcha 再调一次即可。已经登录过就直接返回课表。
   */
  zzuAuto(payload) {
    return call('zzuAuto', payload || {})
  },

  /** 只拉课表（依赖云端的登录态，不传密码） */
  zzuSchedule(from, to) {
    return call('zzuSchedule', { from, to })
  },

  /** 课表诊断：上次拉取时教务实际给了哪些课、哪些周 */
  zzuTableDebug() {
    return call('zzuTableDebug')
  },

  /**
   * 二次验证下半场：交短信验证码。
   *   zzuMfaVerify('123456')     → 校验并继续登录
   *   zzuMfaVerify('', true)     → 只重发验证码
   */
  zzuMfaVerify(code, resend) {
    return call('zzuMfaVerify', { code, resend: !!resend })
  },

  /** 云端还留着登录态吗（CASTGC，14 天免密） */
  zzuStatus() {
    return call('zzuStatus')
  },

  /** 清掉云端的登录态 */
  zzuLogout() {
    return call('zzuLogout')
  },

  /* ---------------- 账号（访客身份） ---------------- */

  /** 手机号注册：{ phone, password, nickname } → { role, profile } */
  registerPhone(payload) {
    return call('registerPhone', payload || {})
  },

  /** 手机号 + 密码登录 */
  loginPhone(phone, password) {
    return call('loginPhone', { phone, password })
  },

  /** 当前微信是什么身份（school / guest） */
  whoami() {
    return call('whoami')
  },

  /** 本校学生登录成功后打标，记下学号 */
  markSchool(username) {
    return call('markSchool', { username })
  },

  /** 退出（访客记录留着，下次还能登回来） */
  logoutAccount() {
    return call('logoutAccount')
  }
}

module.exports = api
