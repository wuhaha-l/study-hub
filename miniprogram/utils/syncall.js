/**
 * 一次同步，三个平台一起动。
 *
 * 为什么不能只调云端那一下：
 *   希冀是校园内网（10.67.4.x），云函数跑在公网机房，根本连不上。
 *   云端 handleSync 会把 mode=intranet / proxy 的账号**直接过滤掉**，
 *   所以首页那颗「同步全部课程和任务」对希冀一直是空转 ——
 *   只有学习通和 U校园真的更新了，希冀永远是上次直连同步时的样子。
 *   看起来就像个摆设。
 *
 * 现在的分工（两条路并发跑）：
 *   希冀            → 本机直连抓（edu.syncAndPush），和账号页那颗「直连同步」同一条路，
 *                     抓完 pushTasks 上传，云端任务表被整体替换
 *   学习通 / U校园   → 云端抓（api.sync('all')），用绑定在云端的 Cookie
 *
 * 合成一张表返回，页面拿去弹窗：每个平台多少条、几条已完成、哪条失败。
 * 希冀失败不影响学习通 / U校园 的结果（反过来也一样）。
 */

const relogin = require('./relogin')

const ORDER = ['chaoxing', 'educoder', 'unipus', 'zhihuishu', 'icourse163', 'yuketang']
const LABEL = {
  chaoxing: '学习通',
  educoder: '希冀',
  unipus: 'U校园',
  zhihuishu: '智慧树',
  icourse163: '爱课程',
  yuketang: '雨课堂',
  custom: '自定义'
}

function labelOf(k) {
  return LABEL[k] || k
}

/** 平台排序：认识的按 ORDER，不认识的排后面（云端将来加平台也不会被藏掉） */
function rankOf(k) {
  const i = ORDER.indexOf(k)
  return i < 0 ? ORDER.length : i
}

function blankRow(platform, extra) {
  return Object.assign(
    {
      platform: platform,
      label: labelOf(platform),
      count: 0,
      // 平台自己说「这条交了」的条数（希冀右栏的提交时间）
      submitted: 0,
      debug: [],
      error: '',
      skipped: false,
      note: '',
      from: ''
    },
    extra || {}
  )
}

/**
 * 把云端那次的结果折成 rows。
 * 云端 details: [{ platform, count, debug, error }]
 * 云端整体失败时，把每个「本该云端抓」的平台都标成失败 ——
 * 只说一句「同步失败」用户不知道是哪个平台挂了。
 */
function cloudRows(cloud, accounts) {
  const out = []
  if (cloud && cloud.ok) {
    const r = cloud.r || {}
    ;(r.details || []).forEach((d) => {
      if (!d || !d.platform || d.platform === 'custom') return
      out.push(
        blankRow(d.platform, {
          count: Number(d.count) || 0,
          debug: d.debug || [],
          error: d.error ? String(d.error) : '',
          // 云端抓不了的账号（旧的本地代理 / 校园内网）也要露出来一行：
          // 早先直接把这类平台从结果里丢掉，用户点完同步只会觉得「什么都没变」
          skipped: d.skipped === true,
          note: d.note ? String(d.note) : '',
          from: 'cloud'
        })
      )
    })
    return out
  }

  // 整体失败（云函数没部署 / 网络断了）
  const msg = (cloud && cloud.e && cloud.e.message) || '云端同步失败'
  ;(accounts || []).forEach((a) => {
    if (!a || !a.platform || a.platform === 'custom') return
    if (a.mode === 'intranet' || a.mode === 'proxy') return
    if (out.some((x) => x.platform === a.platform)) return
    out.push(blankRow(a.platform, { error: msg, from: 'cloud' }))
  })
  return out
}

/**
 * 希冀那一行：本机结果优先。
 * 云端就算真的返回了 educoder（老版本云函数会），也以本机为准 ——
 * 云端的希冀数据本来就是 pushTasks 传上去的，本机才是源头。
 */
function applyEdu(rows, eduRes, eduReady, hasEduAcc) {
  const list = rows.filter((r) => r.platform !== 'educoder')

  if (eduRes && eduRes.ok) {
    const r = eduRes.r || {}
    const count = Number(r.count) || 0
    const names = {}
    ;(r.tasks || []).forEach((t) => {
      if (t && t.courseName) names[t.courseName] = 1
    })
    list.push(
      blankRow('educoder', {
        count: count,
        submitted: Number(r.submitted) || 0,
        from: 'client',
        note: Object.keys(names).length > 1 ? Object.keys(names).length + ' 门课' : ''
      })
    )
    return list
  }

  if (eduRes) {
    const msg = (eduRes.e && eduRes.e.message) || '直连抓取失败'
    // 平台上一条作业都没有时 pushTasks 会报「没有可写入的任务」，
    // 这不是故障，别把用户吓一跳
    const empty = /没有可写入/.test(msg)
    list.push(
      blankRow('educoder', {
        from: 'client',
        error: empty ? '' : msg,
        note: empty ? '平台上暂时没有作业' : ''
      })
    )
    return list
  }

  // 本机没登录希冀但云端有这条账号：说清楚怎么补，别只留一个「跳过」
  if (hasEduAcc) {
    list.push(
      blankRow('educoder', {
        skipped: true,
        note: '本机还没登录希冀，去账号页点一次「直连同步」，之后这里就会一起抓'
      })
    )
  }
  return list
}

/**
 * @param {object} opts
 *   accounts  云端返回的账号列表（用来知道有哪些平台、哪些是内网）
 *   api/edu   注入点，测试用；不传就 require 真的
 *   onStep    文案回调（同步期间显示在首页那颗按钮上）
 */
