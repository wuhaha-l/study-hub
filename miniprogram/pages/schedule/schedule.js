const SCOPE = require('../../utils/scope.js')
const S = require('../../utils/schedule')
const api = require('../../utils/api')
const TT = require('../../utils/timetable')
const JW = require('../../utils/jwcred')
const AUTH = require('../../utils/auth')
const theme = require('../../utils/theme')

const KEY = 'timetable_v1'
const TERM_KEY = 'timetable_term'
const PERIOD_OPTIONS = ['1-2 节', '3-4 节', '5-6 节', '7-8 节', '9-10 节', '11-12 节']
const DAY_OPTIONS = S.DAY_NAMES.map((d) => '周' + d)
const PARITY_OPTIONS = ['每周都上', '单周', '双周']

function todayStr() {
  const d = new Date()
  const m = d.getMonth() + 1
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (d.getDate() < 10 ? '0' + d.getDate() : d.getDate())
}

function periodRange(label) {
  const m = String(label || '').match(/(\d+)\s*-\s*(\d+)/)
  return m ? { start: Number(m[1]), end: Number(m[2]) } : { start: 0, end: 0 }
}

/** '1-16' / '1~16' / '3' → {from,to} */
function parseWeeksInput(v) {
  const s = String(v || '').trim()
  if (!s) return null
  const m = s.match(/(\d{1,2})\s*[-~—－–至到]\s*(\d{1,2})/)
  if (m) {
    const a = Number(m[1])
    const b = Number(m[2])
    return { from: Math.min(a, b), to: Math.max(a, b) }
  }
  const one = s.match(/(\d{1,2})/)
  if (!one) return null
  return { from: Number(one[1]), to: Number(one[1]) }
}

