/**
 * 「哪些平台该重新登录了」—— 统一判定 + 本地留痕
 *
 * 为什么需要它：登录过期这件事在各个页面里表现都不一样 ——
 * 首页只看到任务不再变多，账号页只看到一句「失效」，同步弹窗里是一行红字错误。
 * 用户很难把这三件事连起来，于是「同步了没变化」反复出现。
 *
 * 判定三个来源，优先级从高到低：
 *   1. 云端账号 status === 'invalid' —— 云函数自己已经认定登录挂了
 *   2. 本地记下的凭据类错误 —— 诊断弹窗、同步失败时写进来（云端不一定落库）
 *   3. 老模式账号（本地代理 / 校园内网直连）—— 云端没有可用凭据，结构上就抓不到
 * 前两个是「真的过期了，去重新登录」，第三个是「换了绑定方式才能云端同步」，
 * 文案必须分开说，否则用户会去重填一个根本救不了的密码。
 */

const M = require('./model')

const SEEN_KEY = 'relogin_seen_v1'
const MUTE_KEY = 'relogin_mute_date'
// 本地记录 30 天自然过期：陈年旧错一直挂着，比不提醒更烦人
const SEEN_TTL = 30 * 86400000

/*
 * 凭据类错误。命中这些才算「要重新登录」；
 * 超时、断网、云函数没部署都不算 —— 那种情况重登一百次也没用。
 */
const CRED_RE = new RegExp(
  [
    '账号或密码不正确',
    '账号密码错误',
    '密码错误',
    '登录已?失效',
    '登录状态.{0,6}(失效|过期|异常)',
    '未登录',
    '需要登录',
    '请先登录',
    '重新登录',
    'cookie.{0,8}(失效|过期|无效|不完整)',
    'session.{0,8}(失效|过期)',
    '票据.{0,6}(失效|过期)',
    'unauthorized',
    '凭据'
  ].join('|'),
  'i'
)

const LEGACY_MODES = { proxy: true, intranet: true }

const REASON_TEXT = {
  expired: '登录已失效',
  cred: '同步时报了登录错误',
  legacy: '本地代理 / 内网直连，云端没有凭据'
}

/* ---------------- 本地存储（node 里跑测试时退化成内存） ---------------- */

const mem = {}

function getRaw(key) {
  try {
    if (typeof wx !== 'undefined' && wx.getStorageSync) return wx.getStorageSync(key)
  } catch (e) {
    /* ignore */
  }
  return mem[key]
}

function setRaw(key, val) {
  mem[key] = val
  try {
    if (typeof wx !== 'undefined' && wx.setStorageSync) wx.setStorageSync(key, val)
  } catch (e) {
    /* ignore */
  }
}

function delRaw(key) {
  delete mem[key]
  try {
    if (typeof wx !== 'undefined' && wx.removeStorageSync) wx.removeStorageSync(key)
  } catch (e) {
    /* ignore */
  }
}

/* ---------------- 判定 ---------------- */

function isLegacy(acc) {
  return !!(acc && LEGACY_MODES[acc.mode])
}

/** 本地那条记录还在有效期内吗 */
function seenOf(map, key, now) {
  const rec = map && map[key]
  if (!rec || !rec.at) return null
  if (now - rec.at > SEEN_TTL) return null
  return rec
}

/**
 * 单条账号判定。
 * @returns {{need:boolean, reason:string, reasonText:string, detail:string}}
 */
function inspect(acc, seen, now) {
  const t = now || Date.now()
  const blank = { need: false, reason: '', reasonText: '', detail: '' }
  if (!acc || !acc.platform) return blank

  const err = String(acc.lastError || '').trim()
  const rec = seenOf(seen, acc.platform, t)

  // 1. 云端认定失效：最硬的证据，直接压过一切
  if (acc.status === 'invalid') {
    return {
      need: true,
      reason: 'expired',
      reasonText: REASON_TEXT.expired,
      detail: err
    }
  }

  // 2. 本地记下的凭据错误（诊断弹窗抓到的、同步当场失败的）
  if (rec) {
    return {
      need: true,
      reason: 'cred',
      reasonText: REASON_TEXT.cred,
      detail: String(rec.msg || '').trim()
    }
  }

  // 3. 云端账号自己带回的凭据错误
  if (err && CRED_RE.test(err)) {
    return { need: true, reason: 'cred', reasonText: REASON_TEXT.cred, detail: err }
  }

  // 4. 老模式：不是「过期」，是「云端永远拿不到凭据」，换个说法
  if (isLegacy(acc)) {
    return {
      need: true,
      reason: 'legacy',
      reasonText: REASON_TEXT.legacy,
      detail: err
    }
  }

  return blank
}

