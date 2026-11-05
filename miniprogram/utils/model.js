const PLATFORMS = {
  chaoxing: { key: 'chaoxing', name: '学习通', short: '超星', color: '#E8453C', tag: 'tag-chaoxing', dot: 'p-chaoxing' },
  educoder: { key: 'educoder', name: '希冀', short: '希冀', color: '#2B7FFF', tag: 'tag-educoder', dot: 'p-educoder' },
  unipus:   { key: 'unipus',   name: 'U校园', short: 'U校园', color: '#11B981', tag: 'tag-unipus',   dot: 'p-unipus' },
  zhihuishu: { key: 'zhihuishu', name: '智慧树', short: '智慧树', color: '#8B5CF6', tag: 'tag-zhihuishu', dot: 'p-zhihuishu' },
  icourse163: { key: 'icourse163', name: '爱课程', short: '爱课程', color: '#0EA5E9', tag: 'tag-icourse163', dot: 'p-icourse163' },
  yuketang: { key: 'yuketang', name: '雨课堂', short: '雨课堂', color: '#F59E0B', tag: 'tag-yuketang', dot: 'p-yuketang' },
  // 自己创建的任务。只做标识/配色，不进 PLATFORM_LIST（首页不占一张平台卡，
  // 入口是筛选行里的「＋ 新任务」按钮）
  custom: { key: 'custom', name: '自定义', short: '自定义', color: '#64748B', tag: 'tag-custom', dot: 'p-custom' }
}

const PLATFORM_LIST = [
  PLATFORMS.chaoxing,
  PLATFORMS.educoder,
  PLATFORMS.unipus
]

const TASK_TYPES = {
  video:    { label: '视频',   icon: '▶' },
  doc:      { label: '文档',   icon: '📄' },
  quiz:     { label: '测验',   icon: '✎' },
  homework: { label: '作业',   icon: '📝' },
  exam:     { label: '考试',   icon: '⚠' },
  discuss:  { label: '讨论',   icon: '💬' },
  practice: { label: '实训',   icon: '⌘' },
  live:     { label: '直播',   icon: '📡' },
  chapter:  { label: '章节',   icon: '📚' },
  custom:   { label: '自定义', icon: '📌' },
  other:    { label: '其他',   icon: '•' }
}

function platformOf(key) {
  return PLATFORMS[key] || PLATFORMS.chaoxing
}

function typeOf(key) {
  return TASK_TYPES[key] || TASK_TYPES.other
}

/* ---------- 截止时间友好化 ---------- */
const DAY = 86400000

function startOfDay(ts) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * @returns {{text: string, level: 'expired'|'urgent'|'soon'|'normal'|'none', days: number|null}}
 */
function formatDeadline(deadline, now) {
  if (!deadline) return { text: '无截止时间', level: 'none', days: null }
  const nowTs = now || Date.now()
  const diff = deadline - nowTs
  const days = Math.round((startOfDay(deadline) - startOfDay(nowTs)) / DAY)
  const hm = fmtTime(deadline)

  if (diff < 0) {
    const overdue = Math.ceil(-diff / DAY)
    return { text: overdue <= 1 ? '已截止' : `已截止 ${overdue} 天`, level: 'expired', days }
  }
  if (days === 0) return { text: diff < 3 * 3600000 ? `今天 ${hm} · 快到了` : `今天 ${hm}`, level: 'urgent', days }
  if (days === 1) return { text: `明天 ${hm}`, level: 'urgent', days }
  if (days <= 3) return { text: `${days} 天后 · ${hmStr(deadline)}`, level: 'soon', days }
  if (days <= 7) return { text: `${days} 天后 · ${hmStr(deadline)}`, level: 'normal', days }
  return { text: `${fmtDate(deadline)} ${hm}`, level: 'normal', days }
}

