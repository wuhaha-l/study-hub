const api = require('../../utils/api')
const JW = require('../../utils/jwcred')
const TT = require('../../utils/timetable')
const AUTH = require('../../utils/auth')
const theme = require('../../utils/theme')

/**
 * 首屏登录，两条路：
 *
 *   本校学生：学号 + 统一身份认证密码 → 云端登录 → 拉课表写本机。
 *   其他人员：手机号 + 自设密码注册/登录 → 身份是「访客」，只给记事本、专注、
 *             手动课表和手动待办；平台绑定、教务导入、同步这些一律不开。
 *
 * 访客没有短信验证码，是因为发短信要接第三方服务（按条计费 + 报备模板），
 * 而手机号归属其实也没法证明——所以密码必须自己记住，这是刻意的取舍。
 */
Page({
  data: {
    // school 本校学生 / other 其他人员
    tab: 'school',

    username: '',
    password: '',
    busy: false,
    // 短信二次验证
    mfaShow: false,
    mfaCode: '',
    phone: '',
    // 状态展示
    state: '',
    result: '',
    done: false,
    // 一键同步全部平台
    syncBusy: false,
    syncState: '',

    // 其他人员（访客）：用 o 前缀，别和上面 MFA 的 phone 串了
    oPhone: '',
    oPwd: '',
    oPwd2: '',
    oNick: '',
    otherMode: 'register', // register | login
    otherBusy: false,
    otherState: ''
  },

  onLoad() {
    theme.apply(this)
    const cred = JW.get()
    const back = AUTH.isAnonymous()
    this.setData({
      username: (cred && cred.username) || '',
      // 退出登录之后默认停在「本校学生」页签：学校登录是主路径，
      // 之前停在「其他人员」会让人以为学校登录入口没了。
      tab: 'school',
      otherMode: 'login',
      // 明确告诉他「退出来了」，否则回到这个页面看不出来退没退
      otherState: back ? '已退出登录。用学号重新登录，或者切到「其他人员」用手机号登回访客' : ''
    })
    if (back) wx.showToast({ title: '已退出登录', icon: 'none' })
  },

  /** 身份切换 */
  switchTab(e) {
    const t = e.currentTarget.dataset.tab === 'other' ? 'other' : 'school'
    if (t === this.data.tab) return
    this.setData({ tab: t, otherState: '', state: '', result: '' })
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [field]: e.detail.value })
  },

  onMfaCode(e) {
    this.setData({ mfaCode: e.detail.value })
  },

  /* ---------------- 其他人员：手机号注册 / 登录 ---------------- */

  onOtherInput(e) {
    const field = e.currentTarget.dataset.field
    if (!field) return
    this.setData({ [field]: e.detail.value })
  },

  switchOtherMode() {
    const next = this.data.otherMode === 'register' ? 'login' : 'register'
    this.setData({ otherMode: next, otherState: '', oPwd2: '' })
  },

  doOther() {
    if (this.data.otherBusy) return
    const register = this.data.otherMode === 'register'
    const phone = String(this.data.oPhone || '').replace(/[\s-]/g, '')
    const pwd = String(this.data.oPwd || '')
    const pwd2 = String(this.data.oPwd2 || '')

    if (!/^1[3-9]\d{9}$/.test(phone)) {
      wx.showToast({ title: '手机号要 11 位', icon: 'none' })
      return
    }
    if (pwd.length < 6) {
      wx.showToast({ title: '密码至少 6 位', icon: 'none' })
      return
    }
    if (register && pwd !== pwd2) {
      wx.showToast({ title: '两次密码不一样', icon: 'none' })
      return
    }

    this.setData({ otherBusy: true, otherState: register ? '正在注册…' : '正在登录…' })
    const task = register
      ? api.registerPhone({
          phone: phone,
          password: pwd,
          nickname: String(this.data.oNick || '').trim()
        })
      : api.loginPhone(phone, pwd)

    task
      .then((r) => {
        const prof = (r && r.profile) || {}
        AUTH.save({
          role: 'guest',
          phone: prof.phone || '',
          nickname: prof.nickname || '',
          username: '',
          since: Date.now()
        })
        this.enter('好了' + (prof.nickname ? '，' + prof.nickname : '') + '，正在进入…')
      })
      .catch((e) => {
        this.setData({
          otherBusy: false,
          otherState: (e && e.message) || '没成功，再试一次'
        })
      })
  },

  /** 登录成功统一收尾：写标记 → 回首页 */
  enter(tip) {
    wx.setStorageSync('app_registered_v1', Date.now())
    const app = getApp()
    if (app && app.globalData) app.globalData.needRefresh = true
    this.setData({ otherBusy: false, otherState: tip })
    setTimeout(() => wx.reLaunch({ url: '/pages/index/index' }), 700)
  },

  /** 登录：验证学号密码 → 拉课表 → 标记已初始化 */
  doLogin() {
    if (this.data.busy || this.data.done) return
    // 访客想用学号登录：不拦死，给个确认。云端会把身份换成 school，
    // 并把那条访客记录解绑留着——手机号以后还能登回来，数据不会丢。
    // （之前这里是直接拒绝，很多人卡在「访客退不掉、学校也登不进」）
    if (AUTH.isGuest() && !AUTH.isAnonymous()) {
      wx.showModal({
        title: '当前是访客身份',
        content:
          '用学号登录会换成学校账号。访客的便签、番茄记录、手动课表和待办都还在，以后用手机号还能登回来。要继续吗？',
        confirmText: '继续登录',
        success: (r) => {
          if (r.confirm) this.startSchoolLogin()
        }
      })
      return
    }
    this.startSchoolLogin()
  },

  /** 真正发起统一认证登录（上面那个确认框放行之后走这里） */
  startSchoolLogin() {
    if (this.data.busy || this.data.done) return
    const username = String(this.data.username || '').trim()
    const password = String(this.data.password || '')
    if (!username || !password) {
      wx.showToast({ title: '学号、密码都要填', icon: 'none' })
      return
    }
    const sch = JW.SCHOOLS[0]
    JW.save({ schoolId: sch.id, base: sch.base, username, password })

    this.setData({ busy: true, state: '正在登录统一认证…', result: '' })
    api
      .zzuAuto({ username, password })
      .then((r) => this.apply(r))
      .catch((e) => {
        this.setData({ busy: false, state: '失败', result: (e && e.message) || String(e) })
      })
  },

  /** 验证短信验证码 */
  verify() {
    if (this.data.busy || this.data.done) return
    const code = String(this.data.mfaCode || '').trim()
    if (!code) {
      wx.showToast({ title: '先填验证码', icon: 'none' })
      return
    }
    this.setData({ busy: true, state: '正在验证…' })
    api
      .zzuMfaVerify(code)
      .then((r) => this.apply(r))
      .catch((e) => {
        this.setData({ busy: false, state: '失败', result: (e && e.message) || String(e) })
      })
  },

  /** 没收到短信就重发 */
  resend() {
    if (this.data.busy) return
    this.setData({ busy: true, state: '正在重发验证码…' })
    api
      .zzuMfaVerify('', true)
      .then((r) => {
        this.setData({ busy: false, state: (r && r.message) || '已重发' })
      })
      .catch((e) => {
        this.setData({ busy: false, state: '重发失败', result: (e && e.message) || String(e) })
      })
  },

  /** 登录结果统一处理：成功 → 写课表 + 标记初始化 → 回首页 */
  apply(r) {
    if (r && r.success) {
      const res = TT.mergeJw(r)
      wx.setStorageSync('app_registered_v1', Date.now())
      // 本校身份落本机，云端也打个标（老用户没记录照样是 school，不会受影响）
      AUTH.save({
        role: 'school',
        username: this.data.username,
        phone: '',
        nickname: '',
        since: Date.now()
      })
      const app = getApp()
      if (app && app.globalData) app.globalData.needRefresh = true

      const go = (warn) => {
        this.setData({
          busy: false,
          mfaShow: false,
          done: true,
          state: '登录成功' + (r.name || r.loginName ? '，' + (r.name || r.loginName) : ''),
          result:
            '课表 ' + res.added + ' 节已导入本机' +
            (res.termStart ? '，开学日校准为 ' + res.termStart : '') +
            (r.message ? '。' + r.message : '') +
            '。学习通 / U校园 / 希冀去「登录设置」绑定。' +
            (warn || '')
        })
        setTimeout(() => wx.reLaunch({ url: '/pages/index/index' }), warn ? 3200 : 1400)
      }

      // 云端身份必须跟上：没跟上的话云端还当他 / 她 是访客，首页会把同步按钮、
      // 平台卡片全部关掉，看起来就像「学校账号登进去了却什么都不能用」。
      // 所以这里等它返回，失败就把原因写出来，而不是静默吞掉。
      api.markSchool(this.data.username).then(
        () => go(''),
        (e) =>
          go(
            '\n\n⚠️ 云端身份同步失败：' +
              ((e && e.message) || '未知错误') +
              '\n这多半是云函数还没重传（需要 ≥ 20261026.3），重传后重新登录一次即可。'
          )
      )
      return
    }

    // 短信验证码已经在路上：亮出验证码输入
    if (r && r.needMfaCode) {
      this.setData({
        busy: false,
        mfaShow: true,
        phone: r.phone || '',
        state: r.message || '验证码已发送',
        result: r.hint || ''
      })
      wx.showToast({ title: '验证码已发送', icon: 'none' })
      return
    }

    this.setData({
      busy: false,
      mfaShow: r && r.needRestart ? false : this.data.mfaShow,
      state: (r && (r.message || r.error)) || '没成',
      result: ((r && r.hint) || '') + (Array.isArray(r && r.chain) && r.chain.length ? '\n—— 轨迹 ——\n' + r.chain.join('\n') : '')
    })
  },

  /** 学校统一认证出问题时别把人锁死：可以先跳过，之后在登录设置里随时绑定 */
  skip() {
    // 标记一定要写，否则首页 onLoad 看到没登录又会踢回来，两个页面来回弹
    if (!wx.getStorageSync('app_registered_v1')) {
      wx.setStorageSync('app_registered_v1', Date.now())
      // 退出登录过来的人（anonymous）不能顺手变成 school —— 那等于把自己
      // 变成学校账号，直接看到学校那份课表和任务
      if (!AUTH.isAnonymous()) AUTH.save({ role: 'school', username: '', since: Date.now() })
    }
    wx.reLaunch({ url: '/pages/index/index' })
  },

  /** 一键同步所有已绑定平台的任务（云函数会逐个平台串行抓） */
  syncAll() {
    if (this.data.syncBusy) return
    this.setData({ syncBusy: true, syncState: '正在同步所有平台…' })
    api
      .sync('all')
      .then((res) => {
        const errs = (res && res.errors) || []
        const count = (res && res.count) || 0
        this.setData({
          syncBusy: false,
          syncState: errs.length
            ? '同步完成但有平台失败：\n' + errs.join('\n')
            : count > 0
            ? '✅ 已同步 ' + count + ' 项任务'
            : '同步完成，暂无待办任务'
        })
      })
      .catch((e) => {
        this.setData({
          syncBusy: false,
          syncState: '同步失败：' + ((e && e.message) || '未知错误')
        })
      })
  }
})
