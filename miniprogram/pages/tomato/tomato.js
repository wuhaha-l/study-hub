const T = require('../../utils/tomato')
const theme = require('../../utils/theme')
const app = getApp()

// 计时刷新间隔：500ms 够顺滑，又不会太耗电
const TICK_MS = 500

// 统计图的时间粒度：近 7 天 / 近 6 周 / 近 6 个月 / 近 4 年
// t 是页签上的短字（一颗 4 个「近 7 天」会挤成一团），name 留给脚注说全
const CHART_TABS = [
  { k: 'day', t: '日', name: '近 7 天' },
  { k: 'week', t: '周', name: '近 6 周' },
  { k: 'month', t: '月', name: '近 6 个月' },
  { k: 'year', t: '年', name: '近 4 年' }
]

// 统计口径：学习 / 休息 / 生活（跟待办标签一一对应）
const KIND_TABS = T.TAGS.map((x) => ({ k: x.k, t: x.t, color: x.color }))

// 自定义时长里给的快速选项，省得每次敲键盘
const PRESETS = { focus: [20, 25, 30, 45, 60, 90], break: [5, 10, 15, 20, 30] }

// 自定义时长只有两种：专注（学习时间）/ 休息
const CUS_KINDS = [
  { k: T.MODE_FOCUS, t: '专注' },
  { k: T.MODE_BREAK, t: '休息' }
]

// 圆环拖动：左端 0 分钟，右端 59 分钟
const DIAL_MAX = 59

/**
 * 把秒拆成「数字 + 单位」几段，好让数字用大字号、单位用小字号。
 * 128 小时 40 分这种长的，整串同字号会顶出格子；生活时长要精确到秒。
 */
