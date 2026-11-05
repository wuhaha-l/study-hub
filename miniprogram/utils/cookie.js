/**
 * Cookie 文本清洗。
 *
 * 用户拿到 Cookie 的方式五花八门，这里统一处理成标准的 "k=v; k=v" 格式：
 *   1. 直接复制的 Cookie 串
 *   2. 带 "Cookie:" 前缀的请求头
 *   3. DevTools → Application → Cookies 表格（制表符分隔）
 *   4. DevTools 的 Copy as cURL 命令
 */
function normalizeCookie(raw) {
  let s = String(raw || '').trim()
  if (!s) return ''
  const notes = []

  // ---- 1. cURL 命令：抽出 -H 'cookie: ...' ----
  const curl = s.match(/(?:-H|--header)\s+['"]cookie:\s*([^'"]+)['"]/i)
  if (curl) {
    s = curl[1]
    notes.push('已从 cURL 中提取 Cookie')
  } else if (/^curl\s/i.test(s)) {
    // 是 cURL 但没匹配到 cookie 头，交给后面兜底
    notes.push('识别为 cURL，但没找到 cookie 头')
  }

  // ---- 2. 去掉 "Cookie:" 前缀 ----
  const before = s
  s = s.replace(/^\s*cookie:\s*/i, '')
  if (before !== s) notes.push('已去掉 Cookie: 前缀')

  // ---- 3. 表格格式（含制表符或换行）----
  if (s.indexOf('\t') > -1 || /\r?\n/.test(s)) {
    const lines = s.split(/\r?\n/)
    const pairs = []
    let tableRows = 0

    lines.forEach((line) => {
      if (!line.trim()) return
      const cols = line.split('\t')

      if (cols.length >= 2) {
        // 表格行：name \t value \t domain \t path ...
        const name = cols[0].trim()
        const value = cols[1].trim()
        if (/^(name|名称)$/i.test(name)) return // 表头
        if (!name || !/^[A-Za-z0-9_.\-]+$/.test(name)) return
        pairs.push(name + '=' + value)
        tableRows++
      } else if (line.indexOf('=') > -1) {
        // 普通 name=value 行
        line
          .split(';')
          .map((x) => x.trim())
          .filter((x) => x && x.indexOf('=') > 0)
          .forEach((x) => pairs.push(x))
      }
    })

    if (tableRows > 0) {
      s = pairs.join('; ')
      notes.push('已从表格中提取 ' + tableRows + ' 条')
    } else if (pairs.length) {
      s = pairs.join('; ')
    } else {
      s = s.replace(/\s*\r?\n\s*/g, ' ')
    }
  }

  // ---- 4. 规范化分隔符 ----
  s = s
    .replace(/\s*;\s*/g, '; ')
    .replace(/;\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()

  // ---- 5. 去掉明显无效的条目 ----
  const kept = s
    .split(';')
    .map((x) => x.trim())
    .filter((x) => {
      const i = x.indexOf('=')
      if (i <= 0) return false
      const name = x.slice(0, i)
      return /^[A-Za-z0-9_.\-]+$/.test(name)
    })

  s = kept.join('; ')

  return {
    cookie: s,
    count: kept.length,
    notes
  }
}

/** 关键凭证是否齐全，用于给用户提示 */
function checkCookie(cookie) {
  const names = String(cookie || '')
    .split(';')
    .map((x) => x.split('=')[0].trim())
    .filter(Boolean)

  const has = (n) => names.indexOf(n) > -1
  return {
    count: names.length,
    names,
    // 学习通的核心凭证
    chaoxingReady: has('_uid') && has('_d') && has('uf'),
    hasUid: has('_uid'),
    hasD: has('_d'),
    hasUf: has('uf')
  }
}

module.exports = { normalizeCookie, checkCookie }