function pad(n) { return n < 10 ? '0' + n : '' + n }
function fmtTime(ts) { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
function fmtDate(ts) { const d = new Date(ts); return `${d.getMonth() + 1}月${d.getDate()}日` }
function hmStr(ts) { return `${fmtDate(ts)} ${fmtTime(ts)}` }

function relativeTime(ts) {
  if (!ts) return '从未同步'
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚同步'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < DAY) return `${Math.floor(diff / 3600000)} 小时前`
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} 天前`
  return fmtDate(ts)
}

/**
 * U校园任务标题归一化（纯显示层兜底）。
 *
 * 云端同步时已经把标题裁到「Unit Test / Further Listening」这一层，
 * 但数据库里可能还躺着上一次同步写进去的旧记录，形如
 *   Unit 3 A journey of discovery · 3-6 Further listening > News report 1
 * 只要用户没重新点同步，这种挂着小题名的长标题就会一直显示。
 * 这里在渲染前再裁一刀：只保留目标项之前的层级 + 规范名，不动原始数据。
 */
const UNIPUS_KIND = [
  { re: /unit\s*test/i, label: 'Unit Test' },
  { re: /further\s*listening/i, label: 'Further Listening' }
]

function cleanTitle(platform, title) {
  const raw = String(title || '')
  if (platform !== 'unipus' || !raw) return raw
  // 「单元标题 · 层级 > 层级 > 叶子」；没有分隔符时整串当层级看
  const dot = raw.lastIndexOf(' · ')
  const head = dot > -1 ? raw.slice(0, dot) : ''
  const tail = dot > -1 ? raw.slice(dot + 3) : raw
  const segs = tail.split('>').map((s) => s.trim()).filter(Boolean)
  if (!segs.length) return raw
  let at = -1
  let label = ''
  for (let i = 0; i < segs.length && at < 0; i++) {
    for (let k = 0; k < UNIPUS_KIND.length; k++) {
      if (UNIPUS_KIND[k].re.test(segs[i])) {
        at = i
        label = UNIPUS_KIND[k].label
        break
      }
    }
  }
  if (at < 0) return raw
  const shown = segs.slice(0, at).concat([label]).join(' > ')
  return head ? head + ' · ' + shown : shown
}

/**
 * 合并「同一份作业被抓成两条」。
 *
 * 超星的作业页会把同一个作业在不同区块各渲染一次（未交区 / 已交区），
 * 两处的 workId 还不一样，于是数据库里并存一条「待做」和一条「待批阅」。
 * 用户交完作业，首页仍挂着一条要交，怎么同步都消不掉 —— 因为确实有两条记录。
 *
 * 认「同一份」的两条路：
 *   1. 同平台 + 同课程 + 同标题，其中**存在已完成**那条 —— 其余全当它的分身。
 *      这一条不看截止时间：两个区块渲染出的截止时间经常对不上（已交区那行有时把
 *      「提交时间」当截止时间读），卡时间窗口会让它永远合不进来，这正是上一版没生效的原因。
 *   2. 全是未完成 —— 只有截止时间相近（差一天内，或任一方没解析出时间）才合，
 *      免得把「小测 1 / 小测 1（补考）」这种同名真作业吞掉。
 *
 * 合并后保留「已完成」那条：它的链接指向已交的作业，点进去能看到自己交的东西。
 * 自定义任务不参与：用户自己建的两条同名待办是真的两条。
 *
 * stats 可选，回传 `{ merged }`，首页据此显示「已合并 N 条重复」——哪层生效一眼可查。
 */
function mergeDuplicates(list, stats) {
  const arr = Array.isArray(list) ? list : []
  const DAY = 86400000
  const norm = (s) => String(s || '').replace(/[\s\u3000]+/g, '')
  const near = (a, b) => {
    const x = a || 0
    const y = b || 0
    if (!x || !y) return true
    return Math.abs(x - y) < DAY
  }

  const groups = {}
  const slots = [] // 每组在原始列表里的首个位置，最后按它排序输出
  arr.forEach((t, i) => {
    if (!t || !t.platform || t.platform === 'custom') {
      slots.push({ pos: i, items: [t] })
      return
    }
    const key = [t.platform, norm(t.courseName), norm(t.title)].join('|')
    const g = groups[key]
    if (g) {
      g.items.push(t)
      return
    }
    const slot = { pos: i, items: [t] }
    groups[key] = slot
    slots.push(slot)
  })
  slots.sort((a, b) => a.pos - b.pos)

  const out = []
  slots.forEach((s) => {
    const done = s.items.filter((x) => x && x.status === 'done')
    if (done.length) {
      out.push(done[0])
      return
    }
    const keep = []
    s.items.forEach((it) => {
      if (!it) return
      if (!keep.some((k) => near(k.deadline, it.deadline))) keep.push(it)
    })
    keep.forEach((k) => out.push(k))
  })

  if (stats && typeof stats === 'object') stats.merged = arr.length - out.length
  return out
}

module.exports = {
  PLATFORMS,
  PLATFORM_LIST,
  TASK_TYPES,
  platformOf,
  typeOf,
  formatDeadline,
  relativeTime,
  fmtDate,
  fmtTime,
  cleanTitle,
  mergeDuplicates
}