function spanParts(sec) {
  return T.spanParts(sec)
}

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    theme: 'light',

    settings: { focus: 25, break: 5, goal: 8, autoNext: false },
    stats: { today: 0, todayMin: 0, todayRest: 0, todayLife: 0, week: 0, streak: 0, goal: 8, goalPct: 0 },

    // 待办标签：学习 / 休息 / 生活
    tags: T.TAGS,

    // 学习 / 休息 / 生活时长统计（日 / 周 / 月 / 年）
    chartMode: 'day',
    learn: {
      mode: 'day',
      metric: T.TAG_STUDY,
      title: '学习时长',
      kinds: KIND_TABS,
      totalTxt: '0 分',
      totalSub: '0 个番茄',
      tiles: [],
      tabs: CHART_TABS,
      bars: [],
      kws: [],
      foot: ''
    },

    tasks: [],
    undone: 0,

    run: null,
    hasRun: false,
    running: false,
    busy: false,
    mode: T.MODE_FOCUS,
    modeText: '准备专注',
    timeText: '25:00',
    progress: 0,
    mainText: '开始专注',
    secondaryText: '放弃',
    taskId: '',
    taskTitle: '',
    taskTag: T.TAG_STUDY,
    pickedMin: 25,
    pickedCustom: false,
    quickList: [15, 25, 45, 60],

    // 自定义时长弹层
    customShow: false,
    customFrom: 'timer',
    customKind: 'focus',
    customText: '',
    customKinds: CUS_KINDS,
    customPresets: PRESETS.focus,
    customHint: '',

    setShow: false,
    addShow: false,
    addTitle: '',
    addTag: '',
    addTags: T.TAGS
  },

  onLoad() {
    const g = app.globalData
    this.setData({
      statusBarHeight: g.statusBarHeight,
      navBarHeight: g.navBarHeight
    })
  },

  onReady() {
    this.initRing()
  },

  onShow() {
    theme.apply(this)
    // 先把设置读进来：restore 里如果发现这一轮早该结束，
    // 直接走 finish，弹窗文案要用到「休息几分钟」
    this.setData({ settings: T.getSettings() }, () => {
      this.restore()
      this.reload()
    })
  },

  onHide() {
    this.stopTick()
  },

  onUnload() {
    this.stopTick()
  },

  /* ---------------- 数据 ---------------- */

  reload(keepPick) {
    const settings = T.getSettings()
    // 待办带上标签文案，wxml 里直接显示，不用在模板里做判断
    const tasks = T.getTasks().map((t) => Object.assign({}, t, { tagText: T.tagLabel(t.tag) }))
    const stats = T.stats()
    const patch = {
      settings: settings,
      tasks: tasks,
      stats: stats,
      undone: tasks.filter((t) => !t.done).length
    }
    // 选中的那条改了标签，跟着更新（不然完成时算到旧标签上）
    if (this.data.taskId) {
      const hit = tasks.filter((t) => t.id === this.data.taskId)[0]
      if (hit) patch.taskTag = hit.tag
    }
    // keepPick：放弃这一轮时保留刚才拖出来的时长，别打回设置里的默认值
    if (!this.data.hasRun && !keepPick) {
      patch.pickedMin = settings.focus
      patch.pickedCustom = this.data.quickList.indexOf(settings.focus) < 0
    }
    Object.assign(patch, this.learnPatch())
    this.setData(patch, () => {
      if (!this.data.hasRun) this.applyIdle()
    })
  },

  /* ---------------- 学习 / 休息时长统计 ---------------- */

  /**
   * 把「今天/本周/本月/今年」和柱状图一次性算好。
   * 数据源是按天汇总表（tomato_days_v1），所以跨度到年也不会被明细上限截断。
   * metric: study 学习 / rest 休息 / life 生活（就是待办的标签）。
   * 时间一律按秒算——生活那种零碎时间要显示「3 分 20 秒」，按分钟会糊掉。
   */
  learnPatch(mode, metric) {
    const m = mode || this.data.chartMode || 'day'
    const kd = T.tagOf(metric || this.data.learn.metric || T.TAG_STUDY)
    const isRest = kd === T.TAG_REST
    const isLife = kd === T.TAG_LIFE
    const tab = CHART_TABS.find((x) => x.k === m) || CHART_TABS[0]
    const rep = T.report()
    const ch = T.chart(null, m, undefined, kd)

    // 同一个区间，三块各算各的
    const pick = (r) => ({
      sec: r[kd].s,
      n: r[kd].n,
      d: kd === T.TAG_STUDY ? r.studyDays : kd === T.TAG_REST ? r.restDays : r.lifeDays
    })

    const subOf = (v) => {
      if (isRest) return v.n + ' 次休息' + (v.d > 1 ? ' · ' + v.d + ' 天' : '')
      if (isLife) return v.n + ' 次' + (v.d > 1 ? ' · ' + v.d + ' 天' : '')
      return v.n + ' 个番茄' + (v.d > 1 ? ' · ' + v.d + ' 天' : '')
    }

    const tile = (label, r) => {
      const v = pick(r)
      return { label: label, parts: spanParts(v.sec), sub: subOf(v) }
    }

    const tot = pick(rep.total)
    // 生活：再按待办标题里的关键词分一遍（健身、跑步、做饭…）
    const kws = isLife ? T.lifeKeywords(null, ch.from, ch.to) : []

    let foot = ''
    if (ch.sum > 0) foot = tab.name + '合计 ' + T.fmtSpan(ch.sum)
    else if (isRest) foot = '完整走完一次休息，这里就会长出来'
    else if (isLife) foot = '给待办打上「生活」标签，开始专注就会长出来'
    else foot = '完成第一轮专注，这里就会长出来'

    return {
      chartMode: m,
      learn: {
        mode: m,
        metric: kd,
        title: (isRest ? '休息' : isLife ? '生活' : '学习') + '时长',
        kinds: KIND_TABS,
        totalTxt: T.fmtSpan(tot.sec),
        totalSub: isRest ? tot.n + ' 次' : isLife ? tot.n + ' 次' : tot.n + ' 个番茄',
        tiles: [
          tile('今天', rep.day),
          tile('本周', rep.week),
          tile('本月', rep.month),
          tile('今年', rep.year)
        ],
        tabs: CHART_TABS,
        bars: ch.bars,
        kws: kws,
        foot: foot
      }
    }
  },

  onChartMode(e) {
    const k = e.currentTarget.dataset.k
    if (!k || k === this.data.chartMode) return
    this.setData(this.learnPatch(k))
  },

  /** 学习 / 休息 / 生活 切换 */
  onMetric(e) {
    const k = e.currentTarget.dataset.k
    if (!k || k === this.data.learn.metric) return
    this.setData(this.learnPatch(undefined, k))
  },

  /** 没有计时任务时的显示（时长跟着 pickedMin 走） */
  applyIdle() {
    const mode = this.data.mode
    const min = this.data.pickedMin
    this.setData({
      hasRun: false,
      running: false,
      modeText: mode === T.MODE_BREAK ? '准备休息' : '准备专注',
      timeText: T.fmtClock(min * 60000),
      mainText: min > 0 ? (mode === T.MODE_BREAK ? '开始休息' : '开始专注') : '先拖个时长',
      progress: 0
    })
    this.drawRing(0)
  },

  /** 有计时任务时的显示 */
  applyRun(run) {
    if (!run) {
      this.applyIdle()
      return
    }
    const running = run.running === true
    const left = T.remainOf(run)
    const p = T.progressOf(run)
    this.setData({
      hasRun: true,
      running: running,
      mode: run.mode,
      modeText: (run.mode === T.MODE_BREAK ? '休息' : '专注') + (running ? '中' : ' · 已暂停'),
      timeText: T.fmtClock(left),
      progress: p,
      mainText: running ? '暂停' : '继续',
      secondaryText: '放弃',
      // 休息时 run 里没有任务，但别把选好的待办清掉 —— 休息完接着专注还要用它
      taskId: run.taskId || this.data.taskId || '',
      taskTitle: run.taskTitle || this.data.taskTitle || '',
      taskTag: run.mode === T.MODE_BREAK ? this.data.taskTag : run.tag || this.data.taskTag
    })
    this.drawRing(p)
  },

  /** 恢复上次没跑完的那一轮（切页面、切后台都不丢） */
  restore() {
    const run = T.loadRun()
    if (!run) {
      this.applyIdle()
      return
    }
    if (T.isFinished(run)) {
      this.finish(run)
      return
    }
    // 休息那一轮不覆盖「下次专注多久」，否则休息完就变成用休息时长开专注
    if (run.mode !== T.MODE_BREAK) {
      const min = Math.max(1, Math.round((Number(run.totalMs) || 0) / 60000))
      this.setData({ pickedMin: min, pickedCustom: this.data.quickList.indexOf(min) < 0 })
    }
    this.applyRun(run)
    if (run.running) this.startTick()
  },

  /* ---------------- 计时 ---------------- */

  startTick() {
    this.stopTick()
    this._lastSec = -1
    this._timer = setInterval(() => this.tick(), TICK_MS)
    this.tick()
  },

  stopTick() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  },

  tick() {
    const run = this.data.run
    if (!run) return
    const now = Date.now()
    if (T.isFinished(run, now)) {
      this.finish(run)
      return
    }
    const left = T.remainOf(run, now)
    const sec = Math.ceil(left / 1000)
    // 只在秒数变化时 setData，环每帧单独画（canvas 不走 setData）
    if (sec !== this._lastSec) {
      this._lastSec = sec
      this.setData({ timeText: T.fmtClock(left) })
    }
    this.drawRing(T.progressOf(run, now))
  },

  /** 开一轮：focus 或 break */
  begin(mode, minutes) {
    const isBreak = mode === T.MODE_BREAK
    const run = T.startRun({
      mode: mode,
      minutes: minutes,
      taskId: isBreak ? '' : this.data.taskId,
      taskTitle: isBreak ? '' : this.data.taskTitle,
      // 休息一定算休息；专注跟着待办的标签走
      tag: isBreak ? T.TAG_REST : this.data.taskTag,
      now: Date.now()
    })
    T.saveRun(run)
    const realMin = Math.round(run.totalMs / 60000)
    this.setData({
      run: run,
      mode: mode,
      pickedMin: realMin,
      pickedCustom: this.data.quickList.indexOf(realMin) < 0
    })
    this.applyRun(run)
    this.startTick()
  },

  /**
   * 一轮走完。
   * 离开太久（超过 2 小时）才回来的不算，免得昨天开的计时今天冒出来一条。
   * 专注记 1 个番茄；休息只记休息时长，不占番茄数。
   */
  finish(run) {
    this.stopTick()
    const now = Date.now()
    const totalSec = Math.max(1, Math.round((Number(run.totalMs) || 0) / 1000))
    const totalMin = Math.max(1, Math.round(totalSec / 60))
    const overdue = now - (Number(run.endAt) || now)
    const isBreak = run.mode === T.MODE_BREAK
    const inTime = overdue < 2 * 3600 * 1000
    const valid = inTime && !isBreak

    T.clearRun()

    if (inTime) {
      // 存秒：生活时长要显示「3 分 20 秒」，按分钟四舍五入就没了
      T.addSession({
        taskId: run.taskId,
        title: run.taskTitle,
        tag: run.tag,
        mode: run.mode,
        sec: totalSec,
        at: now
      })
      if (valid && run.taskId) T.bumpTaskPomo(run.taskId)
    }

    const st = this.data.settings
    this._lastSec = -1
    this.setData({
      run: null,
      hasRun: false,
      running: false,
      // 停下来就回到「准备专注」，别留着休息模式让圆环显示错时长
      mode: T.MODE_FOCUS,
      // 休息走完不清任务选择：接着来一轮还是同一个待办
      taskId: isBreak ? this.data.taskId : '',
      taskTitle: isBreak ? this.data.taskTitle : '',
      taskTag: isBreak ? this.data.taskTag : T.TAG_STUDY
    }, () => {
      this.reload()
    })

    wx.vibrateLong({ fail: () => null })

    if (isBreak) {
      // 休息结束 → 接着专注
      if (st.autoNext) {
        wx.showToast({ title: '继续专注 ' + st.focus + ' 分钟', icon: 'none' })
        this.begin(T.MODE_FOCUS, st.focus)
        return
      }
      wx.showModal({
        title: '休息结束',
        content: (inTime ? '休息 ' + totalMin + ' 分钟，已记入休息时长。' : '') + '接着来一轮？',
        confirmText: '开始 ' + st.focus + ' 分钟',
        cancelText: '先不了',
        success: (r) => {
          if (r.confirm) this.begin(T.MODE_FOCUS, st.focus)
        }
      })
      return
    }

    if (st.autoNext) {
      wx.showToast({ title: '休息 ' + st.break + ' 分钟', icon: 'none' })
      this.begin(T.MODE_BREAK, st.break)
      return
    }
    wx.showModal({
      title: valid ? '专注完成 🍅' : '这一轮结束了',
      content: valid
        ? '专注 ' + totalMin + ' 分钟，记了 1 个番茄。休息一下？'
        : '这一轮离开太久，就没算番茄。要不要再来一轮？',
      confirmText: valid ? '休息 ' + st.break + ' 分钟' : '再来一轮',
      cancelText: '先不了',
      success: (r) => {
        if (!r.confirm) return
        if (valid) this.begin(T.MODE_BREAK, st.break)
        else this.begin(T.MODE_FOCUS, st.focus)
      }
    })
  },

  /* ---------------- 按钮 ---------------- */

  onMain() {
    if (this.data.busy) return
    const run = this.data.run

    if (!run) {
      const min = Number(this.data.pickedMin) || 0
      if (min < 1) {
        wx.showToast({ title: '往右拖一下圆环，先选时长', icon: 'none' })
        return
      }
      this.begin(this.data.mode, min)
      return
    }

    const now = Date.now()
    if (run.running) {
      const paused = T.pauseRun(run, now)
      T.saveRun(paused)
      this.stopTick()
      this.setData({ run: paused })
      this.applyRun(paused)
      return
    }

    const resumed = T.resumeRun(run, now)
    T.saveRun(resumed)
    this.setData({ run: resumed })
    this.applyRun(resumed)
    this.startTick()
  },

  /**
   * 放弃这一轮。
   * 放弃完要彻底回到「准备专注」：run 清掉、hasRun 归 false（否则按钮还停在
   * 「继续 / 放弃」、快速时长也不出现，看着像卡住了），时长保留刚才选的那个，
   * 待办也不清 —— 多数人是想重新开始，不是想换任务。
   */
  onSecondary() {
    const run = this.data.run
    if (!run) return
    const modeName = run.mode === T.MODE_BREAK ? '休息' : '专注'
    wx.showModal({
      title: '放弃这一轮',
      content: '放弃的' + modeName + '不计入统计，确定？',
      confirmText: '放弃',
      confirmColor: '#D6453B',
      success: (r) => {
        if (!r.confirm) return
        this.stopTick()
        T.clearRun()
        this._lastSec = -1
        // 放弃的是几分钟的一轮，就回到几分钟的「准备专注」
        const back = Math.max(1, Math.round((Number(run.totalMs) || 0) / 60000))
        this.setData(
          {
            run: null,
            hasRun: false,
            running: false,
            mode: T.MODE_FOCUS,
            pickedMin: back,
            pickedCustom: this.data.quickList.indexOf(back) < 0,
            progress: 0
          },
          () => this.reload(true)
        )
      }
    })
  },

  onPickMin(e) {
    if (this.data.hasRun) return
    const min = Number(e.currentTarget.dataset.min) || 25
    this.setData({ pickedMin: min, pickedCustom: false, mode: T.MODE_FOCUS })
    this.applyIdle()
  },

  /* ---------------- 圆环拖动调时长 ---------------- */

  /**
   * 「准备专注」时按住圆环就能调时长，0~59 分钟。
   *
   * 为什么是「转」而不是「横着拖」：
   *   圆环是个圈，横着拖是条直线，两者天生不同构 —— 在圈的下半部分往右拖，
   *   圆的顺时针方向恰好是往左走的，无论怎么调正负号，总有一半圆的人觉得反了。
   *   所以按实体的旋钮来：手指绕圆心转多少度，表盘就走多少度，
   *   顺时针 = 加时间（跟所有音量旋钮、手表表冠一致），弧永远跟着手指转。
   *
   * 但手指靠近圆心时角度会乱跳，所以分两块：
   *   圈上按下 → 旋钮（角度）；圆心的大字区域按下 → 横滑条（右 = 加）。
   * 计时中不接管触摸 —— 那时候圆环是进度条，不是表盘。
   */
  onRingStart(e) {
    if (this.data.hasRun) return
    const t = (e.touches && e.touches[0]) || {}
    const x = Number(t.clientX)
    const y = Number(t.clientY)
    if (!isFinite(x)) return
    this.measureRing()
    const rect = this._ringRect
    const min = Math.min(DIAL_MAX, Number(this.data.pickedMin) || 0)
    // 有圆心就能判「按在圈上还是按在中间」；量不到（老基础库 / 测试环境）就退回横拖
    if (rect && isFinite(y)) {
      const dx = x - rect.cx
      const dy = y - rect.cy
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist > rect.r * 0.42) {
        this._drag = { mode: 'dial', a0: Math.atan2(dy, dx), acc: 0, min: min, last: min }
        return
      }
    }
    this._drag = { mode: 'slide', x: x, min: min, last: min }
  },

  onRingMove(e) {
    const d = this._drag
    if (!d || this.data.hasRun) return
    const t = (e.touches && e.touches[0]) || {}
    const x = Number(t.clientX)
    const y = Number(t.clientY)
    if (!isFinite(x)) return

    let raw = d.min
    if (d.mode === 'dial') {
      const rect = this._ringRect
      if (!rect || !isFinite(y)) return
      const a = Math.atan2(y - rect.cy, x - rect.cx)
      // 一次 move 转过的角度可能跨过 ±π（手指经过正下方），折算到 (-π, π]
      let da = a - d.a0
      if (da > Math.PI) da -= Math.PI * 2
      if (da <= -Math.PI) da += Math.PI * 2
      d.a0 = a
      d.acc += da
      // 顺时针（屏幕坐标下角度增大）= 加时间；一整圈 = 59 分钟
      raw = d.min + (d.acc / (Math.PI * 2)) * DIAL_MAX
    } else {
      const w = this._ringW || 220
      raw = d.min + ((x - d.x) / w) * DIAL_MAX
    }

    const min = Math.max(0, Math.min(DIAL_MAX, Math.round(raw)))
    if (min === this.data.pickedMin) return
    // 每跨 5 分钟轻震一下：不用盯着屏幕也数得清转了多少
    if (Math.floor(min / 5) !== Math.floor(d.last / 5)) {
      wx.vibrateShort({ type: 'light', fail: () => null })
    }
    d.last = min
    this.setData({ pickedMin: min, pickedCustom: this.data.quickList.indexOf(min) < 0 })
    this.applyIdle()
  },

  onRingEnd() {
    if (!this._drag) return
    this._drag = null
    if (!this.data.hasRun) this.applyIdle()
  },

  /* ---------------- 时间自定义 ---------------- */

  /**
   * 打开自定义时长。
   * data-from: timer（计时器上的「自定义」，确定后直接开跑）/ set（设置面板里，只存）
   * data-k: focus / break，不传就跟着当前模式走
   */
  openCustom(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const from = ds.from === 'set' ? 'set' : 'timer'
    let kind = ds.k === 'break' ? T.MODE_BREAK : ds.k === 'focus' ? T.MODE_FOCUS : ''
    if (!kind) kind = this.data.mode === T.MODE_BREAK ? T.MODE_BREAK : T.MODE_FOCUS
    const st = this.data.settings
    const cur = kind === T.MODE_BREAK ? st.break : st.focus
    this.setData({
      customShow: true,
      customFrom: from,
      customKind: kind,
      customText: String(cur),
      customPresets: PRESETS[kind] || PRESETS.focus,
      customHint: '专注 1~' + T.RANGE.focus[1] + ' 分钟，休息 1~' + T.RANGE.break[1] + ' 分钟；填完会存成下次的默认时长'
    })
  },

  onCustomKind(e) {
    const kind = e.currentTarget.dataset.k === T.MODE_BREAK ? T.MODE_BREAK : T.MODE_FOCUS
    if (kind === this.data.customKind) return
    const st = this.data.settings
    this.setData({
      customKind: kind,
      customText: String(kind === T.MODE_BREAK ? st.break : st.focus),
      customPresets: PRESETS[kind] || PRESETS.focus
    })
  },

  onCustomInput(e) {
    this.setData({ customText: e.detail.value })
  },

  onCustomPreset(e) {
    const min = Number(e.currentTarget.dataset.min)
    if (!min) return
    this.setData({ customText: String(min) })
  },

  closeCustom() {
    this.setData({ customShow: false })
  },

  onCustomOk() {
    const kind = this.data.customKind
    const r = T.rangeOf(kind)
    const v = T.parseMinutes(this.data.customText, kind)
    if (v === null) {
      wx.showToast({ title: '填 ' + r.min + '~' + r.max + ' 之间的分钟数', icon: 'none' })
      return
    }
    // 存成默认值：下次打开还是这个时长
    const patch = {}
    patch[kind] = v
    const next = T.saveSettings(patch)
    const from = this.data.customFrom
    this.setData({ settings: next, customShow: false })

    if (from === 'timer' && !this.data.hasRun) {
      this.begin(kind, v)
      return
    }
    if (!this.data.hasRun) {
      this.setData({
        pickedMin: next.focus,
        pickedCustom: this.data.quickList.indexOf(next.focus) < 0
      })
      this.applyIdle()
    }
  },

  /* ---------------- 待办 ---------------- */

  toggleAdd() {
    this.setData({ addShow: !this.data.addShow, addTitle: '', addTag: '' })
  },

  onAddInput(e) {
    this.setData({ addTitle: e.detail.value })
  },

  /** 选标签：学习 / 休息 / 生活，一条待办必须挂一个 */
  onAddTag(e) {
    const k = T.tagOf(e.currentTarget.dataset.k)
    this.setData({ addTag: this.data.addTag === k ? '' : k })
  },

  onAddTask() {
    const t = String(this.data.addTitle || '').trim()
    if (!t) {
      wx.showToast({ title: '写点内容', icon: 'none' })
      return
    }
    const tag = this.data.addTag
    if (!tag) {
      wx.showToast({ title: '先选一个标签', icon: 'none' })
      return
    }
    T.addTask(t, tag)
    this.setData({ addTitle: '', addTag: '', addShow: false })
    this.reload()
  },

  onPickTask(e) {
    const id = e.currentTarget.dataset.id
    const t = this.data.tasks.find((x) => x.id === id)
    if (!t) return
    if (t.done) {
      wx.showToast({ title: '这条已完成了', icon: 'none' })
      return
    }
    if (this.data.hasRun) {
      wx.showToast({ title: '正在计时，先放弃这一轮', icon: 'none' })
      return
    }
    this.setData({ taskId: t.id, taskTitle: t.title, taskTag: t.tag, mode: T.MODE_FOCUS }, () => {
      this.begin(T.MODE_FOCUS, this.data.pickedMin)
    })
  },

  /** 点待办上的标签胶囊换标签（学习 / 休息 / 生活） */
  onTaskTag(e) {
    const id = e.currentTarget.dataset.id
    const t = this.data.tasks.find((x) => x.id === id)
    if (!t) return
    const list = T.TAGS.map((x) => x.t)
    wx.showActionSheet({
      itemList: list,
      success: (r) => {
        const tag = T.TAGS[r.tapIndex]
        if (!tag) return
        T.setTaskTag(id, tag.k)
        this.reload()
      },
      fail: () => null
    })
  },
  onToggleDone(e) {
    const id = e.currentTarget.dataset.id
    const t = T.toggleTask(id)
    if (!t) return
    if (t.done) wx.vibrateShort({ type: 'light', fail: () => null })
    this.reload()
  },

  onTaskLong(e) {
    const id = e.currentTarget.dataset.id
    const t = this.data.tasks.find((x) => x.id === id)
    if (!t) return
    wx.vibrateShort({ type: 'light', fail: () => null })
    wx.showModal({
      title: '删除待办',
      content: '「' + t.title + '」删掉就找不回来了。',
      confirmText: '删除',
      confirmColor: '#D6453B',
      success: (r) => {
        if (!r.confirm) return
        T.removeTask(id)
        if (this.data.taskId === id) this.setData({ taskId: '', taskTitle: '', taskTag: T.TAG_STUDY })
        this.reload()
      }
    })
  },

  /* ---------------- 设置 ---------------- */

  openSet() {
    this.setData({ setShow: true })
  },

  closeSet() {
    this.setData({ setShow: false }, () => this.reload())
  },

  noop() {},

  onStep(e) {
    const k = e.currentTarget.dataset.k
    const d = Number(e.currentTarget.dataset.d) || 0
    const cur = Number(this.data.settings[k]) || 0
    const patch = {}
    patch[k] = cur + d
    const next = T.saveSettings(patch)
    const p = { settings: next }
    // 改的是专注时长，就顺手把圆环上的待开始时间也换掉
    if (k === 'focus' && !this.data.hasRun) {
      p.pickedMin = next.focus
      p.pickedCustom = this.data.quickList.indexOf(next.focus) < 0
    }
    this.setData(p, () => {
      if (!this.data.hasRun) this.applyIdle()
    })
  },

  onAutoNext(e) {
    const next = T.saveSettings({ autoNext: e.detail.value === true })
    this.setData({ settings: next })
  },

  /* ---------------- 圆环（canvas 2d） ---------------- */

  initRing() {
    const q = wx.createSelectorQuery()
    q.select('#ring')
      .fields({ node: true, size: true, rect: true })
      .exec((res) => {
        const item = res && res[0]
        if (!item || !item.node) return
        const canvas = item.node
        const ctx = canvas.getContext('2d')
        let dpr = 2
        try {
          const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
          dpr = info.pixelRatio || 2
        } catch (e) {
          dpr = 2
        }
        canvas.width = item.width * dpr
        canvas.height = (item.height || item.width) * dpr
        ctx.scale(dpr, dpr)
        this._ring = { ctx: ctx, size: item.width }
        // 拖动的换算用实际像素宽（rpx 不是 px，不能直接拿来算）
        this._ringW = item.width || 220
        this.saveRingRect(item)
        this.drawRing(Number(this.data.progress) || 0)
      })
  },

  /**
   * 记下圆环在屏幕上的圆心和半径 —— 旋钮式拖动全靠它算角度。
   * 页面能滚动，所以每次按下都重新量一遍（异步刷新，这一次手势先用上次的量法）。
   */
  saveRingRect(r) {
    if (!r) return
    const w = Number(r.width) || this._ringW || 220
    const left = Number(r.left)
    const top = Number(r.top)
    if (!isFinite(left) || !isFinite(top)) return
    this._ringRect = { cx: left + w / 2, cy: top + w / 2, r: w / 2 }
  },

  measureRing() {
    try {
      wx.createSelectorQuery()
        .select('#ring')
        .boundingClientRect((r) => this.saveRingRect(r))
        .exec()
    } catch (e) {
      /* 量不到就沿用上次的圆心，至少还能按上次的位置转 */
    }
  },

  /**
   * 画圆环。
   *   计时中 —— 画进度弧，走多少画多少；
   *   准备中 —— 画「表盘」：0~59 分钟对应一圈，弧尾加个小圆点当指针，
   *             这样往右拖的时候手底下的变化是看得见的。
   */
  drawRing(p) {
    const ring = this._ring
    if (!ring) return
    const ctx = ring.ctx
    const size = ring.size
    const dark = theme.get() === 'dark'
    const lw = 15
    const cx = size / 2
    const cy = size / 2
    const r = cx - lw / 2 - 2
    const hasRun = !!this.data.hasRun
    const isBreak = hasRun
      ? !!(this.data.run && this.data.run.mode === T.MODE_BREAK)
      : this.data.mode === T.MODE_BREAK
    const color = isBreak ? '#10B981' : '#6366F1'

    ctx.clearRect(0, 0, size, size)

    // 底环
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.lineWidth = lw
    ctx.strokeStyle = dark ? '#2B2E3E' : '#ECEDF3'
    ctx.stroke()

    // 表盘上点一圈刻度：让「这是个能转的旋钮」一眼看得出来，
    // 转的时候也有参照物（每格 ≈ 5 分钟）
    if (!hasRun) this.drawTicks(ctx, cx, cy, r, lw, dark)

    const ratio = hasRun
      ? Math.max(0, Math.min(1, Number(p) || 0))
      : Math.max(0, Math.min(1, (Number(this.data.pickedMin) || 0) / DIAL_MAX))

    if (ratio <= 0) {
      // 表盘归零时也留一个起点小点，提示「这里可以拖」
      if (!hasRun) this.drawKnob(ctx, cx, cy, r, color, dark)
      return
    }

    ctx.beginPath()
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio)
    ctx.lineWidth = lw
    ctx.lineCap = 'round'
    ctx.strokeStyle = color
    if (!hasRun) {
      // 表盘用淡一点的颜色，免得被当成「已经专注了 40%」
      ctx.globalAlpha = 0.55
      ctx.stroke()
      ctx.globalAlpha = 1
      this.drawKnob(ctx, cx, cy, r, color, dark, ratio)
      return
    }
    ctx.stroke()
  },

  /**
   * 表盘刻度：一圈 12 个点，正上方那个大一点当「零点」。
   * 点在环的内侧，不压主线。
   */
  drawTicks(ctx, cx, cy, r, lw, dark) {
    const rr = r - lw / 2 - 6
    for (let i = 0; i < 12; i++) {
      const a = -Math.PI / 2 + (Math.PI * 2 * i) / 12
      const kx = cx + Math.cos(a) * rr
      const ky = cy + Math.sin(a) * rr
      ctx.beginPath()
      ctx.arc(kx, ky, i === 0 ? 2.4 : 1.7, 0, Math.PI * 2)
      ctx.fillStyle = dark ? 'rgba(255,255,255,.3)' : 'rgba(20,24,45,.2)'
      ctx.fill()
    }
  },

  /** 表盘指针：白心 + 彩色边，落在弧的末端 */
  drawKnob(ctx, cx, cy, r, color, dark, ratio) {
    const a = -Math.PI / 2 + Math.PI * 2 * (Number(ratio) || 0)
    const kx = cx + Math.cos(a) * r
    const ky = cy + Math.sin(a) * r
    ctx.beginPath()
    ctx.arc(kx, ky, 11, 0, Math.PI * 2)
    ctx.fillStyle = dark ? '#191A26' : '#FFFFFF'
    ctx.fill()
    ctx.lineWidth = 4
    ctx.strokeStyle = color
    ctx.stroke()
  },

  goBack() {
    wx.navigateBack({
      fail: () => wx.reLaunch({ url: '/pages/index/index' })
    })
  }
})
