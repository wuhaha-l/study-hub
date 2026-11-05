const api = require('../../utils/api')
const M = require('../../utils/model')
const CK = require('../../utils/cookie')
const edu = require('../../utils/edu')
const PX = require('../../utils/proxy')
const JW = require('../../utils/jwcred')
const TT = require('../../utils/timetable')
const AUTH = require('../../utils/auth')
const theme = require('../../utils/theme')
const relogin = require('../../utils/relogin')
const app = getApp()

function fmtTime(ts) {
  const d = new Date(ts)
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 学习通诊断结果 → 可复制的纯文本。
 * 关键是「平台原文」那一列：它就是云端在页面上看到的状态字，用来分清
 * 「平台本来写着待做」和「平台写了已完成但我们没认出来」。
 */
function fmtCxDiag(r) {
  const a = (r && r.account) || {}
  const d = (r && r.diag) || {}
  const lines = []
  if (r && r.srvVer) {
    lines.push(
      '服务版本 ' + r.srvVer +
        (r.srvVer === '20261028.19' ? '' : '（不是 20261028.19 说明云函数还没重新部署）')
    )
  }
  const MODE_CN = {
    proxy: '本地代理',
    intranet: '校园内网直连',
    cookie: 'Cookie',
    password: '账号密码'
  }
  lines.push(
    '账号：' + (MODE_CN[a.mode] || a.mode || '?') + ' 模式 · ' + (a.status || 'ok') +
      (a.lastSyncAt ? ' · 上次抓取 ' + fmtTime(a.lastSyncAt) : '')
  )
  if (a.lastError) lines.push('上次错误：' + a.lastError)
  if (d.clientOnly) {
    // 这种账号压根没有可用的登录凭据，再去抓只会误报「密码不正确」
    lines.push('结论：' + d.error)
  } else if (d.error) {
    lines.push('抓取失败：' + d.error)
  }
  if (d.courseCount) {
    lines.push('课程 ' + d.courseCount + ' 门，抽前 ' + ((d.courses || []).length) + ' 门看')
  }
  ;(d.courses || []).forEach((c) => {
    lines.push('')
    if (c.error) {
      lines.push('【' + c.name + '】' + c.error)
      return
    }
    const kb = Math.round((c.bytes || 0) / 1024)
    lines.push('【' + c.name + '】HTTP ' + c.http + ' · ' + kb + 'KB · ' + ((c.rows || []).length) + ' 条')
    ;(c.rows || []).forEach((row) => {
      lines.push('  ' + row.title)
      lines.push(
        '    平台原文「' + (row.raw || '没找到状态栏') + '」→ ' +
          (row.status === 'done' ? '已完成' : '未完成')
      )
    })
    if (c.hint) lines.push('  页面片段：' + c.hint)
  })
  if (d.trace) lines.push('取课程路径：' + d.trace)
  return lines.join('\n')
}

/**
 * 长文本弹窗：内容截断展示，「取消」按钮用来复制全文。
 * 抓取失败的详情往往很长（每条尝试路径都要写清楚），复制出来才好排查。
 */
function showDetail(title, text) {
  const full = String(text || '')
  wx.showModal({
    title,
    content: full.length > 260 ? full.slice(0, 260) + '…' : full,
    cancelText: '复制详情',
    confirmText: '知道了',
    success: (r) => {
      if (!r.cancel) return
      wx.setClipboardData({
        data: full,
        success: () => wx.showToast({ title: '已复制', icon: 'none' })
      })
    }
  })
}

/**
 * 「手机怎么连内网」的引导只在第一次登录希冀时自动弹出来，之后靠卡片上的链接手动看。
 * 用本机存储记一下，免得每次登录都拦一道。
 */
const DEBUG_GUIDE_KEY = 'edu_debug_guide_seen'

function debugGuideSeen() {
  try {
    return !!wx.getStorageSync(DEBUG_GUIDE_KEY)
  } catch (e) {
    return false
  }
}

function markDebugGuideSeen() {
  try {
    wx.setStorageSync(DEBUG_GUIDE_KEY, 1)
  } catch (e) {
    /* ignore */
  }
}

/** 微信「合法域名」拦截：http + 内网 IP 的必然结果 */
function isDomainBlocked(msg) {
  return /合法域名|开发调试|domain|url not in/i.test(String(msg || ''))
}

const PLATFORM_HINTS = {
  chaoxing: {
    label: '学习通',
    desc: '超星学习通 · 章节任务点 / 作业 / 考试',
    userLabel: '手机号或学号',
    cookieFrom: 'passport2.chaoxing.com',
  },
  educoder: {
    label: '希冀平台（公网头歌）',
    desc: '只对 www.educoder.net 的公网账号有效。学校的希冀如果在内网（地址像 10.67.x.x），云端根本连不上，请用下面那张「希冀 · 校园内网直连」卡。',
    userLabel: '公网头歌账号或手机号',
    cookieFrom: 'www.educoder.net',
    // 内网自建部署要引导到直连卡片，别让它卡在云端登录这一步
    intraHint: true
  },
  unipus: {
    label: 'U校园',
    desc: '外研社 U校园 · 视听说单元 / 作业',
    userLabel: '手机号',
    cookieFrom: 'u.unipus.cn',
  },
  zhihuishu: {
    label: '智慧树',
    desc: '智慧树 / 知到 · 实验性（Cookie 模式，首登需校准）',
    userLabel: '手机号',
    cookieFrom: 'onlineservice.zhihuishu.com',
  },
  icourse163: {
    label: '爱课程',
    desc:
      '爱课程（中国大学MOOC，icourse163.org）。密码总报错就换 Cookie 模式：电脑浏览器登录 icourse163.org →' +
      ' F12 → 应用/Application → Cookie → www.icourse163.org → 全选复制（必须含 STUDY_SESS），整串粘到左边',
    userLabel: '绑定的手机号 / 邮箱',
    cookieFrom: 'www.icourse163.org'
  },
  yuketang: {
    label: '雨课堂',
    desc: '雨课堂 · 实验性（Token 模式：F12 里 Authorization 的 Bearer 值）',
    userLabel: '手机号',
    cookieFrom: 'pro.yuketang.cn',
  }
}

Page({
  data: {
    platforms: [],
    // 需要重新登录的平台汇总（跑在 utils/relogin 上，和首页那条提醒同源）
    reloginItems: [],
    editing: '',
    form: { mode: 'password', username: '', password: '', cookie: '' },
    saving: false,
    hintOf: PLATFORM_HINTS,
    showHelp: false,
    loading: true,
    qrImage: '',
    qrState: '',
    qrMessage: '',
    // 希冀 · 校园内网直连：学号 + 密码 + 验证码登录，会话只存本机
    edu: {
      base: 'http://10.67.4.14',
      stid: '',
      password: '',
      code: '',
      logged: false,
      stateText: '',
      lastSyncText: '',
      build: ''
    },
    eduCaptcha: '',
    eduBusy: false,
    eduCodeLen: 0,
    eduCapW: 0,
    eduResult: '',
    // 学习通 · 本地代理（抓取在电脑上跑，绕开机房 IP）
    proxyAddr: '',
    proxyQr: '',
    proxyState: '',
    proxyStateCls: '',
    proxyLive: false,
    proxyBusy: false,
    proxyResult: '',
    // U校园 · 扫码（走 sso.unipus.cn，需要本地代理的长连接）
    upQr: '',
    upState: '',
    upBusy: false,
    // 课表导入：默认走统一身份认证（外网可用），校园网下可切到教务直连
    schoolNames: JW.SCHOOLS.map((s) => s.name),
    schoolIndex: 0,
    jwMode: 'cas',
    jwUser: '',
    jwPass: '',
    jwCap: '',
    jwCapImg: '',
    jwState: '',
    jwTip: '填学号密码点「登录并导入课表」，短信验证码发到你手机后填进来，一次管约一个月。',
    jwBusy: false,
    jwResult: '',
    // 云端是否留着登录态（APP idToken，约一个月免密）—— 留着就不用再输密码
    jwLogged: false,
    jwName: '',
    // 统一认证的短信二次验证：撞上时把验证码输入区亮出来
    jwMfaShow: false,
    jwMfaCode: '',
    jwPhone: '',
    // 两块长表单默认收起：头部只留标题 + 登录状态，页面不用滚很久才看到课表导入
    eduOpen: false,
    jwOpen: false,
    // 访客（手机号注册）不许进这一页，进来也只看得到一张说明
    blocked: false
  },

  onLoad(options) {
    theme.apply(this)
    // 访客身份：这一页全是学校平台，直接拦掉（云端也会 403，这里只是别让人白点）
    if (AUTH.isGuest()) {
      this.setData({ blocked: true })
      return
    }
    this.pendingPlatform = (options && options.platform) || ''
    const cfg = edu.getCfg()
    const cred = JW.get()
    const si = Math.max(0, JW.SCHOOLS.findIndex((s) => s.id === cred.schoolId))
    this.setData({
      edu: {
        base: cfg.base,
        stid: cfg.stid,
        password: cfg.password,
        code: '',
        logged: !!cfg.cookie,
        stateText: cfg.cookie
          ? '这台手机上还留着登录态' + (cfg.stid ? '（学号 ' + cfg.stid + '）' : '')
          : '还没登录：填学号密码，再填右边那张验证码',
        lastSyncText: cfg.lastSync ? '上次直连同步：' + fmtTime(cfg.lastSync) : '',
        build: edu.BUILD
      },
      proxyAddr: PX.getBase(),
      schoolIndex: si,
      jwUser: cred.username,
      jwPass: cred.password,
      jwState: cred.saved ? '已存过学号（' + cred.username + '），点「登录并导入课表」直接用。' : ''
    })
    // 输入缓存：进来时输入框是空的，读值靠 data 兜底
    this._eduInput = {}
    this.load()
    this.jwCheckCloud()
  },

  /** 访客看到的说明卡上的按钮：退出访客身份，回登录页换学校账号 */
  switchToSchool() {
    wx.showModal({
      title: '换成学校账号',
      content: '会先退出当前的访客身份，然后回到登录页。访客的记事本和专注数据都在这台手机上，不会丢。',
      confirmText: '去登录',
      success: (r) => {
        if (!r.confirm) return
        // 别 clear：清掉之后本机默认回到 school，等于立刻变成学校账号
        AUTH.save({ role: 'anonymous' })
        wx.removeStorageSync('app_registered_v1')
        // 等云端真的把「已退出」写进去再跳，否则 markSchool 会以「请先退出」挡住
        wx.showLoading({ title: '退出中', mask: true })
        const done = () => {
          wx.hideLoading()
          wx.reLaunch({ url: '/pages/welcome/welcome' })
        }
        api.logoutAccount().then(done, done)
      }
    })
  },

  /** 云端有没有留着的登录态：有就不用再输密码，直接拉 */
  jwCheckCloud() {
    api
      .zzuStatus()
      .then((st) => {
        if (!st) return
        // 上次卡在短信验证这一步：把验证码输入区直接亮出来，不用重新填密码
        if (st.pendingMfa) {
          this.setData({
            jwMfaShow: true,
            jwPhone: st.mfaPhone || '',
            jwState: '上次的验证码还没填（发到 ' + (st.mfaPhone || '安全手机') + '），填进来就行。'
          })
          return
        }
        if (!st.loggedIn) return
        this.setData({
          jwLogged: true,
          jwName: st.name || '',
          jwState:
            '云端已记住登录态' +
            (st.name ? '（' + st.name + '）' : '') +
            '，点「登录并导入课表」直接拉，不用再填密码。'
        })
      })
      .catch(() => null)
  },

  onHide() {
    this.stopPoll()
    this.stopProxyPoll()
  },

  onUnload() {
    this.stopPoll()
    this.stopProxyPoll()
  },

  load() {
    this.setData({ loading: true })
    api
      .getDashboard()
      .then((data) => {
        const accounts = data.accounts || []
        const platforms = M.PLATFORM_LIST.map((p) => {
          const acc = accounts.find((a) => a.platform === p.key)
          /*
           * 「旧模式」账号：proxy（本地代理）/ intranet（校园内网直连）。
           * 这类账号云端没有可用的登录凭据，handleSync 会直接跳过 ——
           * 用户点同步看到「什么都没变」，却完全不知道原因。所以这里要显眼地说破，
           * 并给一条「重新绑成云端模式」的路（学习通直接给扫码）。
           */
          const legacy = !!(acc && (acc.mode === 'proxy' || acc.mode === 'intranet'))
          return {
            key: p.key,
            name: p.name,
            color: p.color,
            dot: p.dot,
            desc: PLATFORM_HINTS[p.key].desc,
            bound: !!acc,
            legacy: legacy,
            accountId: acc ? acc._id : '',
            mode: acc ? acc.mode : '',
            modeText: !acc
              ? ''
              : acc.mode === 'proxy'
              ? '本地代理'
              : acc.mode === 'intranet'
              ? '校园内网直连'
              : acc.mode === 'cookie'
              ? 'Cookie 模式'
              : '账号密码模式',
            username: acc ? acc.maskedUser || acc.username || '' : '',
            status: acc ? acc.status : 'unbound',
            statusText: !acc
              ? '未绑定'
              : acc.status === 'invalid'
              ? '登录已失效，请重新绑定'
              : legacy
              ? '云端不会同步 · 上次抓取 ' + M.relativeTime(acc.lastSyncAt)
              : '正常 · ' + M.relativeTime(acc.lastSyncAt),
            lastSyncAt: (acc && acc.lastSyncAt) || 0
          }
        })
        /*
         * 「该重新登录了」逐平台标出来。
         * 和首页那条提醒用同一套判定（utils/relogin），两处说法必须一致：
         * 首页说「学习通登录过期」，进来后这一行也得是这个原因，不能换个词。
         */
        const rl = relogin.survey(accounts)
        const byKey = {}
        rl.items.forEach((x) => {
          byKey[x.key] = x
        })
        platforms.forEach((p) => {
          const hit = byKey[p.key]
          p.needLogin = !!hit
          p.reloginCode = hit ? hit.reason : ''
          p.reloginReason = hit ? hit.reasonText : ''
          p.reloginAction = hit ? hit.action : ''
        })

        this.setData({ platforms, reloginItems: rl.items, loading: false }, () => {
          // 从首页带 platform 参数跳进来时，自动展开对应平台
          if (this.pendingPlatform) {
            const key = this.pendingPlatform
            this.pendingPlatform = ''
            this.openEditor(key)
          }
        })
      })
      .catch((e) => {
        this.setData({ loading: false })
        wx.showModal({ title: '加载失败', content: e.message, showCancel: false })
      })
  },

  toggleEdit(e) {
    const key = e.currentTarget.dataset.key
    if (this.data.editing === key) {
      this.closeEditor()
      return
    }
    this.openEditor(key)
  },

  /**
   * 汇总卡里点某个平台 → 直接摊开它的登录表单，少一次找按钮。
   *
   * 老模式（本地代理 / 内网直连）不能这么直给：它的账号密码大概率是对的，
   * 云端抓不到是因为压根没有可用的凭据，重新填一遍密码救不回来。
   * 这种情况先说清是「绑定方式」的问题，再让他决定要不要换。
   */
  reloginOne(e) {
    const key = e.currentTarget.dataset.key
    const p = this.data.platforms.find((x) => x.key === key)
    if (!p) return

    if (p.reloginCode === 'legacy') {
      wx.showModal({
        title: '这个不是密码的问题',
        content:
          '它是「' +
          p.modeText +
          '」方式绑的，云端没有可用的登录凭据，点同步会被直接跳过。\n\n' +
          '重新绑一次，就变成云端能抓的账号' +
          (key === 'chaoxing' ? '（学习通可以直接扫码，最快）' : '') +
          '。',
        confirmText: '去重绑',
        cancelText: '知道了',
        success: (r) => {
          if (r.confirm) this.openEditor(key)
        }
      })
      return
    }

    this.openEditor(key)
  },

  /** 汇总卡右上角「全部处理」：从上往下依次摊开，先处理最要紧的那个 */
  reloginFirst() {
    const items = this.data.reloginItems || []
    if (!items.length) return
    this.reloginOne({ currentTarget: { dataset: { key: items[0].key } } })
  },

  openEditor(key) {
    const p = this.data.platforms.find((x) => x.key === key)
    this.stopPoll()
    this.qrToken = ''

    // 已绑定且仍有效就沿用原来的登录方式；首次绑定或已失效的学习通直接给扫码（最省事）
    // 「旧模式」账号（本地代理/内网直连）也按首次绑定处理：它没有可沿用的登录方式，
    // 重绑一次才会变成云端能抓的 cookie / 账号密码账号。
    const COOKIE_ONLY = { zhihuishu: true, yuketang: true }
    let mode = ''
    if (p && p.bound && p.status !== 'invalid' && !p.legacy) {
      mode = p.mode === 'cookie' ? 'cookie' : 'password'
    }
    if (!mode) {
      mode = key === 'chaoxing' ? 'qr' : COOKIE_ONLY[key] ? 'cookie' : 'password'
    } else if (COOKIE_ONLY[key] && mode === 'password') {
      mode = 'cookie'
    }

    this.setData(
      {
        editing: key,
        qrImage: '',
        qrState: '',
        qrMessage: '',
        form: { mode, username: '', password: '', cookie: '' }
      },
      () => {
        if (mode === 'qr') this.startQr()
      }
    )
  },

  closeEditor() {
    this.stopPoll()
    this.qrToken = ''
    this.setData({ editing: '', qrImage: '', qrState: '', qrMessage: '' })
  },

  switchMode(e) {
    const mode = e.currentTarget.dataset.mode
    if (mode === this.data.form.mode) return

    if (mode !== 'qr') this.stopPoll()
    this.setData({ 'form.mode': mode })

    if (mode === 'qr') {
      // 手上还有没失效的二维码就继续用，否则重新取一张
      if (this.qrToken) this.schedulePoll()
      else this.startQr()
    }
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ ['form.' + field]: e.detail.value })
  },

  onToggleHelp() {
    this.setData({ showHelp: !this.data.showHelp })
  },

  save() {
    const platform = this.data.editing
    const f = this.data.form
    if (!platform) return

    // 扫码模式不在这里提交，轮询成功时云端已经直接落库了
    if (f.mode === 'qr') return

    if (f.mode === 'password') {
      if (!f.username.trim() || !f.password) {
        wx.showToast({ title: '请填写账号和密码', icon: 'none' })
        return
      }
      this.doSave(platform, f, '')
      return
    }

    // Cookie 模式：先清洗成标准格式（支持直接粘表格 / cURL / 请求头）
    if (!f.cookie.trim()) {
      wx.showToast({ title: '请粘贴 Cookie', icon: 'none' })
      return
    }
    const parsed = CK.normalizeCookie(f.cookie)
    if (!parsed.cookie || parsed.count < 1) {
      wx.showToast({ title: '没识别出有效的 Cookie', icon: 'none' })
      return
    }

    if (parsed.notes.length) {
      wx.showToast({ title: parsed.notes[0], icon: 'none' })
    }

    // 学习通必须三个核心字段齐全，否则一定同步失败，提前拦住
    if (platform === 'chaoxing') {
      const info = CK.checkCookie(parsed.cookie)
      if (!info.chaoxingReady) {
        const missing = []
        if (!info.hasUid) missing.push('_uid')
        if (!info.hasD) missing.push('_d')
        if (!info.hasUf) missing.push('uf')
        wx.showModal({
          title: 'Cookie 可能不完整',
          content:
            '识别到 ' +
            info.count +
            ' 条，但缺少 ' +
            missing.join('、') +
            '。\n\n学习通要保持登录态，这三个字段缺一不可，直接保存大概率会同步失败。',
          confirmText: '仍然保存',
          cancelText: '重新复制',
          success: (r) => {
            if (r.confirm) this.doSave(platform, f, parsed.cookie)
          }
        })
        return
      }
    }

    this.doSave(platform, f, parsed.cookie)
  },

  doSave(platform, f, cookie) {
    this.setData({ saving: true })
    wx.showLoading({ title: '保存中', mask: true })

    api
      .saveAccount({
        platform,
        mode: f.mode,
        username: f.username.trim(),
        password: f.password,
        cookie: cookie || f.cookie.trim()
      })
      .then(() => {
        wx.hideLoading()
        wx.showLoading({ title: '正在验证', mask: true })
        return api.sync(platform)
      })
      .then((res) => {
        wx.hideLoading()
        this.setData({ saving: false, editing: '' })
        app.globalData.needRefresh = true
        /*
         * 重新登录成没成功，以「这一抓有没有报错」为准，而不是「保存接口返回 200」：
         * 密码填错时保存照样成功，抓取必挂。抓成功才把提醒清掉，
         * 抓失败则把原因记下来 —— 首页那条提醒就是靠这个记录才说得清。
         */
        const errs = (res && res.errors) || []
        if (errs.length) {
          relogin.note(platform, errs.join(' '))
        } else {
          relogin.clear(platform)
          relogin.unmute()
        }
        this.load()
        if (errs.length) {
          showDetail('账号已保存，但抓取失败', errs.join('\n'))
        } else {
          wx.showToast({ title: `同步到 ${res.count || 0} 项任务`, icon: 'success' })
        }
      })
      .catch((e) => {
        wx.hideLoading()
        this.setData({ saving: false })
        const msg = e.message || '未知错误'
        // 希冀：公网头歌这条路对校内自建部署永远是死的（云函数摸不到 10.x 内网地址），
        // 所以别让人在这条路上反复试，直接把出口指到「校园内网直连」。
        if (platform === 'educoder' && /内网直连|没拿到会话 Cookie|Cookie 不完整/.test(msg)) {
          wx.showModal({
            title: '公网头歌这条路走不通',
            content: msg,
            confirmText: '去内网直连',
            cancelText: '知道了',
            success: (r) => {
              if (r.confirm) this.gotoEdu()
            }
          })
          return
        }
        wx.showModal({
          title: '操作失败',
          content: msg,
          showCancel: false
        })
      })
  },

  /** 滚到「希冀 · 校园内网直连」那一块（内网部署唯一能用的入口） */
  gotoEdu() {
    // 折叠着滚过去只会看到一个标题，所以先展开再量位置（等渲染完再量）
    this.setData({ editing: '', eduOpen: true }, () => {
      setTimeout(() => this.scrollToEdu(), 60)
    })
  },

  scrollToEdu() {
    wx.createSelectorQuery()
      .select('#edu-card')
      .boundingClientRect()
      .selectViewport()
      .scrollOffset()
      .exec((res) => {
        const rect = res && res[0]
        const off = res && res[1]
        if (!rect || !off) return
        wx.pageScrollTo({
          scrollTop: Math.max(0, rect.top + off.scrollTop - 10),
          duration: 260
        })
      })
  },

  /**
   * 学习通网络自检：用「自己手机/电脑的网络」直连学习通接口。
   * 目的只有一个——分清是 Cookie 坏了，还是云函数机房 IP 被区别对待。
   */
  selfTest() {
    wx.showLoading({ title: '自检中', mask: true })
    api
      .cxSelfTest()
      .then((res) => {
        const cookie = (res && res.cookie) || ''
        const targets = (res && res.targets) || []
        const rows = ['Cookie 长度 ' + cookie.length]

        const one = (t) =>
          new Promise((resolve) => {
            wx.request({
              url: t.url,
              method: 'GET',
              timeout: 15000,
              header: {
                Cookie: cookie,
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                Referer: 'https://i.chaoxing.com/'
              },
              success: (r) => {
                const data = r.data
                let brief = ''
                if (typeof data === 'string') {
                  const hits = data.match(/courseid=\d+/gi) || []
                  brief = 'HTML ' + data.length + ' 字节，课程链接 ' + hits.length + ' 个'
                  if (/_uid/.test(data)) brief += '，含 _uid'
                  if (/课程|作业/.test(data)) brief += '，像正常页面'
                } else {
                  brief = JSON.stringify(data).slice(0, 130)
                }
                resolve(t.name + '：HTTP ' + r.statusCode + ' → ' + brief)
              },
              fail: (err) => {
                let msg = (err && err.errMsg) || '请求失败'
                if (/domain/i.test(msg)) msg += '（电脑勾选「不校验合法域名」，手机开「开发调试」）'
                resolve(t.name + '：❌ ' + msg)
              }
            })
          })

        Promise.all(targets.map(one)).then((lines) => {
          wx.hideLoading()
          showDetail('网络自检结果', rows.concat(lines).join('\n'))
        })
      })
      .catch((e) => {
        wx.hideLoading()
        showDetail('自检失败', e.message || '未知错误')
      })
  },

  /**
   * 学习通作业状态诊断。
   *
   * 「我在学习通交了作业，同步完还是未完成」这种反馈，只靠同步结果分不清
   * 是平台页面本身还写着「待做」，还是我们没认出「已完成」。
   * 这里让云端抓两门课，把每一行作业的平台状态原文带回来对照。
   */
  cxDiag() {
    wx.showLoading({ title: '诊断中', mask: true })
    api
      .cxWorkDiag(2)
      .then((r) => {
        wx.hideLoading()
        /*
         * 诊断的结果直接决定这条提醒还在不在：
         * 抓到凭据错误 → 记一条，首页/这张卡立刻变「需要重新登录」；
         * 能正常抓 → 说明登录是好的，把旧记录清掉，别一直挂着。
         */
        const msg = String(
          ((r && r.diag && r.diag.error) || (r && r.account && r.account.lastError) || '').trim()
        )
        if (msg) {
          relogin.note('chaoxing', msg)
        } else {
          relogin.clear('chaoxing')
          relogin.unmute()
        }
        // 判定变过，首页那条提醒回去要跟着变
        app.globalData.needRefresh = true
        this.load()
        showDetail('学习通状态诊断', fmtCxDiag(r))
      })
      .catch((e) => {
        wx.hideLoading()
        showDetail(
          '诊断失败',
          (e && e.message) || '未知错误' +
            '\n\n如果是「当前云函数版本不支持诊断」，说明云函数还没重新部署。'
        )
      })
  },

  /* ---------------- 希冀 · 校园内网直连 ---------------- */

  /**
   * 读一个输入框的当前值。
   *
   * 为什么要两条路都走：真机上出现过「验证码明明填了，点登录却说先填验证码」——
   * 学号密码都在（同一个 handler），只有验证码没读到。setData 是异步的，
   * 动态 key 在某些基础库/输入法场景下可能还没落进 data，所以 bindinput 时
   * 同时往实例上存一份，取的时候实例优先、data 兜底。
   */
  eduField(name) {
    const inst = this._eduInput || {}
    // 注意用 hasOwnProperty 而不是「非空」判断：用户把框清空时实例里是 ''，
    // 按非空判断会回落到 data 里的旧值，等于清不掉。
    if (Object.prototype.hasOwnProperty.call(inst, name)) {
      return String(inst[name] == null ? '' : inst[name])
    }
    return String((this.data.edu && this.data.edu[name]) || '')
  },

  /** 把当前输入框的值落到本机存储，返回落库后的配置 */
  eduPersist() {
    const cfg = edu.saveCfg({
      base: this.eduField('base').trim(),
      stid: this.eduField('stid').trim(),
      password: this.eduField('password')
    })
    this.setData({
      'edu.base': cfg.base,
      'edu.stid': cfg.stid,
      'edu.password': cfg.password
    })
    return cfg
  },

  /**
   * 写一个输入框的值。
   *
   * 每个输入框一个独立函数（eduInBase / eduInStid / eduInPwd / eduInCode），
   * 不走 data-field + dataset：真机上出现过「验证码明明填了，点登录却说没填」，
   * 计数也没出来——说明 bindinput 里 e.currentTarget.dataset.field 取不到东西。
   * 同页「课表导入」那几个框用的就是一对一函数，一直是好的，所以这里换成同款。
   * 另外顺手往实例上存一份：setData 是异步的，不能只信 data。
   */
  _eduSet(field, e) {
    const raw = e && e.detail ? e.detail.value : ''
    let value = typeof raw === 'string' ? raw : String(raw == null ? '' : raw)
    // 验证码里的空格是输入法/复制带进来的，服务端一定不认
    if (field === 'code') value = value.replace(/\s+/g, '')
    this._eduInput = this._eduInput || {}
    this._eduInput[field] = value
    const patch = { ['edu.' + field]: value }
    if (field === 'code') patch.eduCodeLen = value.length
    this.setData(patch)
  },

  eduInBase(e) {
    this._eduSet('base', e)
  },

  eduInStid(e) {
    this._eduSet('stid', e)
  },

  eduInPwd(e) {
    this._eduSet('password', e)
  },

  eduInCode(e) {
    this._eduSet('code', e)
  },

  /**
   * 把 form 提交带上来的原生输入值收进来。
   * 点「登录」时 e.detail.value = { base, stid, password, code }，这是 input 组件
   * 自己的值，**不经过 bindinput**，所以哪怕事件没派发也读得到。
   * 返回是否真的拿到了表单值。
   */
  _eduTakeForm(e) {
    const v = e && e.detail && e.detail.value
    if (!v || typeof v !== 'object') return false
    this._eduInput = this._eduInput || {}
    const patch = {}
    const keys = ['base', 'stid', 'password', 'code']
    let hit = 0
    keys.forEach((k) => {
      if (typeof v[k] !== 'string') return
      hit++
      const val = k === 'code' ? v[k].replace(/\s+/g, '') : v[k]
      this._eduInput[k] = val
      patch['edu.' + k] = val
    })
    if (!hit) return false
    patch.eduCodeLen = String(this._eduInput.code || '').length
    this.setData(patch)
    return true
  },

  eduSave() {
    this.eduPersist()
    wx.showToast({ title: '已保存到本机', icon: 'none' })
  },

  /** 换一张验证码（会把已填的验证码清掉——它是跟会话绑定的，换图就得重填） */
  eduCaptcha() {
    if (this.data.eduBusy) return
    this._eduInput = this._eduInput || {}
    this._eduInput.code = ''
    this.setData({ eduBusy: true, 'edu.code': '', eduCodeLen: 0 })
    edu
      .captcha()
      .then((r) => {
        // 图片框按真实比例撑开（框高固定 88rpx，宽度 = 高 × 宽高比），
        // 这样图不会缩在中间一小条；读不到比例就用默认 200rpx
        const ratio = r.ratio || 0
        const w = ratio ? Math.min(300, Math.max(160, Math.round(88 * ratio))) : 0
        this.setData({
          eduBusy: false,
          eduCaptcha: r.img,
          eduCapW: w,
          'edu.stateText': '验证码已换（' + r.bytes + ' 字节），照图填进左边输入框'
        })
      })
      .catch((e) => {
        this.setData({ eduBusy: false })
        const msg = (e && e.message) || '未知错误'
        // 取图是最先发出去的请求，被拦时用户最先撞在这里，顺手把引导弹出来
        if (isDomainBlocked(msg)) {
          this.setData({ 'edu.stateText': '取不到图：微信拦了这个地址，先开「开发调试」' })
          this.eduShowDebugGuide(msg)
          return
        }
        showDetail('验证码没拿到', msg)
      })
  },

  /**
   * 「登录」按钮的两条路。
   *
   * 主路是 form 的 submit：e.detail.value 里是 input 的原生值，不依赖 bindinput。
   * 但 submit 只在按钮 form-type="submit" 且被点中时才发，所以再留一条 tap 兜底：
   * tap 之后等 150ms，若 submit 没来（说明这条路在这台机器上不通）就用常规读取。
   * 反过来若 submit 先到，eduLogin 会把兜底定时器撤掉，不会登两次。
   */
  eduLoginTouch() {
    // 手指按下就上膛：submit 里靠这个标记判断「是登录按钮触发的」，避免
    // 同一个 form 里别的按钮顺手也发一次 submit 就被当成登录
    this._eduArmed = Date.now()
  },

  eduLoginTap() {
    this._eduArmed = Date.now()
    if (this.data.eduBusy) return
    clearTimeout(this._eduTapTimer)
    const fire = () => {
      this._eduTapTimer = null
      this.eduLogin(null)
    }
    this._eduTapFire = fire
    this._eduTapTimer = setTimeout(fire, 150)
  },

  /** 学号 + 密码 + 验证码 → 登录（会话存本机，不用再去浏览器复制 Cookie） */
  eduLogin(e) {
    clearTimeout(this._eduTapTimer)
    this._eduTapTimer = null

    const fromForm = this._eduTakeForm(e)
    if (fromForm) {
      const armed = this._eduArmed && Date.now() - this._eduArmed < 3000
      this._eduArmed = 0
      if (!armed) return // 不是登录按钮发起的 submit
    }
    if (this.data.eduBusy) return

    const stid = this.eduField('stid').trim()
    const password = this.eduField('password')
    const code = this.eduField('code').trim()
    if (!stid || !password) {
      wx.showToast({ title: '先填学号和密码', icon: 'none' })
      return
    }
    if (!code) {
      // 分开说：没取图 vs 取了没填，两种下一步动作不一样
      const hasImg = !!this.data.eduCaptcha
      const tip = hasImg
        ? '验证码还没填：把右边图上的字符（照大小写）填进左边输入框，再点一次登录'
        : '还没取验证码：先点右边方框取一张图，再照图填'
      this.setData({ 'edu.stateText': tip })
      wx.showToast({ title: hasImg ? '先填验证码' : '先取验证码', icon: 'none' })
      return
    }

    this.eduPersist()
    const base = this.eduField('base')
    // 第一次登录先把「调试模式在哪开」讲清楚：希冀在内网（http + IP），
    // 微信默认拦这类地址，不提前说，用户只会撞到一句看不懂的「请求失败」。
    if (!debugGuideSeen()) {
      markDebugGuideSeen()
      wx.showModal({
        title: '手机要先开「开发调试」',
        content:
          '希冀在学校内网（http + IP），微信默认会拦掉这种地址，所以手机这边要先打开调试模式：\n\n' +
          '① 点右上角「···」\n' +
          '② 选「开发调试」\n' +
          '③ 打开后右下角出现 vConsole 的小绿标就成功了\n\n' +
          '开好后回来点一次「登录」。只有开发版 / 体验版有这一项，正式版没有。',
        cancelText: '先去开',
        confirmText: '继续登录',
        success: (r) => {
          if (r.confirm) this._eduSubmitLogin(base, stid, password, code)
        }
      })
      return
    }
    this._eduSubmitLogin(base, stid, password, code)
  },

  /** 真正发登录请求（单独拆出来：前面那条「开调试」的引导要弹一下再接着走） */
  _eduSubmitLogin(base, stid, password, code) {
    this.setData({ eduBusy: true, 'edu.stateText': '正在登录…' })
    edu
      .login({ base: base, stid: stid, password: password, code: code })
      .then((r) => {
        this._eduInput = Object.assign({}, this._eduInput || {}, { code: '' })
        this.setData({
          eduBusy: false,
          eduCaptcha: '',
          eduCapW: 0,
          eduCodeLen: 0,
          'edu.code': '',
          'edu.logged': true,
          'edu.stateText': '已登录（学号 ' + r.stid + '）· ' + (r.homeTitle || '学生首页') + '，会话存在这台手机上'
        })
        wx.showToast({ title: '登录成功', icon: 'success' })
        // 本机直连的会话已经换新，希冀那条「要重新登录」的提醒可以撤了
        relogin.clear('educoder')
        relogin.unmute()
        this.load()
        // 顺手把内网页面的结构摸一遍：写课程/作业解析要用它，省得再手动点一次探测
        this.setData({ eduResult: '登录成功，正在探测课程 / 作业入口（十几秒）…' })
        edu
          .probe()
          .then((lines) => this.setData({ eduResult: lines.join('\n') }))
          .catch((e) => this.setData({ eduResult: '自动探测没跑完：' + (e.message || '未知错误') }))
      })
      .catch((e) => {
        const msg = (e && e.message) || '未知错误'
        // 微信拦地址这一类的失败：换验证码也没用，直接把「去哪开调试」说清楚
        if (isDomainBlocked(msg)) {
          this.setData({
            eduBusy: false,
            'edu.stateText': '没连上：按提示打开「开发调试」再登录'
          })
          this.eduShowDebugGuide(msg)
          return
        }
        this.setData({ eduBusy: false, 'edu.stateText': '登录没成功，再试一次' })
        showDetail('希冀登录失败', msg)
        // 验证码是一次性的，失败后必须换，否则再点一定还是错
        this.eduCaptcha()
      })
  },

  /**
   * 「手机怎么连内网」的引导。
   * 自动弹只在第一次登录时出现；之后从卡片上的链接点进来还能再看。
   */
  eduShowDebugGuide(extra) {
    markDebugGuideSeen()
    // 从卡片上的链接点进来时传的是 tap 事件对象，只有真正带错误文案时才拼「原始提示」
    const reason = typeof extra === 'string' ? extra : ''
    const tail = reason ? '\n\n原始提示：' + reason.replace(/\s+/g, ' ').slice(0, 160) : ''
    wx.showModal({
      title: '去哪开「开发调试」',
      content:
        '希冀在学校内网（http + IP），微信默认会拦掉这种地址。\n\n' +
        '手机上：点右上角「···」→「开发调试」，打开后右下角会出现 vConsole 的小绿标，回来再登录。\n\n' +
        '电脑上：开发者工具 → 详情 → 本地设置 → 勾选「不校验合法域名…」。\n\n' +
        '用完想关掉：在同一处再点一次「开发调试」，绿标就消失。\n\n' +
        '「开发调试」只有开发版 / 体验版才有，正式版没有这一项。' +
        tail,
      confirmText: '知道了',
      showCancel: false
    })
  },

  eduLogout() {
    edu.logout()
    this._eduInput = {}
    this.setData({
      'edu.logged': false,
      'edu.code': '',
      eduCaptcha: '',
      eduCapW: 0,
      eduCodeLen: 0,
      'edu.stateText': '已退出，会话从本机清掉了（学校那边的账号没动）'
    })
  },

  /** 探测：先摸清这台内网服务器有哪些接口能通 */
  eduProbe() {
    this.eduPersist()
    this.setData({
      eduBusy: true,
      eduResult: '探测中…（已登录的话会多花十几秒：除了首页，还会点进课程/作业入口看一眼页面结构）'
    })
    edu
      .probe()
      .then((lines) => {
        this.setData({ eduBusy: false, eduResult: lines.join('\n') })
      })
      .catch((e) => {
        this.setData({ eduBusy: false, eduResult: '探测失败：' + (e.message || '未知错误') })
      })
  },

  /** 直连抓取 + 结果推回云端 */
  eduSync() {
    const cfg = this.eduPersist()
    if (!cfg.cookie) {
      wx.showToast({ title: '先登录希冀', icon: 'none' })
      return
    }
    this.setData({ eduBusy: true })
    wx.showLoading({ title: '直连抓取中', mask: true })
    edu
      .syncAndPush()
      .then((r) => {
        wx.hideLoading()
        this.setData({
          eduBusy: false,
          'edu.lastSyncText': '上次直连同步：' + fmtTime(Date.now())
        })
        app.globalData.needRefresh = true
        this.load()
        // 顺带把「扫到几门课」说清楚：只有一条的时候，用户才分得清是平台就这么多，
        // 还是只扫了一门课
        const names = {}
        ;(r.tasks || []).forEach((t) => {
          if (t && t.courseName) names[t.courseName] = 1
        })
        const n = Object.keys(names).length
        // 希冀的列表页给不出日期，靠逐条打开详情页补（有上限，一次补十几条）。
        // 把「几条有截止 / 几条还没有」直接说出来，用户才知道要不要再点一次同步。
        const withDl = (r.tasks || []).filter((t) => t && t.deadline > 0).length
        const missDl = (r.tasks || []).length - withDl
        // 平台上已经交了的那几条：同步时按页面上的「初次提交时间 / 已批阅」
        // 自动标成已完成，这里必须说一声——否则它们会静静地从待办挪进
        // 「已完成」那一组（默认还是收起的），用户会以为任务丢了
        const doneN = r.submitted || 0
        const doneSay = doneN ? ' · ' + doneN + ' 条平台显示已提交，已自动归到「已完成」' : ''
        if (missDl) {
          // 这 M 条不是「没解析出来」：希冀的在线作业页只给「当前作业」渲染
          // 「作业时间：A 至 B」，其余作业页面上真没有。把话说清楚，
          // 免得用户以为是又坏了；轨迹留在下面，「复制详情」能直接发我
          showDetail(
            '已写入 ' + r.count + ' 项 · ' + missDl + ' 条平台没给截止时间',
            (doneN ? '有 ' + doneN + ' 条平台显示已提交，已经自动标成已完成。\n\n' : '') +
              '这 ' + missDl + ' 条在希冀的页面上没有单独的「作业时间」——平台只给「当前作业」渲染时间段，' +
              '历史作业和同页其它作业都没有，详情页也一律是空外壳。下面是这次的抓取轨迹，' +
              '如果你觉得其中某条本该有截止时间，点左下角「复制详情」发我：\n\n' +
              (r.trace || []).join('\n')
          )
        } else {
          wx.showToast({
            title: '已写入 ' + r.count + ' 项' + (n > 1 ? ' · ' + n + ' 门课' : '') + doneSay,
            icon: 'none',
            duration: 2800
          })
        }
      })
      .catch((e) => {
        wx.hideLoading()
        this.setData({ eduBusy: false })
        showDetail('直连同步失败', e.message || '未知错误')
      })
  },

  eduCopy() {
    wx.setClipboardData({
      data: this.data.eduResult || '',
      success: () => wx.showToast({ title: '已复制', icon: 'none' })
    })
  },

  /* ---------------------------------------------------------------- */
  /* 学习通 · 本地代理（方案 A）                                        */
  /* ---------------------------------------------------------------- */

  proxyInput(e) {
    this.setData({ proxyAddr: e.detail.value })
  },

  /** 把输入框里的地址落地，返回最终使用的地址 */
  proxyCommit() {
    const v = String(this.data.proxyAddr || '').trim()
    PX.setBase(v)
    const base = PX.getBase()
    if (base !== this.data.proxyAddr) this.setData({ proxyAddr: base })
    return base
  },

  /* ---------------- 课表导入：统一身份认证（APP 通道，手机一步到位） ---------------- */

  jwSchool() {
    return JW.SCHOOLS[this.data.schoolIndex] || JW.SCHOOLS[0]
  },

  onSchoolChange(e) {
    this.setData({ schoolIndex: Number(e.detail.value), jwState: '' })
  },

  onJwUser(e) {
    this.setData({ jwUser: e.detail.value })
  },

  onJwPass(e) {
    this.setData({ jwPass: e.detail.value })
  },

  jwSaveCred() {
    const username = String(this.data.jwUser || '').trim()
    if (!username) {
      wx.showToast({ title: '学号别空着', icon: 'none' })
      return
    }
    const sch = this.jwSchool()
    JW.save({ schoolId: sch.id, base: sch.base, username, password: this.data.jwPass })
    this.setData({ jwState: '已存在这台手机上，下次打开不用重填。' })
    wx.showToast({ title: '已保存', icon: 'success' })
  },

  /**
   * 登录并导入课表：走统一身份认证（APP /token/ 通道），手机上一步到位。
   */
  jwLoginImport() {
    if (this.data.jwBusy) return
    this.jwCasImport()
  },

  /**
   * 统一身份认证走云端：整个登录 + 拉课表都在云函数里跑完，手机上一步到位。
   * 走郑大 APP 的 /token/ 通道：密码登录返回约一个月的 idToken，
   * 短信二次验证的验证码由用户在小程序里填（设备验证过一次就不再收短信）。
   */
  jwCasImport() {
    const username = String(this.data.jwUser || '').trim()
    const password = String(this.data.jwPass || '')

    // 云端没登录态、这次也没填账号密码 → 提示先填
    if (!this.data.jwLogged && (!username || !password)) {
      wx.showToast({ title: '学号、密码都要填', icon: 'none' })
      return
    }

    if (username && password) {
      const sch = this.jwSchool()
      JW.save({ schoolId: sch.id, base: sch.base, username, password })
    }

    this.setData({
      jwBusy: true,
      jwResult: '',
      jwMfaShow: false,
      jwMfaCode: '',
      jwState: this.data.jwLogged ? '正在拉取门户课表…' : '正在登录统一认证…'
    })

    api
      .zzuAuto({ username, password })
      .then((r) => this.jwApply(r, 'cas'))
      .catch((e) => this.jwFail(e))
  },

  /**
   * 希冀直连 / 课表导入两块内容都很长（表单 + 说明 + 结果），默认收起来，
   * 头部只留标题和「已登录/未登录」状态，页面短一大截。
   */
  toggleEdu() {
    this.setData({ eduOpen: !this.data.eduOpen })
  },

  toggleJw() {
    this.setData({ jwOpen: !this.data.jwOpen })
  },

  /** 两种来源的返回结构统一处理，省得两套分支各写一遍 */
  jwApply(r, via) {
    if (r && r.success) {
      const res = TT.mergeJw(r)
      const sem = r.semesterName ? '（' + r.semesterName + '）' : ''
      this.setData({
        jwBusy: false,
        jwCapImg: '',
        jwCap: '',
        jwMfaShow: false,
        jwMfaCode: '',
        jwPhone: '',
        jwLogged: via === 'cas' ? true : this.data.jwLogged,
        jwName: r.name || r.loginName || this.data.jwName,
        jwState: '导入成功',
        jwResult:
          '课表 ' + res.added + ' 节已写进本机' + sem +
          (res.kept ? '，保留了 ' + res.kept + ' 节手动加的' : '') +
          (res.termStart ? '｜开学日校准为 ' + res.termStart : '') +
          '｜来源 ' + (via === 'cas' ? '统一身份认证 · 门户课表' : r.via || '—')
      })
      wx.showToast({ title: '导入 ' + res.added + ' 节', icon: 'success' })
      return
    }

    // 短信验证码已经在路上：亮出验证码输入区，用户填完点「验证并导入」
    const needMfaCode = !!(r && r.needMfaCode)
    // 接力态没了（过期 / 没先走登录）：收起输入区，让用户重新点登录
    const needRestart = !!(r && r.needRestart)
    const msg = (r && (r.message || r.error)) || '没成'
    // 失败轨迹（服务端每一步的走向）附在结果里，排查时一键复制
    const chainText = Array.isArray(r && r.chain) && r.chain.length
      ? '\n—— 轨迹 ——\n' + r.chain.join('\n')
      : ''

    this.setData({
      jwBusy: false,
      jwCapImg: '',
      jwCap: '',
      jwLogged: false,
      jwState: msg,
      jwResult: ((r && r.hint) || '') + chainText,
      jwMfaShow: needRestart ? false : needMfaCode || this.data.jwMfaShow,
      jwPhone: needMfaCode ? (r.phone || '') : this.data.jwPhone
    })
    if (needMfaCode) {
      wx.showToast({ title: '验证码已发送', icon: 'none' })
    }
  },

  /* ---- 统一认证 · 短信二次验证 ---- */

  onJwMfaCode(e) {
    this.setData({ jwMfaCode: e.detail.value })
  },

  /** 验证码填好了，交上去；成功会走到 jwApply 的 success 分支 */
  jwMfaVerify() {
    if (this.data.jwBusy) return
    const code = String(this.data.jwMfaCode || '').trim()
    if (!code) {
      wx.showToast({ title: '先填验证码', icon: 'none' })
      return
    }
    this.setData({ jwBusy: true, jwState: '正在验证…', jwResult: '' })
    api
      .zzuMfaVerify(code)
      .then((r) => this.jwApply(r, 'cas'))
      .catch((e) => this.jwFail(e))
  },

  /** 没收到短信就点这个重发 */
  jwMfaResend() {
    if (this.data.jwBusy) return
    this.setData({ jwBusy: true, jwState: '正在重发验证码…' })
    api
      .zzuMfaVerify('', true)
      .then((r) => {
        this.setData({
          jwBusy: false,
          jwState: (r && r.message) || '已重发',
          jwResult: (r && r.hint) || '',
          // 会话已失效就不用再亮着输入框了，重新登录即可
          jwMfaShow: !(r && r.needRestart)
        })
        wx.showToast({ title: (r && r.message) || '已重发', icon: 'none' })
      })
      .catch((e) => this.jwFail(e))
  },

  jwFail(e) {
    this.setData({
      jwBusy: false,
      jwState: '失败',
      jwResult: (e && e.message) || String(e)
    })
  },

  /** 云端的登录态要不要清掉（换账号、或怀疑过期时点一下） */
  jwCasLogout() {
    wx.showModal({
      title: '清掉云端登录态？',
      content: '清掉后下次拉课表要重新填一次学号密码和验证码。',
      success: (r) => {
        if (!r.confirm) return
        api
          .zzuLogout()
          .then(() => {
            this.setData({ jwLogged: false, jwName: '', jwState: '已清掉云端登录态' })
            wx.showToast({ title: '已清除', icon: 'success' })
          })
          .catch((e) => wx.showToast({ title: (e && e.message) || '清除失败', icon: 'none' }))
      }
    })
  },

  proxyPing() {
    const base = this.proxyCommit()
    this.setData({ proxyBusy: true, proxyResult: '' })
    wx.showLoading({ title: '检测中', mask: true })
    PX.ping()
      .then((r) => {
        wx.hideLoading()
        this.setData({
          proxyBusy: false,
          proxyResult: '✅ 连上了：' + base + '\n本地代理 v' + (r.version || '?') + ' 正在运行'
        })
      })
      .catch((e) => {
        wx.hideLoading()
        this.setData({ proxyBusy: false, proxyResult: '❌ ' + (e.message || '连不上') })
      })
  },

  proxyQr() {
    this.stopProxyPoll()
    this.proxyCommit()
    this.setData({ proxyBusy: true, proxyState: '正在生成二维码…', proxyStateCls: '' })
    PX.qrStart()
      .then((r) => {
        this.setData({
          proxyBusy: false,
          proxyQr: r.qr,
          proxyState: '用「学习通」App 扫码',
          proxyStateCls: ''
        })
        this.startProxyPoll(r.token)
      })
      .catch((e) => {
        this.setData({
          proxyBusy: false,
          proxyQr: '',
          proxyState: e.message || '生成失败',
          proxyStateCls: 'err'
        })
      })
  },

  startProxyPoll(token) {
    let tries = 0
    this.proxyTimer = setInterval(() => {
      tries++
      if (tries > 80) {
        this.stopProxyPoll()
        this.setData({ proxyState: '二维码超时了，点「刷新二维码」重来', proxyStateCls: 'err' })
        return
      }
      PX.qrPoll(token)
        .then((r) => {
          if (r.state === 'scanned') {
            this.setData({ proxyState: '已扫码，请在手机上点「确认登录」', proxyStateCls: 'warn' })
          } else if (r.state === 'ok') {
            this.stopProxyPoll()
            const keys = (r.keys || []).join(',')
            this.setData({
              proxyLive: true,
              proxyQr: '',
              proxyState: '',
              proxyStateCls: '',
              proxyResult:
                '✅ 登录成功' +
                (r.nickname ? '：' + r.nickname : '') +
                '\nCookie 字段：' + keys +
                '\n\n下一步点「抓课程列表」，能返回课程就说明链路通了。'
            })
            if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })
            wx.showToast({ title: '登录成功', icon: 'success' })
          } else if (r.state === 'expired' || r.state === 'error') {
            this.stopProxyPoll()
            this.setData({ proxyState: r.message || '二维码失效', proxyStateCls: 'err' })
          }
        })
        .catch(() => {
          /* 单次轮询失败不打断，下一轮继续 */
        })
    }, 2500)
  },

  stopProxyPoll() {
    if (this.proxyTimer) {
      clearInterval(this.proxyTimer)
      this.proxyTimer = null
    }
  },

  /** 只抓课程列表：验证登录态被不被超星认可 */
  proxyCourses() {
    this.proxyCommit()
    this.setData({ proxyBusy: true, proxyResult: '正在抓课程列表…' })
    wx.showLoading({ title: '抓取中', mask: true })
    PX.courses()
      .then((r) => {
        wx.hideLoading()
        const alive = r.alive === null || r.alive === undefined ? '未知' : r.alive ? '是' : '否'
        let text =
          '课程数：' + r.count +
          '\n登录态存活：' + alive +
          '\nCookie 字段：' + r.cookieKeys +
          '\n轨迹：' + r.trace
        if (r.count) {
          text += '\n\n' + r.courses.map((c, i) => i + 1 + '. ' + c.name).join('\n')
        } else {
          text += '\n\n没读到课程。把这段发我，我按真实返回调接口。'
        }
        this.setData({
          proxyBusy: false,
          proxyLive: r.alive === true || r.count > 0,
          proxyResult: text
        })
      })
      .catch((e) => {
        wx.hideLoading()
        this.setData({ proxyBusy: false, proxyResult: '❌ ' + (e.message || '抓取失败') })
      })
  },

  /** 抓任务 → 上传云端 */
  proxySync() {
    this.proxyCommit()
    const LIMIT = 10
    this.setData({ proxyBusy: true, proxyResult: '正在抓任务（最多 ' + LIMIT + ' 门课），可能要半分钟…' })
    wx.showLoading({ title: '抓取中', mask: true })
    let raw = null
    let pushed = null
    PX.sync(LIMIT)
      .then((r) => {
        raw = r
        if (!r.tasks || !r.tasks.length) throw new Error('本地抓到 0 项任务')
        return api.pushTasks('chaoxing', r.tasks, 'proxy')
      })
      .then((res) => {
        pushed = res
        // 上传完再回读一次云端，确认数据真的落地了 —— 「抓到了但首页没有」就是这一步查出来的
        return api.getDashboard().catch(() => null)
      })
      .then((dash) => {
        wx.hideLoading()
        app.globalData.needRefresh = true
        const errs = (raw && raw.errors) || []
        this.setData({
          proxyBusy: false,
          proxyLive: true,
          proxyResult:
            '✅ 本地抓到 ' + raw.count + ' 项，已上传 ' + ((pushed && pushed.count) || 0) + ' 项到云端。\n' +
            '回首页下拉刷新就能看到。\n\n抓取明细：\n' + (raw.debug || []).join('\n') +
            (errs.length ? '\n\n⚠️ 有课程没抓全：\n' + errs.join('\n') : '') +
            '\n\n' + this.cloudBrief(dash)
        })
        wx.showToast({ title: '已上传', icon: 'success' })
        this.load()
      })
      .catch((e) => {
        wx.hideLoading()
        this.setData({ proxyBusy: false, proxyResult: '❌ ' + (e.message || '抓取失败') })
      })
  },

  /** 云端回读摘要：按课程列出云端到底存了多少，一眼看出有没有漏课 */
  cloudBrief(dash) {
    if (!dash) return '云端自检：读取失败（不影响已上传的数据）'
    const tasks = (dash.tasks || []).filter((t) => t.platform === 'chaoxing')
    if (!tasks.length) return '云端自检：学习通名下 0 项，说明这次上传没落库'

    const map = {}
    tasks.forEach((t) => {
      const k = t.courseName || '未命名课程'
      if (!map[k]) map[k] = { all: 0, todo: 0 }
      map[k].all += 1
      if (t.status !== 'done') map[k].todo += 1
    })
    const lines = Object.keys(map)
      .sort((a, b) => map[b].todo - map[a].todo)
      .map((k) => '  · ' + k + '：' + map[k].all + ' 项' + (map[k].todo ? '（待做 ' + map[k].todo + '）' : ''))

    return '云端自检：学习通共 ' + tasks.length + ' 项\n' + lines.join('\n')
  },

  proxyCopyResult() {
    wx.setClipboardData({
      data: this.data.proxyResult || '',
      success: () => wx.showToast({ title: '已复制', icon: 'none' })
    })
  },

  jwCopyResult() {
    wx.setClipboardData({
      data: this.data.jwResult || '',
      success: () => wx.showToast({ title: '已复制', icon: 'none' })
    })
  },

  /* ---------------- U校园 扫码 ---------------- */

  upLogin() {
    this.proxyCommit()
    this.stopUpPoll()
    this.setData({ upBusy: true, upQr: '', upState: '正在生成二维码…' })
    PX.upStart()
      .then((r) => {
        this.setData({ upQr: r.qr, upState: '用手机上的「U校园」App 扫一扫' })
        this.startUpPoll(r.token)
      })
      .catch((e) => {
        this.setData({ upBusy: false, upState: '❌ ' + (e.message || '生成失败') })
      })
  },

  startUpPoll(token) {
    let ticks = 0
    this.upTimer = setInterval(() => {
      ticks += 1
      if (ticks > 80) {
        this.stopUpPoll()
        this.setData({ upBusy: false, upState: '二维码超时了，点「刷新二维码」重来' })
        return
      }
      PX.upPoll(token)
        .then((r) => {
          if (!r) return
          this.setData({ upState: r.message || '' })
          if (r.state === 'ok') {
            this.stopUpPoll()
            this.setData({ upBusy: false, upQr: '', upState: '登录成功，正在保存…' })
            if (!r.cookie) {
              this.setData({ upState: '❌ 登录成功但没拿到 Cookie，把这次结果发我' })
              return
            }
            this.doSave(
              'unipus',
              { mode: 'cookie', username: 'U校园扫码', password: '', cookie: r.cookie },
              r.cookie
            )
          } else if (r.state === 'expired' || r.state === 'error') {
            this.stopUpPoll()
            this.setData({ upBusy: false })
          }
        })
        .catch(() => {
          /* 网络抖一下就算了，下一轮继续 */
        })
    }, 2000)
  },

  stopUpPoll() {
    if (this.upTimer) {
      clearInterval(this.upTimer)
      this.upTimer = null
    }
  },

  onUnload() {
    this.stopUpPoll()
  },

  onHide() {
    this.stopUpPoll()
  },

  removeAccount(e) {
    const id = e.currentTarget.dataset.id
    const name = e.currentTarget.dataset.name
    const key = e.currentTarget.dataset.key
    wx.showModal({
      title: '解绑' + name,
      content: '解绑后会删除该平台已抓取的任务记录，确定吗？',
      confirmColor: '#D6453B',
      success: (r) => {
        if (!r.confirm) return
        wx.showLoading({ title: '处理中', mask: true })
        api
          .removeAccount(id)
          .then(() => {
            wx.hideLoading()
            // 解绑了就别再提醒它登录：那条记录留着会在首页挂一个不存在的平台
            if (key) relogin.clear(key)
            app.globalData.needRefresh = true
            this.load()
            wx.showToast({ title: '已解绑', icon: 'success' })
          })
          .catch((err) => {
            wx.hideLoading()
            wx.showModal({ title: '解绑失败', content: err.message, showCancel: false })
          })
      }
    })
  },

  reSync(e) {
    const key = e.currentTarget.dataset.key
    /*
     * 希冀是校园内网（10.67.4.x），云函数在公网机房根本连不上，
     * 走 api.sync 只会拿回一句「已跳过」。所以这里直接转给本机直连，
     * 和希冀卡片里那颗「直连同步」是同一条路。
     */
    if (key === 'educoder') {
      this.eduSync()
      return
    }
    wx.showLoading({ title: '同步中', mask: true })
    api
      .sync(key)
      .then((res) => {
        wx.hideLoading()
        app.globalData.needRefresh = true
        const errs = (res && res.errors) || []
        const skipped = (res && res.skipped) || []
        if (errs.length) {
          // 「立即同步」也会撞上登录过期：记下来，这张卡和首页才会亮提醒
          relogin.note(key, errs.join(' '))
          showDetail('同步失败', errs.join('\n'))
        } else if (skipped.length) {
          showDetail(
            '这个平台只能在手机上抓',
            skipped.join('\n') + '\n\n展开该平台的卡片，用里面的「本地代理」或「直连同步」抓一次。'
          )
        } else {
          relogin.clear(key)
          wx.showToast({ title: `已更新 ${res.count || 0} 项`, icon: 'success' })
        }
        this.load()
      })
      .catch((err) => {
        wx.hideLoading()
        showDetail('同步失败', err.message)
      })
  },

  copyHint() {
    wx.setClipboardData({
      data: '打开浏览器登录对应平台 → F12 → Network → 任意请求的 Request Headers → 复制 Cookie 整行内容',
      success: () => wx.showToast({ title: '已复制', icon: 'none' })
    })
  },

  /* ---------------- 扫码登录 ---------------- */

  /** 取一张新二维码，成功后开始轮询 */
  startQr() {
    this.stopPoll()
    this.qrToken = ''
    this.setData({ qrImage: '', qrState: 'loading', qrMessage: '正在获取二维码…' })

    api
      .qrStart()
      .then((res) => {
        this.qrToken = res.token
        this.setData({
          qrImage: res.qr,
          qrState: 'waiting',
          qrMessage: '请用手机扫码'
        })
        this.schedulePoll()
      })
      .catch((e) => {
        this.setData({
          qrState: 'error',
          qrMessage: (e && e.message) || '获取二维码失败'
        })
      })
  },

  schedulePoll() {
    this.stopPoll()
    if (!this.qrToken) return
    this.pollTimer = setTimeout(() => this.doPoll(), 2200)
  },

  doPoll() {
    if (!this.qrToken) return
    const token = this.qrToken

    api
      .qrPoll(token)
      .then((res) => {
        // 期间用户可能已经刷新了二维码，旧会话的结果直接丢弃
        if (token !== this.qrToken) return

        if (res.state === 'waiting') {
          this.schedulePoll()
          return
        }
        if (res.state === 'scanned') {
          this.setData({ qrState: 'scanned', qrMessage: '已扫码，请在手机上点「确认登录」' })
          wx.vibrateShort({ type: 'light' })
          this.schedulePoll()
          return
        }
        if (res.state === 'ok') {
          this.onQrOk(res)
          return
        }

        // expired / error
        this.stopPoll()
        this.qrToken = ''
        this.setData({
          qrState: res.state === 'error' ? 'error' : 'expired',
          qrMessage: res.message || '二维码已失效，请刷新'
        })
      })
      .catch(() => {
        // 网络抖一下不算失败，继续轮询
        if (token === this.qrToken) this.schedulePoll()
      })
  },

  stopPoll() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
  },

  onQrOk(res) {
    this.stopPoll()
    this.qrToken = ''
    this.setData({ qrState: 'ok', qrMessage: '登录成功', editing: '', saving: false })
    app.globalData.needRefresh = true
    this.load()

    const errs = (res && res.errors) || []
    if (errs.length) {
      showDetail('登录成功，但抓取失败', errs.join('\n'))
    } else {
      wx.showToast({ title: '同步到 ' + (res.count || 0) + ' 项任务', icon: 'none' })
    }
  }
})
