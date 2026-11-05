const cloud = require('wx-server-sdk')

// ⚠️ 必须放在 require 业务模块之前。
// 否则 lib/store 等模块拿不到已初始化的云环境，云函数启动即崩溃（-504002）。
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 服务版本：每次改完云函数代码【改这里】再部署，小程序端会显示在首页页脚，
// 一眼分清云端跑的是新是旧（部署没生效是最常见的「改了没用」原因）
const VER = '20261028.19'

const store = require('./lib/store')
const adapters = require('./adapters')
const secret = require('./lib/secret')
const notify = require('./lib/notify')
const qrlogin = require('./lib/qrlogin')
const zzu = require('./lib/zzu')
const users = require('./lib/users')
const permissions = require('./lib/permissions')

const NAME_MAP = {
  chaoxing: '学习通',
  educoder: '希冀',
  unipus: 'U校园',
  zhihuishu: '智慧树',
  icourse163: '爱课程',
  yuketang: '雨课堂',
  custom: '自定义'
}
const DAY = 86400000

function ok(data) {
  return { code: 0, data }
}
function fail(message, extra) {
  return Object.assign({ code: 500, message }, extra || {})
}
/** 没权限：单独一个 code，前端好区分「服务出错」和「你不该点这个」 */
function deny(message) {
  return { code: 403, message: message || '当前身份不能使用这个功能' }
}

/**
 * 哪些操作只给本校账号（清单在 lib/permissions.js，测试也读它）。
 * 访客（手机号注册）点进来一律 403——前端也会把入口藏掉，
 * 但**真正的边界在这里**：改前端就能绕过的东西不能算权限。
 */
const SCHOOL_ONLY = permissions.SCHOOL_ONLY

/** 把数据库里的账号记录转成适配器能用的明文凭据 */
function toCredential(acc) {
  const plain = secret.decrypt(acc.secret)
  if (acc.mode === 'cookie') {
    return { mode: 'cookie', cookie: plain, username: acc.username }
  }
  return { mode: 'password', username: acc.username, password: plain }
}

/**
 * 只能由客户端抓的账号（如学校内网的希冀）。
 * 这类平台的地址是私有 IP，云函数根本连不上，任务由小程序抓完推上来，
 * 所以云端同步、定时任务都要跳过它们，否则会被误标成「登录已失效」。
 */
/**
 * 由客户端（小程序直连 / 本地代理）抓取的账号。
 * 云端手里只有一句占位凭据，拿它去抓公网版本必然失败，还会把账号误标成「失效」。
 */
function isClientOnly(acc) {
  return !!acc && (acc.mode === 'intranet' || acc.mode === 'proxy')
}

/** 清理返回给前端的账号字段，绝不带凭据 */
function publicAccount(acc) {
  return {
    _id: acc._id,
    platform: acc.platform,
    mode: acc.mode,
    username: acc.username,
    maskedUser: acc.maskedUser || acc.username,
    status: acc.status || 'ok',
    lastSyncAt: acc.lastSyncAt || 0,
    lastError: acc.lastError || ''
  }
}