/** 一条待办式的提醒项（页面直接渲染这个） */
function itemOf(acc, r) {
  const p = M.platformOf(acc.platform)
  return {
    key: acc.platform,
    name: p.name,
    color: p.color,
    reason: r.reason,
    reasonText: r.reasonText,
    detail: clip(r.detail),
    action: r.reason === 'legacy' ? '重绑' : '重新登录'
  }
}

function clip(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > 48 ? t.slice(0, 48) + '…' : t
}

/**
 * 汇总一批账号。
 * @param {Array} accounts 云端 dashboard 的 accounts
 * @param {{now?:number, seen?:object}} opts
 */
function survey(accounts, opts) {
  const o = opts || {}
  const now = o.now || Date.now()
  const seen = o.seen || readSeen()
  const items = []

  ;(accounts || []).forEach((acc) => {
    const r = inspect(acc, seen, now)
    if (r.need) items.push(itemOf(acc, r))
  })

  // 真的过期排在前面，老模式排后面：前者点一下就能救回来
  // 注意别写成 `rank[x] || 9` —— expired 的权重正好是 0，会被 || 当成「没定义」
  const rank = { expired: 0, cred: 1, legacy: 2 }
  const weight = (k) => (rank[k] === undefined ? 9 : rank[k])
  items.sort((a, b) => weight(a.reason) - weight(b.reason))

  const names = items.map((x) => x.name)
  return {
    count: items.length,
    items: items,
    keys: items.map((x) => x.key),
    names: names,
    title: items.length ? items.length + ' 个平台需要重新登录' : '',
    // 首页那条窄条只用一句话，太长会折三行
    text: items.length
      ? items.map((x) => x.name + (x.reason === 'legacy' ? ' 要重绑' : ' 登录过期')).join(' · ')
      : ''
  }
}

/* ---------------- 记一条 / 清一条 ---------------- */

/** 读本地记录（顺带把过期的清掉，免得越攒越多） */
function readSeen(now) {
  const t = now || Date.now()
  const all = getRaw(SEEN_KEY)
  if (!all || typeof all !== 'object') return {}
  const out = {}
  let dirty = false
  Object.keys(all).forEach((k) => {
    const rec = all[k]
    if (!rec || !rec.at || t - rec.at > SEEN_TTL) {
      dirty = true
      return
    }
    out[k] = rec
  })
  if (dirty) setRaw(SEEN_KEY, out)
  return out
}

/**
 * 记一条「这个平台登不上」。只记凭据类错误：
 * 网络超时记进来，用户会去重填一个没问题的密码。
 * @returns {boolean} 有没有记下来
 */
function note(platform, msg, now) {
  const text = String(msg || '').trim()
  if (!platform || !text) return false
  if (!CRED_RE.test(text)) return false
  const all = readSeen(now)
  all[platform] = { msg: clip(text), at: now || Date.now() }
  setRaw(SEEN_KEY, all)
  return true
}

/** 重登成功 / 解绑时清掉该平台 */
function clear(platform) {
  const all = readSeen()
  if (!all[platform]) return
  delete all[platform]
  setRaw(SEEN_KEY, all)
}

function reset() {
  delRaw(SEEN_KEY)
  delRaw(MUTE_KEY)
}

/* ---------------- 「稍后再说」 ---------------- */

function dayKey(now) {
  const d = new Date(now || Date.now())
  const m = d.getMonth() + 1
  const day = d.getDate()
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day)
}

/** 今天先不提醒（到明天零点自然恢复，免得真忘了） */
function muteToday(now) {
  setRaw(MUTE_KEY, dayKey(now))
}

function isMuted(now) {
  return getRaw(MUTE_KEY) === dayKey(now)
}

function unmute() {
  delRaw(MUTE_KEY)
}

module.exports = {
  inspect,
  survey,
  note,
  clear,
  reset,
  readSeen,
  isLegacy,
  isMuted,
  muteToday,
  unmute,
  dayKey,
  CRED_RE,
  SEEN_TTL,
  SEEN_KEY,
  MUTE_KEY
}
