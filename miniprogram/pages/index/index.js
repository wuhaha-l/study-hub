const api = require('../../utils/api')
const SCOPE = require('../../utils/scope')
const M = require('../../utils/model')
const S = require('../../utils/schedule')
const SEM = require('../../utils/semester')
const CONFIG = require('../../utils/config')
const N = require('../../utils/notes')
const T = require('../../utils/tomato')
const AUTH = require('../../utils/auth')
const theme = require('../../utils/theme')
const edu = require('../../utils/edu')
const syncall = require('../../utils/syncall')
const relogin = require('../../utils/relogin')
const app = getApp()

const DAY = 86400000

function greetingOf(h) {
  if (h < 6) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

function weekdayOf(d) {
  return '星期' + '日一二三四五六'[d.getDay()]
}

function decorate(t) {
  const dl = M.formatDeadline(t.deadline)
  // 云端还没部署新字段时，先用课程名里的「（2026春季）」这类线索兜一下
  const byName = t.semesterKey ? null : SEM.fromName(t.courseName)
  const semKey = t.semesterKey || (byName ? byName.key : '')
  return {
    id: t._id || t.id,
    platform: t.platform,
    pName: M.platformOf(t.platform).name,
    pTag: M.platformOf(t.platform).tag,
    pColor: M.platformOf(t.platform).color,
    courseName: t.courseName || '',
    // U校园旧记录里可能还挂着「> News report 1」这种小题名，渲染前再裁一刀
    title: M.cleanTitle(t.platform, t.title || '未命名任务'),
    taskType: t.taskType || 'other',
    typeLabel: M.typeOf(t.taskType).label,
    typeIcon: M.typeOf(t.taskType).icon,
    status: t.status,
    url: t.url || '',
    progressText:
      t.progress && t.progress.total > 1 ? `${t.progress.done}/${t.progress.total}` : '',
    dlText: dl.text,
    dlLevel: dl.level,
    dlDays: dl.days,
    deadline: t.deadline || 0,
    semKey,
    semShort: t.semesterShort || SEM.shortOf(semKey),
    semRank: Number(t.semesterRank) || (byName ? byName.rank : 0),
    // 老师标记的必做任务（U校园规则课）：标题标红 + 「必做」角标
    required: t.required === true,
    // 选做任务（U校园没标星的）：归「不用做」分组
    optional: t.optional === true,
    // 往期任务（不在当前学期）——列表里挂个小标签，免得以为是这学期的课
    isPast: !!semKey && semKey !== 'unknown' && semKey !== SEM.current().key
  }
}

/**
 * 把这次同步撞上的登录错误记到本机。
 * 云端只在 status=invalid 时把 lastError 落库，被跳过的老模式账号和诊断路径都不会，
 * 那样首页永远不知道该提醒。这里补一条，页面下次进来就能看到。
 */
function markRelogin(result) {
  const rows = (result && result.rows) || []
  rows.forEach((x) => {
    if (!x || !x.platform || !x.error) return
    // note() 内部会自己筛，网络超时这类不会被记下来
    relogin.note(x.platform, x.error)
  })
}

function bucketOf(item) {
  if (item.status === 'done') return 'done'
  // 选做任务（U校园没标星的）单独一组「不用做」，不和必做混在一起
  if (item.optional) return 'optional'
  // 章节任务点没有截止时间，单独一组，免得把要交的作业挤下去
  if (item.taskType === 'chapter') return 'chapter'
  if (item.dlLevel === 'expired') return 'expired'
  const d = item.dlDays
  if (d === null) return 'later'
  if (d <= 0) return 'today'
  if (d <= 7) return 'week'
  return 'later'
}

const GROUP_META = [
  { key: 'expired', title: '已过期', tone: 'danger' },
  { key: 'today', title: '今天截止', tone: 'urgent' },
  { key: 'week', title: '一周内', tone: 'normal' },
  { key: 'later', title: '更晚 / 无期限', tone: 'muted' },
  { key: 'chapter', title: '章节任务点', tone: 'muted' },
  { key: 'optional', title: '不用做', tone: 'muted' },
  { key: 'done', title: '已完成', tone: 'muted' }
]

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    greeting: '',
    todayLabel: '',
    // 大标题下面那行结论（「今天要交 2 件 · 3 项已过期」），在 applyData 里算
    headSub: '',
    loading: true,
    syncing: false,
    // 同步期间的阶段文案（希冀走本机直连会比云端慢，得让用户知道在动）
    syncText: '',
    error: '',
    syncWarn: '',
    // 云函数版本过旧（访客态下仍返回平台任务）时显示的部署提醒
    verWarn: '',
    filter: 'all',
    filters: [],
    courseFilter: 'all',
    courseChips: [],
    semesterFilter: 'current',
    semesterChips: [],
    semesterText: '',
    stats: { todo: 0, week: 0, expired: 0, rate: 0, done: 0 },
    platforms: [],
    // 「哪些平台该重新登录了」。count 是待处理平台数，items 逐条列在首页那条提醒里
    relogin: { count: 0, items: [], keys: [], names: [], title: '', text: '' },
    // 今天点了「稍后」就先把这条收起来，明天自然又出来
    reloginShow: false,
    groups: [],
    hasAccount: false,
    lastSyncText: '尚未同步',
    // 「已合并 N 条重复记录」：只在前端这一层真的合掉了东西时出现，用来核对是否生效
    mergeNote: '',
    showDone: false,
    showChapter: false,
    showOptional: false,
    remindEnabled: false,
    remindRemaining: 0,
    remindText: '',
    todayDay: '',
    todayWeek: '',
    todayClasses: [],
    todayState: '',
    // 身份：guest 是手机号注册的访客，学校相关入口全部关掉
    isGuest: false,
    guestName: '',
    roleLabel: '',

    // 小工具：记事本 / 专注
    noteCount: 0,
    tomatoToday: 0,
    tomatoMin: 0,
    tomatoRunning: false,
    // 长按菜单（null 表示关闭）
    menu: null,
    menuBusy: false,

    // 新建任务弹层
    addShow: false,
    addBusy: false,
    addTitle: '',
    addCourse: '',
    addDate: '',
    addTime: '23:59',
    addRemindIndex: 0,
    addRemindDate: '',
    addRemindTime: '09:00',
    remindOptions: ['前一天 9:00（默认）', '当天 9:00', '提前 1 小时', '自定义时间', '不提醒']
  },

  onLoad() {
    // 首次进入先去登录页（学号密码 → 拉自己的课表/任务）；数据按微信号隔离
    if (!wx.getStorageSync('app_registered_v1')) {
      wx.reLaunch({ url: '/pages/welcome/welcome' })
      return
    }
    theme.apply(this)
    this.syncRole()
    const g = app.globalData
    const now = new Date()
    this.setData({
      statusBarHeight: g.statusBarHeight,
      navBarHeight: g.navBarHeight,
      greeting: greetingOf(now.getHours()),
      todayLabel: `${now.getMonth() + 1}月${now.getDate()}日 ${weekdayOf(now)}`
    })
    this.loadSchedule()
    this.loadTools()
    this.load(true)
  },

  /** 课表存在本机，每次回到首页都刷一遍（可能刚在课表页改过） */
  loadSchedule() {
    const items = wx.getStorageSync(SCOPE.key('timetable_v1')) || []
    const all = Array.isArray(items) ? items : []
    const termStr = wx.getStorageSync(SCOPE.key('timetable_term')) || ''
    const term = termStr ? new Date(termStr + 'T00:00:00') : S.mondayOf(new Date())
    const weekNo = Math.max(1, S.weekNoOf(new Date(), term))
    // 单双周、周次范围要在这里就过滤掉，否则「双周的课单周也当成今天要上」
    const list = all.filter((x) => S.inWeek(x, weekNo))

    const info = S.todayInfo(list)
    const classes = info.list.map((x) => ({
      id: x.id,
      period: S.periodLabel(x.start, x.end),
      name: x.name,
      place: x.place || '',
      now: !!info.current && info.current.id === x.id
    }))
    let state = ''
    if (info.current) state = '正在上 · ' + info.current.name
    else if (info.next) state = '下一节 ' + S.periodLabel(info.next.start, info.next.end) + ' 节 · ' + info.next.name
    else if (classes.length) state = '今天的课上完了'

    this.setData({
      todayDay: '周' + S.DAY_NAMES[info.day - 1],
      todayWeek: '第 ' + weekNo + ' 周',
      todayClasses: classes,
      todayState: state,
      // 课表导没导、本周共几节 —— 「今天恰好没课」和「还没导入」要区分开；
      // 节数按起止节累加（1-2 节的格子是 2 节，不是 1 节）
      hasTimetable: all.length > 0,
      weekCount: list.reduce(
        (n, x) => n + Math.max(1, (Number(x.end) || Number(x.start) || 1) - (Number(x.start) || 1) + 1),
        0
      )
    })
  },

  onShow() {
    // 未登录时首页的数据没有意义（会被 reLaunch 到登录页），不加载
    if (!wx.getStorageSync('app_registered_v1')) return
    theme.apply(this)
    this.syncRole()
    this.loadSchedule()
    this.loadTools()
    if (app.globalData.needRefresh) {
      app.globalData.needRefresh = false
      this.load(false)
    } else if (this._dashboard) {
      /*
       * 从账号页回来时，提醒的本地状态可能刚变过（重新登录清掉了、或者点了稍后）。
       * 这里只按已有数据重算一遍，不重新请求云端 —— 回来立刻同步一次太重了。
       */
      const rl = relogin.survey(this._dashboard.accounts || [])
      this.setData({ relogin: rl, reloginShow: rl.count > 0 && !relogin.isMuted() })
    }
  },

  /**
   * 身份同步到 data。
   * 传 role（'guest' / 'school'）时以它为准——那是云端给的，比本机记录新；
   * 不传就只看本机。
   */
  syncRole(role) {
    const a = AUTH.get()
    // anonymous（已退出的访客）也要回写：否则本机还留着 guest，云端却已经挡住了
    if ((role === 'guest' || role === 'school' || role === 'anonymous') && a.role !== role) {
      AUTH.save({ role: role })
    }
    const cur = AUTH.get()
    const guest = cur.role !== 'school'
    const next = {
      isGuest: guest,
      guestName: guest ? cur.nickname || cur.phone || '访客' : '',
      roleLabel: AUTH.label()
    }
    if (
      next.isGuest !== this.data.isGuest ||
      next.guestName !== this.data.guestName ||
      next.roleLabel !== this.data.roleLabel
    ) {
      this.setData(next)
    }
  },

  /** 访客碰了学校功能：说清楚原因，别让人以为是坏了 */
  denyGuest() {
    wx.showModal({
      title: '这是学校功能',
      content: '访客账号只能用记事本、专注、手动课表和手动待办。课表导入、平台绑定和任务同步都要本校学号登录。',
      showCancel: false,
      confirmText: '知道了'
    })
  },

  /**
   * 记事本、专注的入口卡片要显示的角标。
   * 全是本机数据，读失败也不能把首页带崩。
   */
  loadTools() {
    try {
      const st = T.stats()
      const run = T.loadRun()
      this.setData({
        noteCount: N.stats().total,
        tomatoToday: st.today,
        tomatoMin: st.todayMin,
        tomatoRunning: !!(run && run.running && !T.isFinished(run))
      })
    } catch (e) {
      console.warn('读取小工具数据失败', e)
    }
  },

  /** 导航栏的 🌙/☀️：切深浅色，全小程序记住选择 */
  onThemeToggle() {
    theme.toggle()
    theme.apply(this)
  },

  onPullDownRefresh() {
    this.doSync('all', true)
  },

  /** 退出登录：清掉本机的「已初始化」标记和云端统一认证 token，回到登录页 */
  onLogout() {
    const guest = this.data.isGuest
    wx.showModal({
      title: guest ? '退出访客身份' : '退出登录',
      content: guest
        ? '回到登录页，用手机号重新登录就能回来。记事本、番茄记录和手动课表都在这台手机上，不会丢。'
        : '回到登录页，重新登录即可恢复。任务数据都在云端，不会丢。',
      confirmText: '退出',
      success: (r) => {
        if (r.confirm) this.doLogout()
      }
    })
  },

  /** 真退出。界面上有两个入口（底部按钮、身份胶囊），实际动作都走这里 */
  doLogout() {
    const guest = this.data.isGuest
    // 先落本机，界面立刻是「已退出」，不依赖云端返回
    // 注意别用 AUTH.clear()：清掉之后本机默认回到 school，
    // 退出的人（尤其是访客）反而会读到学校账号那份数据。
    AUTH.save({ role: 'anonymous' })
    wx.removeStorageSync('app_registered_v1')

    // 云端也要退，而且要等它真的写完再跳：漏了这一步的话，
    // markSchool 会以「当前微信是访客身份，请先退出」把学校登录挡住，
    // 用户明明点了退出却登不回去。
    wx.showLoading({ title: '退出中', mask: true })
    const done = () => {
      wx.hideLoading()
      wx.reLaunch({ url: '/pages/welcome/welcome' })
    }
    const jobs = [api.logoutAccount().catch(() => null)]
    if (!guest) jobs.push(api.zzuLogout().catch(() => null))
    Promise.all(jobs).then(done, done)
  },

  /* ---------------- 数据加载 ---------------- */
  load(showLoading) {
    if (showLoading) this.setData({ loading: true, error: '' })
    // 返回 promise：doSync 等调用方要在刷新完成后收尾（关 loading、弹结果）
    return api
      .getDashboard()
      .then((data) => {
        app.globalData.accounts = data.accounts || []
        this.applyData(data)
      })
      .catch((e) => {
        this.setData({ error: e.message || '加载失败', loading: false })
      })
  },

  applyData(data) {
    this._dashboard = data
    // 云端才是权威：换手机、换微信登录过，本机记的身份可能已经旧了
    this.syncRole(data.role)
    const accounts = data.accounts || []
    /*
     * 兜底（防御性，不是正路）：访客身份下只认自己建的「自定义任务」。
     *
     * 平台任务只能由同步产生，而同步是学校功能——所以只要不是学校身份，
     * 云端返回的任何学习通 / 希冀 / U校园任务都必然是旧版云函数按裸 openid
     * 漏出来的学校数据。云函数没更新到 20261026.2 之前，靠这一步兜住，
     * 不能让用户先看见别人的数据再被"修好"。
     */
    const role = data.role || AUTH.get().role
    const isSchoolRole = role === 'school'
    const allTasks = data.tasks || []
    const platformLeak = isSchoolRole
      ? 0
      : allTasks.filter((t) => t.platform && t.platform !== 'custom').length
    this.setData({
      srvVer: data.srvVer || '',
      verWarn: platformLeak
        ? '云端还是旧版本，访客模式下仍在返回平台任务。请重新上传 studyHub 云函数（需 ≥ 20261026.2）'
        : ''
    })
    const kept = isSchoolRole
      ? allTasks.filter((t) => M.PLATFORM_LIST.some((p) => p.key === t.platform) || !t.platform || t.platform === 'custom')
      : allTasks.filter((t) => !t.platform || t.platform === 'custom')
    /*
     * 同一份作业被抓成两条时在这里先合掉。
     * 超星作业页把同一个作业在「未交」和「已交」两个区块各渲染一次、workId 还不同，
     * 云端正视这一点（见 adapters/chaoxing.js 的 dedupeWorks），但用户手机上跑的可能
     * 还是旧版云函数 —— 页面这层再兜一次，保证「交完还挂着」不会出现。
     */
    const mergeInfo = {}
    const rawTasks = M.mergeDuplicates(kept.map(decorate), mergeInfo)
    this._rawTasks = rawTasks
    // 页脚把这层的结果写出来：合并了 0 条却还看到两条，说明这两条连标题/课程都不一样，
    // 那就不是「重复抓取」，得回去看原文（账号页 → 学习通 → 状态诊断）
    this.setData({ mergeNote: mergeInfo.merged ? '已合并 ' + mergeInfo.merged + ' 条重复记录' : '' })
    // 详情页靠这个全局表按 id 找任务（要原始字段，别塞 decorate 后的），
    // 必须跟首页看到的一致——访客不能靠猜 id 打开平台任务
    app.globalData.currentTasks = kept

    /*
     * 学期过滤：超星里往期的课不会消失，秋季学期还挂着上学期的班，
     * 那些班的未完成任务会一直混在列表里。默认只显示本学期。
     * 三个平台都会在抓取时打学期标签（超星按课程开始时间、U校园同、
     * 希冀按课程 start_date/名称）；实在判断不出的才算本学期，免得被藏掉。
     */
    const nowSem = SEM.current()
    this._nowSemKey = nowSem.key
    /*
     * 「本学期」口径：
     *   1. 实在判断不出学期的任务 → 算本学期，不然会被悄悄藏掉
     *   2. 学期就是当前学期
     *   3. 往期任务但截止时间还没到 → 仍然显示（上学期留的作业这周要交，
     *      正是最该提醒的，大学英语 Quiz 3 就是这种情况）
     */
    const nowMs = Date.now()
    const inNow = (t) =>
      !t.semKey ||
      t.semKey === 'unknown' ||
      t.semKey === nowSem.key ||
      (t.deadline > nowMs)
    const otherTasks = rawTasks.filter((t) => !inNow(t))
    const curTodo = rawTasks.filter((t) => inNow(t) && t.status !== 'done').length
    const allTodo = rawTasks.filter((t) => t.status !== 'done').length
    const semesterChips = otherTasks.length
      ? [
          { key: 'current', name: nowSem.short + ' 本学期', count: curTodo },
          { key: 'all', name: '全部学期', count: allTodo }
        ]
      : []
    const semesterFilter = semesterChips.length ? this.data.semesterFilter : 'current'
    const scopedAll = semesterFilter === 'all' ? rawTasks : rawTasks.filter(inNow)

    const todo = scopedAll.filter((t) => t.status !== 'done')
    const done = scopedAll.filter((t) => t.status === 'done')
    const expired = todo.filter((t) => t.dlLevel === 'expired')
    const week = todo.filter((t) => t.dlDays !== null && t.dlDays >= 0 && t.dlDays <= 7)
    const total = scopedAll.length

    /*
     * 「已完成」那一组默认是收起的（避免一堆旧作业占屏）。但刚同步回来的话，
     * 平台上交了的那几条会从待办里消失、缩进收起的分组里——用户第一反应是
     * 「我的任务怎么没了 / 怎么没变成已完成」。所以只要这次比上次多出已完成，
     * 就自动展开一次。首次加载不比（_seenDone 为空），免得一进首页就摊开一堆旧任务。
     */
    const prevDone = this._seenDone
    this._seenDone = done.length
    const openDone = prevDone !== undefined && done.length > prevDone ? true : this.data.showDone

    // 平台概览
    const platforms = M.PLATFORM_LIST.map((p) => {
      const acc = accounts.find((a) => a.platform === p.key)
      const cnt = todo.filter((t) => t.platform === p.key).length
      return {
        key: p.key,
        name: p.name,
        // 平台胶囊里的彩色方块图标只放一个字，短名首字正好（超 / 希 / U）
        initial: (p.short || p.name).slice(0, 1),
        color: p.color,
        dot: p.dot,
        tag: p.tag,
        count: cnt,
        bound: !!acc,
        mode: acc ? acc.mode : '',
        status: acc ? acc.status : 'unbound',
        statusText: !acc
          ? '未绑定'
          : acc.status === 'invalid'
          ? '登录已失效'
          : M.relativeTime(acc.lastSyncAt),
        lastSyncAt: (acc && acc.lastSyncAt) || 0
      }
    })

    // 筛选芯片
    const filters = [{ key: 'all', name: '全部', count: todo.length }].concat(
      M.PLATFORM_LIST.map((p) => ({
        key: p.key,
        name: p.name,
        count: todo.filter((t) => t.platform === p.key).length
      }))
    )

    const last = platforms.reduce((m, p) => Math.max(m, p.lastSyncAt), 0)

    /*
     * 大标题下的结论句。大标题只说「还有 N 件事要交」，这句负责回答
     * 「那最急的是哪种」——今天要交 / 已过期 / 一周内，三档里挑能说的说。
     */
    const todayDue = todo.filter(
      (t) => t.dlLevel !== 'expired' && t.dlDays !== null && t.dlDays <= 0
    ).length
    let headSub = ''
    if (!todo.length) {
      // 「今天都清完了」时别再说「没有待办」，那是两回事
      headSub = done.length
        ? `全部处理完了，完成 ${done.length} 项`
        : '这个范围还没有任务，下拉可以重新同步'
    } else {
      const parts = []
      if (todayDue) parts.push(`今天要交 ${todayDue} 件`)
      if (expired.length) parts.push(`${expired.length} 项已过期`)
      if (!parts.length && week.length) parts.push(`一周内还有 ${week.length} 件`)
      headSub = parts.length ? parts.join(' · ') : '最近没有迫近的截止'
    }

    // 每日提醒状态。卡片显示条件：小程序端已配模板 ID（config.js）；
    // 云端是否生效单独提示 —— 云函数没重新部署时 enabled 仍是 false，
    // 直接把「去重新部署」写在卡片上，别让用户猜为什么没提醒
    const rm = data.reminder || { remaining: 0, enabled: false }
    const remaining = rm.remaining || 0
    const clientReady = !!CONFIG.SUBSCRIBE_TEMPLATE_ID
    const cloudReady = !!rm.enabled
    const remindText = !clientReady
      ? '未配置订阅消息模板'
      : !cloudReady
      ? '云端还没生效：云函数要重新上传部署（页脚服务版本 ≥ 20261024.8），部署完下拉刷新'
      : remaining > 0
      ? `已开启 · 还可接收 ${remaining} 次`
      : '每天 21:30 提醒 48 小时内要交的任务'

    /*
     * 「该重新登录了」的判定统一收在 utils/relogin：
     * 云端 status=invalid、诊断/同步当场记下的凭据错误、老模式账号（本地代理 / 内网直连），
     * 三种来源说法不一样 —— 前两个点一下重新登录就好，第三个得换绑定方式，
     * 所以不能再用一句「登录已失效」糊过去。
     */
    const rl = relogin.survey(accounts)
    // 提醒条允许「今天稍后」，但问题本身不该消失：静音期间用这行小字兜底
    const warn = rl.count && relogin.isMuted() ? rl.title + '，去账号页处理' : ''

    this.setData({
      loading: false,
      error: data.syncErrors && data.syncErrors.length ? data.syncErrors.join('；') : '',
      syncWarn: warn,
      relogin: rl,
      reloginShow: rl.count > 0 && !relogin.isMuted(),
      // 访客永远不会有平台账号，但只要自己建过任务就该看到列表
      hasAccount: accounts.length > 0 || (this.data.isGuest && rawTasks.length > 0),
      remindEnabled: clientReady,
      remindRemaining: remaining,
      remindText,
      platforms,
      filters,
      headSub,
      semesterChips,
      semesterFilter,
      semesterText: otherTasks.length
        ? '另有 ' + otherTasks.length + ' 项往期任务，点「全部学期」可查看'
        : '',
      stats: {
        todo: todo.length,
        week: week.length,
        expired: expired.length,
        done: done.length,
        rate: total ? Math.round((done.length / total) * 100) : 0
      },
      // 刚多出已完成 → 展开，让用户看得见「它确实变成已完成了」
      showDone: openDone,
      lastSyncText: M.relativeTime(last)
    })

    this.rebuildCourseChips(rawTasks)
    this.rebuildGroups(rawTasks)
  },

  /** 按「学期」过滤：全部学期 / 本学期（含学期未知的、以及往期但还没到截止的） */
  _semScope(list) {
    const arr = list || []
    if (this.data.semesterFilter === 'all') return arr
    const now = this._nowSemKey || SEM.current().key
    const nowMs = Date.now()
    return arr.filter(
      (t) => !t.semKey || t.semKey === 'unknown' || t.semKey === now || t.deadline > nowMs
    )
  },

  /**
   * 课程筛选芯片：课程一多，光靠「一周内 / 更晚」这种时间分组很容易漏看某门课，
   * 这里再给一条按课程筛选的行，谁的课一目了然。
   */
  rebuildCourseChips(rawTasks) {
    const tasks = this._semScope(rawTasks || this._rawTasks || [])
    const pf = this.data.filter
    const scoped = pf === 'all' ? tasks : tasks.filter((t) => t.platform === pf)

    const map = {}
    scoped.forEach((t) => {
      const k = t.courseName || '未命名课程'
      if (!map[k]) map[k] = { key: k, name: k, count: 0 }
      if (t.status !== 'done') map[k].count += 1
    })
    const list = Object.keys(map).map((k) => map[k])
    // 有未完成的排前面，其次按未完成数倒序
    list.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

    const todoAll = scoped.filter((t) => t.status !== 'done').length
    const chips = list.length > 1
      ? [{ key: 'all', name: '全部课程', count: todoAll }].concat(list)
      : []

    // 换了平台后原来选中的课程可能不在了，回到「全部课程」
    const keep = chips.some((c) => c.key === this.data.courseFilter) ? this.data.courseFilter : 'all'
    this.setData({ courseChips: chips, courseFilter: keep })
  },

  rebuildGroups(rawTasks) {
    const tasks = this._semScope(rawTasks || this._rawTasks || app.globalData.currentTasks.map(decorate))
    const filter = this.data.filter
    const cf = this.data.courseFilter
    let scoped = filter === 'all' ? tasks : tasks.filter((t) => t.platform === filter)
    if (cf && cf !== 'all') scoped = scoped.filter((t) => (t.courseName || '未命名课程') === cf)

    const buckets = { expired: [], today: [], week: [], later: [], chapter: [], optional: [], done: [] }
    scoped.forEach((t) => buckets[bucketOf(t)].push(t))

    // 排序：有截止时间按时间升序，无截止时间放该组末尾
    Object.keys(buckets).forEach((k) => {
      buckets[k].sort((a, b) => {
        if (a.deadline && b.deadline) return a.deadline - b.deadline
        if (a.deadline) return -1
        if (b.deadline) return 1
        return a.title.localeCompare(b.title)
      })
    })

    const groups = GROUP_META.map((m) => {
      const open =
        m.key === 'done'
          ? this.data.showDone
          : m.key === 'chapter'
          ? this.data.showChapter
          : m.key === 'optional'
          ? this.data.showOptional
          : true
      return {
        key: m.key,
        title: m.title,
        tone: m.tone,
        count: buckets[m.key].length,
        collapsible: m.key === 'done' || m.key === 'chapter' || m.key === 'optional',
        moreText: open ? '收起' : '展开',
        items: open ? buckets[m.key] : []
      }
    }).filter((g) => g.count > 0)

    this.setData({ groups })
  },

  /* ---------------- 交互 ---------------- */
  onFilter(e) {
    const key = e.currentTarget.dataset.key
    if (key === this.data.filter) return
    this.setData({ filter: key, courseFilter: 'all' }, () => {
      this.rebuildCourseChips()
      this.rebuildGroups()
    })
  },

  onCourseFilter(e) {
    const key = e.currentTarget.dataset.key
    if (key === this.data.courseFilter) return
    this.setData({ courseFilter: key }, () => this.rebuildGroups())
  },

  /** 切换「本学期 / 全部学期」：统计数字也跟着变，避免列表和数字对不上 */
  onSemesterFilter(e) {
    const key = e.currentTarget.dataset.key
    if (key === this.data.semesterFilter) return
    this.setData({ semesterFilter: key, courseFilter: 'all' }, () => {
      if (this._dashboard) this.applyData(this._dashboard)
      else {
        this.rebuildCourseChips()
        this.rebuildGroups()
      }
    })
  },

  toggleDoneList() {
    this.setData({ showDone: !this.data.showDone }, () => this.rebuildGroups())
  },

  toggleGroup(e) {
    const key = e.currentTarget.dataset.key
    if (key === 'done') this.setData({ showDone: !this.data.showDone }, () => this.rebuildGroups())
    else if (key === 'chapter') this.setData({ showChapter: !this.data.showChapter }, () => this.rebuildGroups())
    else if (key === 'optional') this.setData({ showOptional: !this.data.showOptional }, () => this.rebuildGroups())
  },

  onTaskTap(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` })
  },

  /* ---------------- 长按菜单：标记完成 / 恢复 ---------------- */

  noop() {},

  onTaskLongPress(e) {
    const id = e.currentTarget.dataset.id
    const t = (this._rawTasks || []).find((x) => x.id === id)
    if (!t) return
    if (wx.vibrateShort) {
      try {
        wx.vibrateShort({ type: 'light' })
      } catch (err) {
        /* 部分机型不支持，忽略 */
      }
    }
    this.setData({
      menu: {
        id: t.id,
        title: t.title,
        course: t.courseName || '未命名课程',
        platform: t.pName,
        done: t.status === 'done',
        url: t.url || '',
        // 自己建的任务才能删（平台任务删了下次同步又回来）
        custom: t.platform === 'custom'
      }
    })
  },

  /** 删除自己创建的任务 */
  onMenuDelete() {
    const m = this.data.menu
    if (!m || !m.custom || this.data.menuBusy) return
    this.setData({ menuBusy: true })
    api
      .deleteTask(m.id)
      .then(() => {
        this.setData({ menu: null, menuBusy: false })
        this.load(false)
        wx.showToast({ title: '已删除', icon: 'none' })
      })
      .catch((e) => {
        this.setData({ menuBusy: false })
        wx.showToast({ title: (e && e.message) || '删除失败', icon: 'none' })
      })
  },

  /* ---------------- 新建任务 ---------------- */

  /** 戳「＋ 新任务」打开弹层：截止默认今天 23:59，提醒默认前一天 9:00 */
  onAddTask() {
    const d = new Date()
    const p = (x) => (x < 10 ? '0' + x : '' + x)
    const today = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    this.setData({
      addShow: true,
      addTitle: '',
      addCourse: '',
      addDate: today,
      addTime: '23:59',
      addRemindIndex: 0,
      addRemindDate: today,
      addRemindTime: '09:00',
      addBusy: false
    })
  },

  closeAddSheet() {
    this.setData({ addShow: false })
  },

  onAddTitle(e) {
    this.setData({ addTitle: e.detail.value })
  },
  onAddCourse(e) {
    this.setData({ addCourse: e.detail.value })
  },
  onAddDate(e) {
    this.setData({ addDate: e.detail.value })
  },
  onAddTime(e) {
    this.setData({ addTime: e.detail.value })
  },
  onAddRemind(e) {
    this.setData({ addRemindIndex: Number(e.detail.value) })
  },
  onAddRemindDate(e) {
    this.setData({ addRemindDate: e.detail.value })
  },
  onAddRemindTime(e) {
    this.setData({ addRemindTime: e.detail.value })
  },

  /** 'yyyy-mm-dd' + 'HH:mm' → 本地时间戳 */
  _tsOf(dateStr, timeStr) {
    const t = new Date(String(dateStr || '') + 'T' + String(timeStr || '09:00') + ':00')
    return isNaN(t.getTime()) ? 0 : t.getTime()
  },

  /** 按所选提醒方式算提醒时间戳；0 = 不提醒 */
  _remindTsOf() {
    const i = this.data.addRemindIndex
    const deadline = this._tsOf(this.data.addDate, this.data.addTime)
    if (i === 4 || !deadline) return 0
    if (i === 3) return this._tsOf(this.data.addRemindDate, this.data.addRemindTime)
    if (i === 2) return deadline - 3600000
    // 前一天 9:00 / 当天 9:00
    const d = new Date(deadline)
    if (i === 0) d.setDate(d.getDate() - 1)
    d.setHours(9, 0, 0, 0)
    return d.getTime()
  },

  onSaveTask() {
    if (this.data.addBusy) return
    const title = String(this.data.addTitle || '').trim()
    if (!title) {
      wx.showToast({ title: '先写要做什么', icon: 'none' })
      return
    }
    this.setData({ addBusy: true })
    api
      .saveCustomTask({
        title,
        courseName: String(this.data.addCourse || '').trim(),
        deadline: this._tsOf(this.data.addDate, this.data.addTime),
        remindAt: this._remindTsOf()
      })
      .then(() => {
        this.setData({ addShow: false, addBusy: false })
        this.load(false)
        const opt = this.data.remindOptions[this.data.addRemindIndex]
        wx.showToast({ title: '已添加' + (this.data.addRemindIndex === 4 ? '' : '，' + opt.replace('（默认）', '') + '提醒'), icon: 'none', duration: 2400 })
      })
      .catch((e) => {
        this.setData({ addBusy: false })
        wx.showToast({ title: (e && e.message) || '保存失败', icon: 'none' })
      })
  },

  closeMenu() {
    this.setData({ menu: null })
  },

  /** 本地先改状态，界面立刻动；接口失败再翻回来 */
  _patchStatus(id, status) {
    const patch = (list) => {
      (list || []).forEach((x) => {
        if ((x._id || x.id) === id) x.status = status
      })
    }
    patch(this._dashboard && this._dashboard.tasks)
    patch(this._rawTasks)
  },

  onMenuDone() {
    const m = this.data.menu
    if (!m || this.data.menuBusy) return
    const next = !m.done
    const prev = m.done ? 'done' : 'todo'

    this.setData({ menu: null, menuBusy: true })
    this._patchStatus(m.id, next ? 'done' : 'todo')
    // 标完立刻把「已完成」展开，否则用户会以为任务凭空消失了
    if (next) this.setData({ showDone: true })
    if (this._dashboard) this.applyData(this._dashboard)

    api
      .toggleTask(m.id, next)
      .then(() => {
        this.setData({ menuBusy: false })
        wx.showToast({
          title: next ? '已完成，已归到「已完成」' : '已恢复为待完成',
          icon: 'none',
          duration: 1800
        })
      })
      .catch((e) => {
        this._patchStatus(m.id, prev)
        if (this._dashboard) this.applyData(this._dashboard)
        this.setData({ menuBusy: false })
        wx.showModal({
          title: '没保存成功',
          content: (e && e.message) || '网络异常，稍后再试',
          showCancel: false
        })
      })
  },

  onMenuDetail() {
    const m = this.data.menu
    if (!m) return
    this.setData({ menu: null })
    wx.navigateTo({ url: `/pages/detail/detail?id=${m.id}` })
  },

  onMenuCopy() {
    const m = this.data.menu
    if (!m) return
    this.setData({ menu: null })
    wx.setClipboardData({
      data: m.url,
      success: () => wx.showToast({ title: '链接已复制', icon: 'none' })
    })
  },

  doSync(platform, fromPull) {
    // 访客没有平台账号，同步这条路直接关掉（下拉刷新也别弹窗提醒，安静收工）
    if (this.data.isGuest) {
      if (fromPull) wx.stopPullDownRefresh()
      else this.denyGuest()
      return
    }
    if (this.data.syncing) return
    /*
     * 本机登录过希冀也算「有账号」。
     * 第一次直连抓之前云端还没有 educoder 记录（pushTasks 才会建），
     * 这时候 hasAccount 是 false，但希冀明明能抓 —— 不能因此把人赶去账号页。
     */
    let eduReady = false
    try {
      const cfg = edu.getCfg()
      eduReady = !!(cfg && cfg.cookie)
    } catch (e) {
      eduReady = false
    }
    if (!this.data.hasAccount && !eduReady) {
      if (fromPull) wx.stopPullDownRefresh()
      wx.navigateTo({ url: '/pages/accounts/accounts' })
      return
    }

    this.setData({ syncing: true, syncText: '正在同步…' })
    const accounts = (this._dashboard && this._dashboard.accounts) || []
    syncall
      .syncAll({
        accounts: accounts,
        onStep: (t) => {
          if (t) this.setData({ syncText: t })
        }
      })
      .then((r) => {
        app.globalData.needRefresh = false
        markRelogin(r)
        return this.load(false).then(() => this.showSyncResult(r))
      })
      .catch((e) => {
        wx.showModal({
          title: '同步失败',
          content: e.message || '未知错误',
          showCancel: false
        })
      })
      .then(() => {
        this.setData({ syncing: false, syncText: '' })
        if (fromPull) wx.stopPullDownRefresh()
      })
  },

  /**
   * 同步结果：每个平台一行，说清楚几条、几条已完成、哪条挂了。
   * 「已完成」只能从刚拉下来的任务里数 —— 云端只回条数，不回 done 数。
   */
  showSyncResult(r) {
    const tasks = this._rawTasks || []
    const doneOf = (p) => tasks.filter((t) => t.platform === p && t.status === 'done').length
    const rows = (r && r.rows) || []
    const errs = (r && r.errors) || []

    // 只有一条、没错误、也没被跳过：toast 一下就行，别拿弹窗挡屏幕
    if (!errs.length && rows.length <= 1 && !rows.some((x) => x.skipped)) {
      wx.showToast({ title: '已更新 ' + ((r && r.count) || 0) + ' 项', icon: 'success' })
      return
    }

    const rep = syncall.report(r, doneOf)
    const ver = (r && r.srvVer) ? '服务 ' + r.srvVer + '\n' : ''
    wx.showModal({
      title: errs.length ? '同步完成，有平台失败' : rep.title,
      content: ver + rep.content,
      showCancel: false,
      confirmText: '知道了'
    })
  },

  onSyncTap() {
    this.doSync('all', false)
  },

  goAccounts() {
    if (this.data.isGuest) {
      this.denyGuest()
      return
    }
    wx.navigateTo({ url: '/pages/accounts/accounts' })
  },

  /**
   * 首页那条「N 个平台需要重新登录」。
   * 只有一个平台要处理时直接进它的登录表单 —— 中间少一次点击，
   * 用户才不会因为「懒得找」把提醒一直放着。
   */
  goRelogin() {
    if (this.data.isGuest) {
      this.denyGuest()
      return
    }
    const items = (this.data.relogin && this.data.relogin.items) || []
    if (items.length === 1) {
      wx.navigateTo({ url: '/pages/accounts/accounts?platform=' + items[0].key })
      return
    }
    wx.navigateTo({ url: '/pages/accounts/accounts' })
  },

  /** 「稍后」只静音今天，明天重新出现：不做成永久关闭，否则等于没有提醒 */
  onReloginLater() {
    relogin.muteToday()
    const rl = this.data.relogin || { count: 0, title: '' }
    this.setData({
      reloginShow: false,
      syncWarn: rl.count ? rl.title + '，去账号页处理' : ''
    })
  },

  /**
   * 导航栏右边那个身份胶囊。
   * 访客点的应该是「我是谁 + 怎么退出」，而不是一句「这是学校功能」——
   * 学校入口关掉之后，这是他唯一能看出自己当前身份的地方。
   */
  onAccTap() {
    if (!this.data.isGuest) {
      this.goAccounts()
      return
    }
    const a = AUTH.get()
    if (a.role === 'anonymous') {
      wx.showModal({
        title: '已退出登录',
        content: '用手机号重新登录就能回到原来的记录；想用平台同步，就登录学校账号。',
        confirmText: '去登录',
        success: (r) => {
          if (r.confirm) wx.reLaunch({ url: '/pages/welcome/welcome' })
        }
      })
      return
    }
    const who = a.nickname || a.phone || '访客'
    wx.showModal({
      title: '当前是访客身份',
      content:
        who +
        ' · 记事本、专注、手动课表、手动待办都能用。\n\n平台绑定和任务同步要本校学号，退出后再登录学校账号就行。',
      confirmText: '退出登录',
      cancelText: '继续用',
      success: (r) => {
        if (r.confirm) this.doLogout()
      }
    })
  },

  goSchedule() {
    wx.navigateTo({ url: '/pages/schedule/schedule' })
  },

  goNotes() {
    wx.navigateTo({ url: '/pages/notes/notes' })
  },

  goTomato() {
    wx.navigateTo({ url: '/pages/tomato/tomato' })
  },

  onSubscribe() {
    const tmplId = CONFIG.SUBSCRIBE_TEMPLATE_ID
    if (!tmplId) {
      wx.showModal({
        title: '还没配置模板',
        content:
          '需要先在微信公众平台申请订阅消息模板，把模板 ID 填到 miniprogram/utils/config.js 和云函数的 lib/notify.js 里。详见部署手册第 7 步。',
        showCancel: false
      })
      return
    }

    // 必须在点击事件的同步调用栈里拉起，不能包在异步回调中
    wx.requestSubscribeMessage({
      tmplIds: [tmplId],
      success: (res) => {
        if (res[tmplId] === 'accept') {
          api
            .addReminder()
            .then((d) => {
              this.setData({
                remindRemaining: d.remaining,
                remindText: `已开启 · 还可接收 ${d.remaining} 次`
              })
              wx.showToast({ title: '已开启每日提醒', icon: 'success' })
            })
            .catch((e) => {
              wx.showModal({ title: '开启失败', content: e.message, showCancel: false })
            })
        } else if (res[tmplId] === 'reject') {
          wx.showModal({
            title: '你拒绝了授权',
            content: '没有授权就收不到提醒，随时可以再点一次开启。',
            showCancel: false
          })
        }
      },
      fail: (err) => {
        wx.showModal({
          title: '拉起授权失败',
          content:
            ((err && err.errMsg) || '未知错误') +
            '\n\n提示：订阅消息授权需要在真机上测试，开发者工具模拟器里可能无法拉起。',
          showCancel: false
        })
      }
    })
  },

  onPlatformTap(e) {
    if (this.data.isGuest) {
      this.denyGuest()
      return
    }
    const key = e.currentTarget.dataset.key
    const p = this.data.platforms.find((x) => x.key === key)
    if (p && p.bound) {
      this.setData({ filter: key, courseFilter: 'all' }, () => {
        this.rebuildCourseChips()
        this.rebuildGroups()
      })
    } else {
      wx.navigateTo({ url: '/pages/accounts/accounts?platform=' + key })
    }
  }
})