/** 订阅消息 thing 类型最多 20 字，超了微信会直接拒发 */
function clip(str, max) {
  const s = String(str || '').replace(/\s+/g, ' ')
  const n = max || 20
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function fmtDeadline(ts) {
  const d = new Date(ts)
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`
}

/* ---------------- 同步 ---------------- */

/**
 * 单平台任务条数上限。
 *
 * 一个学生单平台正常也就几十到一两百条任务。一旦上千，几乎可以肯定是适配器
 * 把「不用做的材料」也当成任务收进来了（U校园出过这事：1675 条，连课文、
 * 视频都算任务）。这种数据一旦入库，首页 getDashboard 一次全返回会撑爆
 * 云函数 1MB 响应上限，用户连登录都进不去。
 *
 * 所以宁可这一次不写库，把 debug 原样抛回去——保住可用性，同时能看清
 * 接口到底返回了什么结构。
 */
const TASK_LIMIT_PER_PLATFORM = 500

async function syncOne(owner, acc) {
  const adapter = adapters.get(acc.platform)
  const result = await adapter.sync(toCredential(acc))
  const tasks = result.tasks || []
  if (tasks.length > TASK_LIMIT_PER_PLATFORM) {
    // 把适配器的诊断直接拼进报错：用户点同步就能在弹窗里看到接口真实结构，
    // 不用再单独去翻日志。过滤规则全靠字段名，这一步是校准规则的唯一依据。
    const diag = (result.debug || []).filter(
      (d) => String(d).indexOf('【诊断】') === 0
    )
    const err = new Error(
      '读到 ' + tasks.length + ' 条任务，数量异常（正常应少于 ' +
        TASK_LIMIT_PER_PLATFORM + ' 条），已拒绝写入，以免首页数据撑爆。' +
        (diag.length ? '\n\n' + diag.join('\n') : '')
    )
    err.debug = result.debug || []
    err.taskCount = tasks.length
    throw err
  }
  const n = await store.replacePlatformTasks(owner, acc.platform, tasks)
  await store.updateAccount(acc._id, { status: 'ok', lastSyncAt: Date.now(), lastError: '' })
  return { count: n, debug: result.debug || [] }
}

async function handleSync(owner, platform) {
  const accounts = await store.listAccounts(owner)
  if (!accounts.length) return ok({ count: 0, errors: ['尚未绑定任何平台'] })

  const all = !platform || platform === 'all' ? accounts : accounts.filter((a) => a.platform === platform)
  /*
   * 云端抓不了的账号（mode=intranet / proxy）也要在结果里占一行。
   *
   * 早先这类平台被直接从 details 里过滤掉：用户点「同步全部」，弹窗里只有学习通
   * 和 U校园两行，看不到「学习通其实根本没被云端抓」。等他的学习通恰好是旧的
   * 「本地代理」账号时，就变成「点了同步什么都没变」——而且完全没线索。
   */
  const clientOnlyAccs = all.filter(isClientOnly)
  const clientRows = clientOnlyAccs.map((a) => ({
    platform: a.platform,
    count: 0,
    skipped: true,
    note:
      a.mode === 'proxy'
        ? '旧版「本地代理」账号，云端没有它的登录凭据，抓不了；到账号页重新绑一次就能云端同步'
        : '校园内网，云端连不上，只能在小程序里「直连同步」抓'
  }))

  const targets = all.filter((a) => !isClientOnly(a))
  if (!targets.length) {
    const clientOnly = clientOnlyAccs.map((a) => NAME_MAP[a.platform] || a.platform)
    return ok({
      count: 0,
      errors: [],
      details: clientRows,
      skipped: clientOnly.length
        ? [
            clientOnly.join('、') +
              ' 由客户端抓取，需要在小程序里手动点「直连同步」或「抓任务并上传」'
          ]
        : []
    })
  }

  let count = 0
  const errors = []
  const details = clientRows.slice()

  // 串行抓取，降低被风控的概率
  for (const acc of targets) {
    const label = NAME_MAP[acc.platform] || acc.platform
    try {
      const r = await syncOne(owner, acc)
      count += r.count
      details.push({ platform: acc.platform, count: r.count, debug: r.debug })
    } catch (e) {
      const msg = (e && e.message) || '未知错误'
      errors.push(label + '：' + msg)
      await store.updateAccount(acc._id, { status: 'invalid', lastError: msg })
      // debug 要带出来：任务数异常被拒写时，只有 debug 能看出接口真实结构
      details.push({
        platform: acc.platform,
        count: 0,
        error: msg,
        debug: (e && e.debug) || [],
        taskCount: (e && e.taskCount) || 0
      })
    }
  }

  // srvVer 跟着同步结果一起回去：同步弹窗直接显示云端版本，
  // 省得为了确认「部署有没有生效」再翻到页脚看。
  return ok({ count, errors, details, srvVer: VER })
}

/* ---------------- 定时任务（每小时同步，晚间发提醒） ---------------- */

// 同一账号两次自动同步的最小间隔：定时器每小时跑一次，55 分钟内同步过的跳过，
// 避免「手动同步完 10 分钟后定时器又来一遍」对平台风控的压力
const AUTO_SYNC_MIN_INTERVAL = 55 * 60 * 1000
// 订阅消息每天只在晚间这一小时发（定时器每小时都会跑，提醒不能跟着刷屏）
const REMINDER_HOUR = 21

async function runHourlyJob() {
  const owners = await store.listOwners()
  const now = new Date()
  const reminderTime = now.getHours() === REMINDER_HOUR
  let syncedAccounts = 0
  let skippedFresh = 0
  let pushed = 0
  const pushErrors = []

  for (const owner of owners) {
    // 发订阅消息要真 openid；查数据要归属键（访客是 'g::' + openid）
    const openid = users.openidOfOwner(owner)
    // 1. 把各平台最近的变化同步下来（55 分钟内同步过的账号跳过）
    let accounts = []
    try {
      accounts = await store.listAccounts(owner)
    } catch (e) {
      continue
    }
    for (const acc of accounts) {
      if (isClientOnly(acc)) continue // 校园内网平台由客户端抓，云端连不上
      if (acc.lastSyncAt && now.getTime() - acc.lastSyncAt < AUTO_SYNC_MIN_INTERVAL) {
        skippedFresh++
        continue
      }
      try {
        await syncOne(owner, acc)
        syncedAccounts++
      } catch (e) {
        await store.updateAccount(acc._id, {
          status: 'invalid',
          lastError: (e && e.message) || '同步失败'
        })
      }
    }

    // 2. 定时提醒（用户给任务设的 remindAt 到点了）：任何整点都可能到点，每个整点都查
    try {
      const tasks = await store.listTasks(owner)
      const due = store.dueReminders(tasks, Date.now())
      for (const t of due) {
        const rem = await store.getReminder(owner)
        if (!rem || !rem.remaining) break // 额度用完：留着 remindedAt 不标，攒到额度再发（一天内有效）
        const r = await notify.sendTodoDigest(openid, {
          summary: clip(t.title, 20),
          deadline: t.deadline ? fmtDeadline(t.deadline) : '无截止时间',
          detail: clip(`${t.courseName || '自定义'} · 定时提醒`, 20)
        })
        if (r.ok) {
          await store.bumpReminder(owner, -1)
          await store.markReminded(t._id)
          pushed++
        } else {
          pushErrors.push(r.reason || 'remind failed')
          // 用户拒收（43101）：再发也发不出，标记掉避免每小时重试
          if (r.errCode === 43101) await store.markReminded(t._id)
        }
      }
    } catch (e) {
      pushErrors.push('remind: ' + ((e && e.message) || e))
    }

    // 3. 每日汇总：只在晚间这一小时发，其他 23 次只同步不打扰
    if (!reminderTime) continue
    try {
      const rem = await store.getReminder(owner)
      if (!rem || !rem.remaining) continue

      const tasks = await store.listTasks(owner)
      const nowTs = Date.now()
      const soon = tasks
        .filter(
          (t) => t.status !== 'done' && t.deadline && t.deadline > nowTs && t.deadline < nowTs + 2 * DAY
        )
        .sort((a, b) => a.deadline - b.deadline)

      if (!soon.length) continue

      const first = soon[0]
      const r = await notify.sendTodoDigest(openid, {
        summary: clip(`${soon.length} 项待办，最近：${first.title}`, 20),
        deadline: fmtDeadline(first.deadline),
        detail: clip(`${first.courseName} · ${NAME_MAP[first.platform] || ''}`, 20)
      })
      if (r.ok) {
        await store.bumpReminder(owner, -1)
        pushed++
      } else {
        pushErrors.push(r.reason || 'push failed')
      }
    } catch (e) {
      pushErrors.push((e && e.message) || 'push error')
    }
  }

  console.log('[hourlyJob]', {
    users: owners.length,
    syncedAccounts,
    skippedFresh,
    reminderTime,
    pushed,
    pushErrors
  })
  return ok({
    users: owners.length,
    syncedAccounts,
    skippedFresh,
    pushed,
    pushErrors: pushErrors.slice(0, 5)
  })
}

/* ---------------- 入口 ---------------- */

exports.main = async (event) => {
  // 定时触发器进来的是 Timer 事件，没有 action
  if (event && (event.Type === 'Timer' || event.type === 'timer')) {
    return runHourlyJob()
  }

  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  if (!openid) return fail('无法识别用户身份')

  const action = event.action

  try {
    // 每个请求先认一次身份：既用来挡学校功能，也用来算数据归属键。
    // 查不到角色（集合还没建 / 网络抖动）按老用户放行——不能把存量用户锁在门外。
    let role = 'school'
    try {
      role = await users.roleOf(openid)
    } catch (e) {
      console.warn('[studyHub] role check failed', (e && e.message) || e)
    }
    if (role !== 'school' && SCHOOL_ONLY.indexOf(action) > -1) {
      return deny(
        role === 'anonymous'
          ? '已经退出登录了，重新登录后再用学校功能'
          : '访客账号只能用记事本、专注和手动课表'
      )
    }
    // 业务数据一律按归属键读写：学校账号是裸 openid，访客是 'g::' + openid。
    // 别把 openid 直接丢给 store —— 那会让访客读到学校账号同步下来的任务。
    const owner = users.ownerOf(openid, role)

    switch (action) {
      case 'getDashboard': {
        // 访客没有平台账号，别去查（查了也是空），顺便把身份告诉前端好渲染
        const prof = await users.profile(openid)
        const guest = prof.role !== 'school'
        const [accounts, tasks, reminder] = await Promise.all([
          guest ? Promise.resolve([]) : store.listAccounts(owner),
          store.listTasks(owner),
          store.getReminder(owner)
        ])
        // 兜底：库里若已混入异常数据（历史版本 U校园把预习材料也算任务，1675 条），
        // 一次全返回会撑爆云函数 1MB 响应上限，用户连登录都进不去。
        // 这里按「必做 > 未完成」排优先级后硬截断，保证 dashboard 一定返回得出去；
        // 同步成功后数据自然收敛，截断就不再生效。
        const DASH_TASK_CAP = 400
        const rank = (t) =>
          (t.required ? 0 : 2) + (t.status === 'done' ? 1 : 0)
        const overflow = tasks.length > DASH_TASK_CAP
        const visible = overflow
          ? tasks.slice().sort((a, b) => rank(a) - rank(b)).slice(0, DASH_TASK_CAP)
          : tasks
        return ok({
          srvVer: VER,
          role: prof.role,
          profile: prof,
          accounts: guest ? [] : accounts.map(publicAccount),
          tasks: visible,
          taskOverflow: overflow ? tasks.length : 0,
          reminder: {
            remaining: (reminder && reminder.remaining) || 0,
            enabled: notify.isConfigured()
          }
        })
      }

      /* ---- 账号：手机号注册 / 登录（访客身份，不碰学校系统） ---- */

      case 'registerPhone': {
        const prof = await users.register({
          openid,
          phone: event.phone,
          password: event.password,
          nickname: event.nickname
        })
        return ok({ role: prof.role, profile: prof, srvVer: VER })
      }

      case 'loginPhone': {
        // 先记下这个手机号原来挂在谁名下：换微信登录时要把数据搬过来
        const before = await users.findByPhone(event.phone).catch(() => null)
        const prof = await users.login({
          openid,
          phone: event.phone,
          password: event.password
        })
        if (before && before.openid && before.openid !== openid && before.role !== 'school') {
          await store
            .moveOwner(users.ownerOf(before.openid, 'guest'), owner)
            .catch((e) => console.warn('[studyHub] moveOwner failed', (e && e.message) || e))
        }
        return ok({ role: prof.role, profile: prof, srvVer: VER })
      }

      case 'whoami': {
        const prof = await users.profile(openid)
        return ok({ role: prof.role, profile: prof, srvVer: VER })
      }

      /** 本校学生登录成功后打标（记学号），老用户没有记录也照样能用 */
      case 'markSchool': {
        const prof = await users.markSchool({ openid, username: event.username })
        return ok({ role: prof.role, profile: prof })
      }

      case 'logoutAccount':
        return ok(await users.logout(openid))

      case 'syncTasks':
        return await handleSync(owner, event.platform)

      case 'saveAccount': {
        const { platform, mode, username, password, cookie } = event
        if (!platform) return fail('缺少平台参数')
        if (mode !== 'cookie' && mode !== 'password') return fail('登录方式不合法')
        if (mode === 'cookie' && (!cookie || String(cookie).length < 10)) {
          return fail('Cookie 内容太短，请检查是否复制完整')
        }
        if (mode === 'password' && (!username || !password)) {
          return fail('请填写账号和密码')
        }

        const plain = mode === 'cookie' ? String(cookie) : String(password)
        const id = await store.upsertAccount(owner, {
          platform,
          mode,
          username: String(username || (mode === 'cookie' ? 'Cookie 登录' : '')),
          maskedUser: secret.mask(username || 'Cookie 登录'),
          secret: secret.encrypt(plain),
          status: 'ok',
          lastError: ''
        })
        return ok({ id })
      }

      /* ---- 扫码登录（目前仅学习通支持） ---- */

      case 'qrStart': {
        const s = await qrlogin.start(openid)
        return ok(s)
      }

      case 'qrPoll': {
        const r = await qrlogin.poll(event.token, openid)
        if (r.state !== 'ok') return ok(r)

        // 扫码通过 = 已经拿到真实登录态，直接落库并顺手同步一次
        const username = r.nickname || (r.uid ? '学习通 ' + r.uid : '学习通扫码')
        const id = await store.upsertAccount(owner, {
          platform: 'chaoxing',
          mode: 'cookie',
          username,
          maskedUser: secret.mask(username),
          secret: secret.encrypt(r.cookie),
          status: 'ok',
          lastError: ''
        })

        let count = 0
        const errors = []
        // 只打字段名，不打值，方便在云函数日志里判断登录态补全了没有
        console.log('[qrPoll] 扫码成功', {
          nickname: username,
          ready: r.ready,
          alive: r.alive,
          hops: r.hops,
          keys: r.keys
        })
        try {
          const acc = await store.getAccountById(owner, id)
          const synced = await syncOne(owner, acc)
          count = synced.count
        } catch (e) {
          const msg = (e && e.message) || '同步失败'
          console.log('[qrPoll] 课程抓取失败', { alive: r.alive, hops: r.hops, msg })
          errors.push('学习通：' + msg)
          if (!r.alive) {
            errors.push('登录态在服务端被判定为未登录（跟着页面跳转时被踢回登录页），Cookie 本身不是缺字段。')
          }
          await store.updateAccount(id, { status: 'invalid', lastError: msg })
        }

        return ok({
          state: 'ok',
          nickname: username,
          cookieReady: !!r.ready,
          cookieAlive: !!r.alive,
          cookieKeys: r.keys || [],
          accountId: id,
          count,
          errors
        })
      }

      case 'deleteAccount': {
        if (!event.id) return fail('缺少账号 ID')
        await store.removeAccount(owner, event.id)
        return ok({ deleted: true })
      }

      /**
       * 学习通网络自检。
       *
       * 云函数跑在机房 IP 上，学习通有可能只认登录时的那条链路。
       * 这里把 Cookie 交给小程序，让它在「用户自己的网络」上直接请求一次，
       * 就能分清到底是 Cookie 本身有问题，还是云函数的出口 IP 被区别对待。
       * Cookie 本来就是该用户自己的凭据，只回传给同一个 openid。
       */
      case 'cxSelfTest': {
        const acc = await store.findAccount(owner, 'chaoxing')
        if (!acc) return fail('还没有绑定学习通')
        let cookie = ''
        try {
          cookie = secret.decrypt(acc.secret)
        } catch (e) {
          return fail('凭据读取失败，请重新绑定')
        }
        return ok({
          cookie,
          targets: [
            {
              name: '课程接口',
              url: 'https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1',
              kind: 'json'
            },
            {
              name: '课程页',
              url: 'https://mooc1.chaoxing.com/visit/courses',
              kind: 'html'
            }
          ]
        })
      }

      /**
       * 学习通作业状态诊断：抓两门课的作业页，把「平台原文写的状态」带回来。
       * 「交了作业同步后还是未完成」时，用这个分清是平台页面的问题还是解析的问题。
       */
      case 'cxWorkDiag': {
        const acc = await store.findAccount(owner, 'chaoxing')
        if (!acc) return fail('还没有绑定学习通')
        const base = {
          srvVer: VER,
          account: {
            mode: acc.mode,
            status: acc.status || '',
            lastError: acc.lastError || '',
            lastSyncAt: acc.lastSyncAt || 0
          }
        }
        /*
         * proxy / intranet 账号的 secret 里存的是模式名（'proxy'），不是密码也不是 Cookie。
         * 照常去登录只会得到「账号或密码不正确」，把真正的原因盖住了 ——
         * 真正的结论是：这种账号云端从来不抓，数据只能停在最后一次客户端抓取。
         */
        if (isClientOnly(acc)) {
          return ok(
            Object.assign(base, {
              diag: {
                clientOnly: acc.mode,
                error:
                  acc.mode === 'proxy'
                    ? '这个账号是旧版「本地代理」方式绑的：云端没有它的登录凭据，所以云端同步根本不会抓学习通。' +
                      '到账号页把学习通重新绑一次（扫码最快），之后云端就能自动抓了。'
                    : '这是「校园内网直连」账号，云端连不上，只能在小程序里点「直连同步」。'
              }
            })
          )
        }
        const adapter = adapters.get('chaoxing')
        if (!adapter || !adapter.diagnose) return fail('当前云函数版本不支持诊断，请重新部署')
        const diag = await adapter.diagnose(toCredential(acc), { courses: event.courses || 2 })
        return ok(Object.assign(base, { diag }))
      }

      /**
       * 客户端抓取结果回传入库。
       *
       * 给「希冀校园内网」这类云函数够不着的平台用：小程序直连抓完之后把任务推上来，
       * 首页、统计、每日提醒都还是读云端这一份，不用为此改前端展示逻辑。
       */
      case 'pushTasks': {
        const platform = String(event.platform || '')
        if (!platform) return fail('缺少平台参数')
        const raw = Array.isArray(event.tasks) ? event.tasks : []
        if (!raw.length) return fail('没有可写入的任务')
        if (raw.length > 300) return fail('任务数量异常（' + raw.length + ' 条），已拒绝写入')

        const clean = raw
          .slice(0, 300)
          .map((t) => ({
            externalId: String(t.externalId || '').slice(0, 200),
            courseId: String(t.courseId || '').slice(0, 60),
            courseName: String(t.courseName || '').slice(0, 80),
            title: String(t.title || '').slice(0, 120),
            taskType: String(t.taskType || 'other').slice(0, 20),
            deadline: Number(t.deadline) > 0 ? Number(t.deadline) : 0,
            progress:
              t.progress && typeof t.progress === 'object'
                ? { done: Number(t.progress.done) || 0, total: Number(t.progress.total) || 0 }
                : null,
            status: t.status === 'done' ? 'done' : 'todo',
            url: String(t.url || '').slice(0, 300),
            required: t.required === true,
            semesterKey: String(t.semesterKey || '').slice(0, 24),
            semesterLabel: String(t.semesterLabel || '').slice(0, 40),
            semesterShort: String(t.semesterShort || '').slice(0, 16),
            semesterRank: Number(t.semesterRank) || 0
          }))
          .filter((t) => t.externalId && t.title)

        if (!clean.length) return fail('任务数据不合法（缺少标题或唯一标识）')

        // 账号记录也要有，否则账号页会一直显示「未绑定」
        // mode 区分两种「客户端抓取」：校园内网直连 / 本地代理
        const clientMode = event.mode === 'proxy' ? 'proxy' : 'intranet'
        const label = clientMode === 'proxy' ? '本地代理' : '校园内网直连'
        await store.upsertAccount(owner, {
          platform,
          mode: clientMode,
          username: label,
          maskedUser: label,
          secret: secret.encrypt(clientMode),
          status: 'ok',
          lastError: '',
          lastSyncAt: Date.now()
        })

        const count = await store.replacePlatformTasks(owner, platform, clean)
        return ok({ count, accepted: clean.length })
      }

      case 'toggleTask': {
        if (!event.taskId) return fail('缺少任务 ID')
        await store.toggleTask(owner, event.taskId, !!event.done)
        return ok({ updated: true })
      }

      /** 新建/编辑自定义任务（remindAt 为提醒时间戳，0 = 不提醒） */
      case 'saveCustomTask': {
        if (!event.title) return fail('任务名不能为空')
        const id = await store.saveCustomTask(owner, {
          id: event.id || '',
          title: event.title,
          courseName: event.courseName || '',
          deadline: Number(event.deadline) || 0,
          remindAt: Number(event.remindAt) || 0
        })
        return ok({ id })
      }

      /** 删除任务（自定义任务用） */
      case 'deleteTask': {
        if (!event.taskId) return fail('缺少任务 ID')
        await store.deleteTask(owner, event.taskId)
        return ok({ deleted: true })
      }

      /** 给任意任务设提醒时间（0 = 关闭提醒） */
      case 'setTaskReminder': {
        if (!event.taskId) return fail('缺少任务 ID')
        await store.setTaskReminder(owner, event.taskId, Number(event.remindAt) || 0)
        return ok({ updated: true })
      }

      case 'addReminder': {
        if (!notify.isConfigured()) {
          return fail('还没配置订阅消息模板，暂时无法开启每日提醒')
        }
        const remaining = await store.bumpReminder(owner, 1)
        return ok({ remaining })
      }

      case 'getReminder': {
        const reminder = await store.getReminder(owner)
        return ok({
          remaining: (reminder && reminder.remaining) || 0,
          enabled: notify.isConfigured()
        })
      }

      case 'testAccount': {
        const acc = await store.getAccountById(owner, event.id)
        if (!acc) return fail('账号不存在')
        const adapter = adapters.get(acc.platform)
        const result = await adapter.sync(toCredential(acc))
        return ok({ count: (result.tasks || []).length, debug: result.debug || [] })
      }

      /* ---- 郑大课表：统一身份认证 → 门户（全程云端，手机单独可用） ---- */

      case 'zzuProbe':
        return ok(await zzu.probe())

      /**
       * 一步到位：
       *   已有登录态 → 直接拉课表
       *   没有 → 返回验证码图（needCaptcha），带上 captcha 再调一次即可
       */
      case 'zzuAuto': {
        const r = await zzu.auto({
          openid,
          username: event.username,
          password: event.password,
          captcha: event.captcha,
          tgc: event.tgc,
          from: event.from,
          to: event.to,
          forceLogin: event.forceLogin
        })
        // 认证真过了就当场把身份改成 school。
        // 别指望前端再调一次 markSchool：那一步一旦失败（旧版云函数、网络抖动），
        // 云端还当他 / 她是访客，首页会把同步按钮和平台卡片全关掉，
        // 表现就是「学校账号明明登上了，却什么都不能用」。
        if (r && r.success) {
          try {
            await users.markSchool({ openid, username: event.username })
          } catch (e) {
            console.warn('[studyHub] markSchool failed', (e && e.message) || e)
          }
        }
        return ok(r)
      }

      case 'zzuSchedule':
        return ok(await zzu.schedule({ openid, from: event.from, to: event.to }))

      /**
       * 课表诊断：把上次拉取时教务实际返回的排课摘要出来。
       * 课表不完整时看一眼就能分清：教务给的数据缺 vs 解析丢的。
       */
      case 'zzuTableDebug':
        return ok(await zzu.tableDebug({ openid }))

      /**
       * 二次验证的下半场：把用户收到的短信验证码交给云端。
       *   { code: '123456' }        → 校验并继续登录
       *   { resend: true }          → 只重发短信
       * 依赖 zzuAuto 存下的 MFA 接力态（mfaGid 等），没有就提示先走一遍登录。
       */
      case 'zzuMfaVerify':
        return ok(await zzu.mfaVerify({ openid, code: event.code, resend: event.resend }))

      case 'zzuStatus':
        return ok(await zzu.status({ openid }))

      case 'zzuLogout':
        return ok(await zzu.logout({ openid }))

      case 'platforms':
        return ok(adapters.list())

      default:
        return fail('未知操作：' + action)
    }
  } catch (e) {
    console.error('[studyHub] error', action, e)
    return fail((e && e.message) || '服务异常')
  }
}
