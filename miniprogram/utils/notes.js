/**
 * 便签（仿 vivo 便签）
 *
 * 全部存在本机，不联网、不占用云端额度：
 *   notes_v1 → [{ id, title, body, color, pinned, createdAt, updatedAt }]
 *
 * 排序规则和 vivo 便签一致：置顶的在最前，其余按「最后修改时间」倒序。
 */
const SCOPE = require('./scope.js')
const KEY = 'notes_v1'

const COLORS = [
  { key: 'plain', name: '默认' },
  { key: 'yellow', name: '米黄' },
  { key: 'pink', name: '樱粉' },
  { key: 'blue', name: '天蓝' },
  { key: 'green', name: '薄荷' },
  { key: 'purple', name: '藕紫' }
]

const COLOR_KEYS = COLORS.map((c) => c.key)

function nowTs() {
  return Date.now()
}

function uid() {
  return 'n' + nowTs().toString(36) + Math.random().toString(36).slice(2, 6)
}

function str(v) {
  return v === undefined || v === null ? '' : String(v)
}

/**
 * 单调递增的时间戳。
 * 连点两下、同一毫秒内保存两条时，Date.now() 会撞在一起，
 * 排序就退化成「看运气」—— 所以永远比库里最大的时间再大 1 毫秒。
 */
function nextStamp(all) {
  const now = nowTs()
  let max = 0
  ;(all || []).forEach((n) => {
    if (Number(n.updatedAt) > max) max = Number(n.updatedAt)
    if (Number(n.createdAt) > max) max = Number(n.createdAt)
  })
  return now > max ? now : max + 1
}

/** 老数据/脏数据都过一遍，保证页面拿到的字段齐全 */
function normalize(n) {
  const o = n && typeof n === 'object' ? n : {}
  const created = Number(o.createdAt) || nowTs()
  return {
    id: str(o.id) || uid(),
    title: str(o.title),
    body: str(o.body),
    color: COLOR_KEYS.indexOf(o.color) > -1 ? o.color : 'plain',
    pinned: o.pinned === true,
    createdAt: created,
    updatedAt: Number(o.updatedAt) || created
  }
}

function read() {
  let raw
  try {
    raw = wx.getStorageSync(SCOPE.key(KEY))
  } catch (e) {
    raw = null
  }
  if (!Array.isArray(raw)) return []
  return raw.map(normalize)
}

function write(list) {
  const arr = Array.isArray(list) ? list.map(normalize) : []
  try {
    wx.setStorageSync(SCOPE.key(KEY), arr)
  } catch (e) {
    /* 存储写满时不该把页面搞崩，交给上层提示 */
  }
  return arr
}

/** 置顶优先，然后按最后修改时间倒序 */
function sort(list) {
  return list.slice().sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return (b.updatedAt || 0) - (a.updatedAt || 0)
  })
}

function list() {
  return sort(read())
}

function get(id) {
  const all = read()
  for (let i = 0; i < all.length; i++) if (all[i].id === id) return all[i]
  return null
}

/**
 * 新增或更新。没有 id（或库里找不到）就当新增。
 * 只传了 title 的话，body 沿用原来的 —— 免得「只改标题」把正文清空。
 */
function save(input) {
  const all = read()
  const src = input && typeof input === 'object' ? input : {}
  const id = str(src.id)
  const idx = id ? all.findIndex((x) => x.id === id) : -1
  const stamp = nextStamp(all)

  if (idx > -1) {
    const prev = all[idx]
    const next = normalize({
      id: prev.id,
      title: src.title === undefined ? prev.title : str(src.title),
      body: src.body === undefined ? prev.body : str(src.body),
      color: src.color || prev.color,
      pinned: src.pinned === undefined ? prev.pinned : src.pinned === true,
      createdAt: prev.createdAt,
      updatedAt: stamp
    })
    all[idx] = next
    write(all)
    return next
  }

  const created = normalize({
    id: id || uid(),
    title: str(src.title),
    body: str(src.body),
    color: src.color || 'plain',
    pinned: src.pinned === true,
    createdAt: stamp,
    updatedAt: stamp
  })
  all.push(created)
  write(all)
  return created
}

function remove(id) {
  const all = read().filter((x) => x.id !== id)
  write(all)
  return all.length
}

function clear() {
  write([])
  return 0
}

function togglePin(id) {
  const all = read()
  const i = all.findIndex((x) => x.id === id)
  if (i < 0) return null
  all[i] = normalize(Object.assign({}, all[i], { pinned: !all[i].pinned, updatedAt: all[i].updatedAt }))
  write(all)
  return all[i]
}

/** 标题兜底：vivo 便签里标题空着时，列表显示正文第一行 */
function titleOf(n) {
  const t = str(n && n.title).trim()
  if (t) return t
  const body = str(n && n.body).replace(/\r/g, '')
  const first = body.split('\n').find((line) => line.trim())
  return first ? first.trim() : '空便签'
}

/** 列表摘要：把标题那一行从正文里去掉，剩下的压成一行 */
function digestOf(n, max) {
  const limit = Number(max) > 0 ? Number(max) : 60
  const title = str(n && n.title).trim()
  let body = str(n && n.body).replace(/\r/g, '')
  if (!title) {
    // 没写标题时，正文第一行已经被当标题显示了，摘要从第二行起
    const lines = body.split('\n')
    const i = lines.findIndex((l) => l.trim())
    body = i > -1 ? lines.slice(i + 1).join(' ') : ''
  }
  const flat = body.replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  return flat.slice(0, limit) + '…'
}

/** 纯文本长度（列表里显示「共 xx 字」用） */
function lengthOf(n) {
  const t = str(n && n.title).trim()
  const b = str(n && n.body).replace(/\s+/g, '')
  return (t + b).length
}

/** 搜索：标题 + 正文，不区分大小写 */
function match(n, kw) {
  const q = str(kw).trim().toLowerCase()
  if (!q) return true
  const hay = (str(n && n.title) + ' ' + str(n && n.body)).toLowerCase()
  return hay.indexOf(q) > -1
}

function search(kw) {
  return list().filter((n) => match(n, kw))
}

/**
 * 时间标签：今天 14:32 / 昨天 / 10月21日 / 2025年10月21日
 * 传入 now 方便测试。
 */
function timeLabel(ts, now) {
  const t = Number(ts) || 0
  if (!t) return ''
  const cur = now ? new Date(now) : new Date()
  const d = new Date(t)
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.round((startOf(cur) - startOf(d)) / 86400000)
  const hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2)

  if (diffDays === 0) return '今天 ' + hm
  if (diffDays === 1) return '昨天'
  if (diffDays === 2) return '前天'
  if (d.getFullYear() === cur.getFullYear()) return d.getMonth() + 1 + '月' + d.getDate() + '日'
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日'
}

function stats() {
  const all = read()
  const pinned = all.filter((x) => x.pinned).length
  return { total: all.length, pinned: pinned }
}

module.exports = {
  KEY,
  COLORS,
  COLOR_KEYS,
  normalize,
  list,
  get,
  save,
  remove,
  clear,
  togglePin,
  titleOf,
  digestOf,
  lengthOf,
  match,
  search,
  timeLabel,
  stats
}