async function syncAll(opts) {
  const o = opts || {}
  const api = o.api || require('./api.js')
  const edu = o.edu || require('./edu.js')
  const accounts = Array.isArray(o.accounts) ? o.accounts : []
  const onStep = typeof o.onStep === 'function' ? o.onStep : function () {}

  // 本机有没有希冀的登录态：有就一定抓，哪怕云端账号记录还没建
  // （第一次抓的时候就是「本机有 cookie、云端没记录」的状态）
  let eduReady = false
  try {
    const cfg = edu.getCfg()
    eduReady = !!(cfg && cfg.cookie)
  } catch (e) {
    eduReady = false
  }
  const hasEduAcc = accounts.some((a) => a && a.platform === 'educoder')

  // 云端真正会动的平台（intranet / proxy 云端连不上，别算进进度里）
  const cloudTargets = accounts.filter(
    (a) => a && a.platform && a.platform !== 'custom' && a.mode !== 'intranet' && a.mode !== 'proxy'
  )
  const total = cloudTargets.length + (eduReady ? 1 : 0)
  if (total > 1) {
    onStep('正在同步 ' + total + ' 个平台（含希冀直连）…')
  } else if (eduReady) {
    // 只有希冀：直接说「直连」，用户才知道为什么要等十几秒
    onStep('正在直连希冀…')
  } else {
    onStep('正在同步…')
  }

  /*
   * 只有校园内网账号（纯希冀用户）时就不用麻烦云函数了 —— 它只会返回一句
   * 「已跳过」。accounts 为空时不能跳：那说明首页还没拉到账号列表，
   * 这时候跳过会把云端能抓的平台漏掉。
   */
  const skipCloud = accounts.length > 0 && cloudTargets.length === 0
  // 两条路并发：一个走客户端网络进内网，一个走云函数，互不排队
  const cloudP = skipCloud
    ? Promise.resolve({ ok: true, r: { details: [], count: 0 } })
    : api
        .sync('all')
        .then((r) => {
          // 云端一般几秒就回来了，希冀要十几秒：说一句「还在等」，
          // 免得用户以为卡死在同一个文案上
          if (eduReady) onStep('云端平台已回来，还在等希冀直连…')
          return { ok: true, r: r }
        })
        .catch((e) => ({ ok: false, e: e }))
  const eduP = eduReady
    ? edu
        .syncAndPush()
        .then((r) => ({ ok: true, r: r }))
        .catch((e) => ({ ok: false, e: e }))
    : Promise.resolve(null)

  const both = await Promise.all([cloudP, eduP])
  const rows = applyEdu(cloudRows(both[0], accounts), both[1], eduReady, hasEduAcc)
  rows.sort((a, b) => rankOf(a.platform) - rankOf(b.platform))

  const cloud = both[0]
  return {
    rows: rows,
    count: rows.reduce((s, r) => s + (r.error ? 0 : r.count), 0),
    errors: rows.filter((r) => r.error).map((r) => r.label + '：' + r.error),
    // 本机没登录希冀时给页面一个提示位（不改同步结果）
    eduReady: eduReady,
    // 云端版本号跟着带出来：改了云函数却没生效时，弹窗里一眼能对上
    srvVer: (cloud && cloud.ok && cloud.r && cloud.r.srvVer) || ''
  }
}

/**
 * 弹窗文案。doneOf(platform) 从首页那份任务里数已完成条数
 * （云端只回来总数，不给 done 数，所以只能页面自己数）。
 */
function report(result, doneOf) {
  const rows = (result && result.rows) || []
  const done = typeof doneOf === 'function' ? doneOf : function () { return 0 }
  const lines = []
  let doneAll = 0
  let needLogin = 0

  rows.forEach((r) => {
    if (r.error) {
      /*
       * 登录类失败单独标一句。光看「账号或密码不正确」，用户第一反应是
       * 自己记错了密码；其实是登录态过期，去账号页点一下「重新登录」就好。
       */
      const cred = relogin.CRED_RE.test(String(r.error))
      if (cred) needLogin++
      lines.push(r.label + '  ✗ ' + r.error + (cred ? '  ← 需要重新登录' : ''))
      return
    }
    if (r.skipped) {
      lines.push(r.label + '  跳过 · ' + r.note)
      return
    }
    const n = done(r.platform)
    doneAll += n
    lines.push(r.label + '  ' + r.count + ' 条' + (n ? ' · ' + n + ' 条已完成' : '') + (r.note ? ' · ' + r.note : ''))
    // 平台自己的明细（U校园的「教材：共 N 条」），最多 3 行，多了挤
    ;(r.debug || [])
      .map((x) => String(x))
      .filter((x) => /共 \d+ 条$/.test(x) || /往期教材/.test(x))
      .slice(0, 3)
      .forEach((x) => {
        if (/往期教材/.test(x)) {
          lines.push('    ✕ ' + x.replace(/：往期教材.*$/, '') + '（往期，已忽略）')
          return
        }
        const num = (x.match(/共 (\d+) 条$/) || [])[1]
        lines.push('    · ' + x.replace(/: 必做.*$/, '') + '  ' + num + ' 条')
      })
  })

  const head = '共 ' + ((result && result.count) || 0) + ' 条' + (doneAll ? ' · ' + doneAll + ' 条已完成' : '')
  const tail = needLogin
    ? '\n\n' + needLogin + ' 个平台是登录过期。首页顶部会挂着一条提醒，点它就能重新登录。'
    : ''
  return {
    title: '已更新 ' + ((result && result.count) || 0) + ' 项',
    content: rows.length ? head + '\n\n' + lines.join('\n') + tail : '这次没有可写入的任务'
  }
}

module.exports = {
  syncAll,
  report,
  cloudRows,
  applyEdu,
  labelOf,
  rankOf,
  ORDER,
  LABEL
}