Page({
  data: {
    // 访客只能粘贴/手动加，教务导入那条路要学号
    isGuest: false,
    // 网格
    grid: { rows: [], days: [], rowH: 54, bodyH: 540 },
    weekNo: 0,
    thisWeek: 1,
    isThisWeek: true,
    weekDates: '',
    weekOptions: [],
    weekIndex: 0,
    total: 0,
    termStart: '',
    termStartLabel: '',

    // 面板：'' | 'import' | 'add' | 'setting'
    sheet: '',
    text: '',
    seen: 0,

    dayIndex: 0,
    periodIndex: 0,
    parityIndex: 0,
    dayOptions: DAY_OPTIONS,
    periodOptions: PERIOD_OPTIONS,
    parityOptions: PARITY_OPTIONS,
    formName: '',
    formPlace: '',
    formWeeks: '',

    // 点开的课程块
    detail: null,

    // 教务拉取
    jwState: '',
    jwStateCls: '',
    jwBusy: false,

    theme: 'light',
    tip: ''
  },

  onLoad() {
    theme.apply(this)
    this.setData({ isGuest: AUTH.isGuest() })
    this.reload()
  },

  onShow() {
    // 别处切了主题回来也要跟着换
    theme.apply(this)
    this.setData({ isGuest: AUTH.isGuest() })
    this.reload()
  },

  /** 设置面板里的深色模式开关 */
  onThemeChange(e) {
    const next = e.detail.value ? 'dark' : 'light'
    wx.setStorageSync('theme_v1', next)
    theme.apply(this)
    this.reload()
  },

  /* ---------------- 存取 ---------------- */

  readItems() {
    const v = wx.getStorageSync(SCOPE.key(KEY))
    return Array.isArray(v) ? v : []
  },

  writeItems(items) {
    wx.setStorageSync(SCOPE.key(KEY), items)
    this.reload()
  },

  readTerm() {
    const v = wx.getStorageSync(SCOPE.key(TERM_KEY))
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ''
  },

  /** 没设过开学日期就默认「本周为第 1 周」，至少网格能看 */
  termStartDate() {
    const t = this.readTerm()
    return t ? new Date(t + 'T00:00:00') : S.mondayOf(new Date())
  },

  reload() {
    const items = this.readItems()
    const term = this.termStartDate()
    const thisWeek = Math.max(1, S.weekNoOf(new Date(), term))
    let weekNo = this.data.weekNo || thisWeek
    if (weekNo > 30) weekNo = thisWeek

    const grid = S.gridOf(items, weekNo, {
      termStart: term,
      now: new Date(),
      dark: this.data.theme === 'dark'
    })

    // 这一周的日期范围
    const monday = new Date(S.mondayOf(term))
    monday.setDate(monday.getDate() + (weekNo - 1) * 7)
    const sunday = new Date(monday)
    sunday.setDate(monday.getDate() + 6)
    const weekDates = S.fmtMD(monday) + ' - ' + S.fmtMD(sunday)

    const weekOptions = []
    for (let i = 1; i <= 30; i++) weekOptions.push('第 ' + i + ' 周')

    this.setData({
      grid,
      weekNo,
      thisWeek,
      isThisWeek: weekNo === thisWeek,
      weekDates,
      weekOptions,
      weekIndex: weekNo - 1,
      total: items.length,
      termStart: this.readTerm(),
      termStartLabel: this.readTerm() ? S.fmtMD(term) + ' 开学' : '未设置开学日期'
    })
  },

  /* ---------------- 周次切换 ---------------- */

  onPrevWeek() {
    if (this.data.weekNo <= 1) return
    this.setData({ weekNo: this.data.weekNo - 1 }, () => this.reload())
  },

  onNextWeek() {
    if (this.data.weekNo >= 30) return
    this.setData({ weekNo: this.data.weekNo + 1 }, () => this.reload())
  },

  onWeekPick(e) {
    this.setData({ weekNo: Number(e.detail.value) + 1 }, () => this.reload())
  },

  onThisWeek() {
    this.setData({ weekNo: 0 }, () => this.reload())
  },

  /* ---------------- 面板 ---------------- */

  openSheet(e) {
    const which = e.currentTarget.dataset.sheet || 'add'
    // 访客没有学号，教务导入这条路直接拦（入口也藏了，这里兜个底）
    if (which === 'jw' && this.data.isGuest) {
      wx.showModal({
        title: '教务导入要学校账号',
        content: '访客身份用不了教务系统。可以「粘贴导入」，或者手动一节一节加。',
        showCancel: false,
        confirmText: '知道了'
      })
      return
    }
    this.setData({ sheet: which })
  },

  closeSheet() {
    this.setData({ sheet: '', detail: null })
  },

  noop() {},

  /* ---------------- 粘贴导入 ---------------- */

  onText(e) {
    this.setData({ text: e.detail.value })
  },

  doImport() {
    const text = String(this.data.text || '').trim()
    if (!text) {
      wx.showToast({ title: '先把课表粘进来', icon: 'none' })
      return
    }
    const r = S.parseText(text)
    this.setData({ seen: r.items.length })

    if (!r.items.length) {
      wx.showModal({
        title: '一行都没认出来',
        content:
          '每行至少要有一个「周几」和课程名，例如：\n周一 1-2节 汇编语言 松园3-201 1-16周\n\n也支持逗号分隔：\n星期二,第3-4节,大学英语,北3-105 1-16周(单)',
        showCancel: false
      })
      return
    }

    const old = this.readItems()
    const merged = old.slice()
    let added = 0
    r.items.forEach((it) => {
      const key = [it.day, it.start, it.end, it.name].join('|')
      if (merged.some((x) => x.id === key)) return
      merged.push(Object.assign({}, it, { id: key }))
      added += 1
    })
    merged.sort((a, b) => a.day - b.day || (a.start || 99) - (b.start || 99))
    this.writeItems(merged)

    this.setData({ text: '', sheet: '' })
    wx.showToast({
      title: '新增 ' + added + ' 节' + (r.skipped ? '，跳过 ' + r.skipped + ' 行' : ''),
      icon: 'none',
      duration: 2200
    })
  },

  /* ---------------- 手动添加 ---------------- */

  onDay(e) {
    this.setData({ dayIndex: Number(e.detail.value) })
  },

  onPeriod(e) {
    this.setData({ periodIndex: Number(e.detail.value) })
  },

  onParity(e) {
    this.setData({ parityIndex: Number(e.detail.value) })
  },

  onName(e) {
    this.setData({ formName: e.detail.value })
  },

  onPlace(e) {
    this.setData({ formPlace: e.detail.value })
  },

  onFormWeeks(e) {
    this.setData({ formWeeks: e.detail.value })
  },

  doAdd() {
    const name = String(this.data.formName || '').trim()
    if (!name) {
      wx.showToast({ title: '课程名不能空', icon: 'none' })
      return
    }
    const day = this.data.dayIndex + 1
    const r = periodRange(PERIOD_OPTIONS[this.data.periodIndex])
    const id = [day, r.start, r.end, name].join('|')
    const w = parseWeeksInput(this.data.formWeeks)
    const parity = this.data.parityIndex
    const items = this.readItems().filter((x) => x.id !== id)
    items.push({
      id,
      day,
      start: r.start,
      end: r.end,
      name,
      place: String(this.data.formPlace || '').trim(),
      weeks: w || parity ? { from: (w && w.from) || 1, to: (w && w.to) || 30, parity } : null
    })
    items.sort((a, b) => a.day - b.day || (a.start || 99) - (b.start || 99))
    this.writeItems(items)
    this.setData({ formName: '', formPlace: '', formWeeks: '', sheet: '' })
    wx.showToast({ title: '已添加', icon: 'success' })
  },

  /* ---------------- 课程块 ---------------- */

  onBlockTap(e) {
    const id = e.currentTarget.dataset.id
    const item = this.readItems().find((x) => x.id === id)
    if (!item) return
    this.setData({
      detail: {
        id: item.id,
        name: item.name,
        place: item.place || '',
        period: S.periodLabel(item.start, item.end) + ' 节',
        dayLabel: '周' + S.DAY_NAMES[item.day - 1],
        weeksLabel: S.weeksText(item.weeks) || '每周'
      }
    })
  },

  /** 详情弹层里的重命名（和长按菜单同一条路） */
  doRenameDetail() {
    const d = this.data.detail
    if (!d) return
    const item = this.readItems().find((x) => x.id === d.id)
    if (item) this.doRename(item)
  },

  onBlockLong(e) {
    const id = e.currentTarget.dataset.id
    const item = this.readItems().find((x) => x.id === id)
    if (!item) return
    const canSplit = S.weekListOf(item.weeks).length > 1
    const acts = ['重命名']
    if (canSplit) acts.push('按周拆分（每次实验单独一格）')
    acts.push('删除这节课')
    wx.showActionSheet({
      itemList: acts,
      itemColor: '#4C45D6',
      success: (r) => {
        const a = acts[r.tapIndex]
        if (a === '重命名') this.doRename(item)
        else if (a.indexOf('拆分') > -1) this.doSplit(item)
        else this.removeById(item.id)
      }
    })
  },

  /** 重命名：给拆出来的实验格子起真正的实验名 */
  doRename(item) {
    wx.showModal({
      title: '重命名这节课',
      editable: true,
      content: item.name,
      placeholderText: item.name,
      confirmColor: '#4C45D6',
      success: (r) => {
        if (!r.confirm) return
        const name = String(r.content || '').trim()
        if (!name || name === item.name) return
        const items = this.readItems().map((x) =>
          x.id === item.id
            ? Object.assign({}, x, { id: [x.day, x.start, x.end, name].join('|'), name, manual: true })
            : x
        )
        this.writeItems(items)
        wx.showToast({ title: '已重命名', icon: 'success' })
      }
    })
  },

  /** 按周拆分：实验课这种「每周做不同实验」的，拆成单周格子后逐个重命名 */
  doSplit(item) {
    const parts = S.splitByWeek(item)
    if (!parts.length) return
    wx.showModal({
      title: '按周拆分',
      content:
        '拆成 ' + parts.length + ' 个单周的格子（第 ' + parts[0].weeks.from + '~' + parts[parts.length - 1].weeks.to +
        ' 周各自一格），拆完长按每一格就能重命名成实验名。拆吗？',
      confirmColor: '#4C45D6',
      success: (r) => {
        if (!r.confirm) return
        const items = this.readItems()
          .filter((x) => x.id !== item.id)
          .concat(parts.map((p) => Object.assign(p, { manual: true })))
        this.writeItems(items)
        this.setData({ detail: null })
        wx.showToast({ title: '已拆成 ' + parts.length + ' 格', icon: 'none', duration: 2200 })
      }
    })
  },

  removeById(id) {
    this.writeItems(this.readItems().filter((x) => x.id !== id))
    this.setData({ detail: null })
    wx.showToast({ title: '已删除', icon: 'none' })
  },

  doRemove() {
    const d = this.data.detail
    if (!d) return
    wx.showModal({
      title: '删除这节课',
      content: d.name + '（' + d.dayLabel + ' ' + d.period + '）',
      confirmColor: '#D6453B',
      success: (r) => {
        if (r.confirm) this.removeById(d.id)
      }
    })
  },

  /* ---------------- 教务系统拉取 ---------------- */

  goPasteImport() {
    this.setData({ sheet: 'import' })
  },

  goPasteJw() {
    this.goPasteImport()
  },

  /**
   * 课表诊断：把「教务实际给了什么」摆出来。
   * 课表不完整时，看这里能直接分清是教务数据缺、还是解析丢了：
   * 每门课一行，列出全部时间位和精确到周的排课。
   */
  doTableDebug() {
    if (this.data.jwBusy) return
    this.setData({ jwBusy: true, jwState: '正在取上次拉取的课表数据…', jwStateCls: '' })
    api
      .zzuTableDebug()
      .then((d) => {
        const s = d && d.summary
        if (!s) {
          this.setData({
            jwBusy: false,
            jwStateCls: 'err',
            jwState: (d && d.message) || '还没有记录，先点一次「拉取课表」。'
          })
          return
        }
        const head =
          (s.weeks ? '教务数据覆盖第 ' + s.weeks[0] + '-' + s.weeks[1] + ' 周，共 ' + s.courses + ' 门课 / ' + s.lessons + ' 条排课记录' : '教务没给排课记录') +
          (s.termStart ? '，开学日 ' + s.termStart : '')
        const body = Object.keys(s.byName || {}).map(
          (k) =>
            k + '：' + s.byName[k].join('；') +
            (s.textByName && s.textByName[k] ? '\n（教务声明：' + s.textByName[k] + '）' : '') +
            (s.sparseRaw && s.sparseRaw[k] && s.sparseRaw[k].length
              ? '\n（教务明细原文：' + JSON.stringify(s.sparseRaw[k]).slice(0, 400) + '）'
              : '')
        )
        const text = [head]
          .concat(body)
          .concat(s.noSchedule && s.noSchedule.length ? ['没排上课表：' + s.noSchedule.join('、')] : [])
          .concat(s.textBased && s.textBased.length ? ['明细不全、按声明补全：' + s.textBased.join('、')] : [])
          .join('\n')

        this.setData({ jwBusy: false, jwStateCls: 'ok', jwState: text })
        wx.setClipboardData({
          data: text,
          success: () => wx.showToast({ title: '诊断已复制，可发给开发者', icon: 'none', duration: 2200 })
        })
      })
      .catch((e) => {
        this.setData({
          jwBusy: false,
          jwStateCls: 'err',
          jwState: '诊断失败：' + ((e && e.message) || String(e))
        })
      })
  },

  /**
   * 拉课表。整个登录 + 抓取都在云函数里跑，手机上不需要电脑配合。
   * 按「最省事」的顺序试：
   *   1. 云端还留着登录态（CASTGC，14 天）→ 直接拉
   *   2. 没登录态但手机里存过学号密码 → 让云端自动登一次
   *   3. 都没有 / 要验证码 → 引导去「登录设置」填一次
   */
  doJwPull() {
    if (this.data.jwBusy) return
    this.setData({ jwBusy: true, jwState: '正在从门户拉课表…', jwStateCls: '' })

    const cred = JW.get()

    const viaCloud = () =>
      api.zzuStatus().then((st) => (st && st.loggedIn ? api.zzuSchedule() : null))

    const viaCred = () => {
      if (!cred.username || !cred.password) return Promise.resolve(null)
      return api.zzuAuto({ username: cred.username, password: cred.password })
    }

    viaCloud()
      .catch(() => null)
      .then((r) => (r && r.success ? r : viaCred()))
      .then((r) => {
        if (!r) {
          this.setData({
            jwBusy: false,
            jwStateCls: 'err',
            jwState:
              '还没登录过。去「登录设置 → 课表导入 → 统一身份认证」填一次学号密码，之后这里点一下就导。'
          })
          return
        }

        if (r.success && (r.items || []).length) {
          const n = this.mergeJwItems(r)
          const sem = r.semesterName ? '（' + r.semesterName + '）' : ''
          this.setData({
            jwBusy: false,
            jwStateCls: 'ok',
            jwState:
              '已导入 ' + n + ' 节' + sem + (r.termStart ? '，开学日 ' + r.termStart : '') +
              (r.message ? '。' + r.message : '')
          })
          wx.showToast({ title: '导入 ' + n + ' 节', icon: 'success' })
          setTimeout(() => this.setData({ sheet: '' }), 700)
          return
        }

        // 撞到二次验证（郑大 CAS 现在强制短信/扫码）—— 引导去登录设置页拿票据
        if (r.needMfa) {
          this.setData({
            jwBusy: false,
            jwStateCls: 'err',
            jwState:
              '学校要短信/扫码二次验证。去「登录设置 → 课表导入」，用「登录票据」那条路（浏览器登录门户拿 CASTGC 粘进来），过一次能免密用 14 天。'
          })
          return
        }

        this.setData({
          jwBusy: false,
          jwStateCls: 'err',
          jwState: r.message || r.error || '门户那边没拿到课表，稍后再点一次。'
        })
      })
      .catch((e) => {
        this.setData({
          jwBusy: false,
          jwStateCls: 'err',
          jwState: (e && e.message) || String(e) || '拉取失败'
        })
      })
  },

  /**
   * 教务数据覆盖同一时间位的旧课（教务是权威），其余手动的保留。
   * 合并规则收在 utils/timetable.js，登录设置页也走同一份。
   */
  mergeJwItems(r) {
    const res = TT.mergeJw(r)
    if (res.termStart) this.setData({ weekNo: 0 })
    this.reload()
    return res.added
  },

  /* ---------------- 设置 ---------------- */

  onTermStart(e) {
    const v = e.detail.value
    wx.setStorageSync(SCOPE.key(TERM_KEY), v)
    this.setData({ weekNo: 0 }, () => this.reload())
    wx.showToast({ title: '已设置第 1 周', icon: 'none' })
  },

  doClear() {
    wx.showModal({
      title: '清空课表',
      content: '会删掉全部 ' + this.data.total + ' 节课，确定吗？',
      confirmColor: '#D6453B',
      success: (r) => {
        if (!r.confirm) return
        this.writeItems([])
        this.setData({ sheet: '' })
        wx.showToast({ title: '已清空', icon: 'none' })
      }
    })
  }
})
