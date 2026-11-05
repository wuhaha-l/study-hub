/**
 * 轻量 HTTP 客户端：自带 Cookie 容器，手动处理重定向。
 * 零第三方依赖。
 *
 * 优先用全局 fetch（Node 18+）；若运行时没有 fetch（如云函数 Node 16.13），
 * 自动降级到内置 http/https 模块，行为与 fetch 保持一致。
 */

const http = require('http')
const https = require('https')
const zlib = require('zlib')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

class CookieJar {
  constructor(init) {
    this.map = new Map()
    if (init) this.load(init)
  }

  /** 从 "a=1; b=2" 形式的字符串载入 */
  load(str) {
    if (!str) return this
    String(str)
      .split(';')
      .forEach((pair) => {
        const i = pair.indexOf('=')
        if (i > 0) {
          const k = pair.slice(0, i).trim()
          const v = pair.slice(i + 1).trim()
          if (k) this.map.set(k, v)
        }
      })
    return this
  }

  /** 从单条 Set-Cookie 头载入（只取 key=value） */
  setFromHeader(line) {
    if (!line) return
    const first = String(line).split(';')[0]
    const i = first.indexOf('=')
    if (i <= 0) return
    const k = first.slice(0, i).trim()
    const v = first.slice(i + 1).trim()
    if (!k) return
    // 过期即删除
    const lower = String(line).toLowerCase()
    if (/max-age=0|expires=thu, 01 jan 1970/.test(lower)) {
      this.map.delete(k)
      return
    }
    this.map.set(k, v)
  }

  header() {
    return Array.from(this.map.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ')
  }

  get(k) {
    return this.map.get(k)
  }

  has(k) {
    return this.map.has(k)
  }

  size() {
    return this.map.size
  }

  toObject() {
    const o = {}
    this.map.forEach((v, k) => {
      o[k] = v
    })
    return o
  }
}

function readSetCookies(res) {
  const h = res.headers
  if (typeof h.getSetCookie === 'function') {
    try {
      const arr = h.getSetCookie()
      if (arr && arr.length) return arr
    } catch (e) {
      /* 忽略 */
    }
  }
  const raw = h.get('set-cookie')
  if (!raw) return []
  // 粗略按逗号切分（Expires 里的逗号后面不跟 name= 的情况会被过滤掉）
  return raw.split(/,(?=[^;,=\s]+=)/)
}

/** 把 Node 原始的 headers 对象包装成 fetch 风格的 Headers，让上层无感 */
function wrapHeaders(raw) {
  return {
    get(name) {
      const v = raw[String(name).toLowerCase()]
      if (v === undefined) return null
      return Array.isArray(v) ? v.join(', ') : v
    },
    getSetCookie() {
      const v = raw['set-cookie']
      if (!v) return []
      return Array.isArray(v) ? v : [v]
    },
    raw
  }
}

/**
 * Node 16 兼容实现：用内置 http/https 发一次请求，返回和 fetch Response 同形的对象。
 * 上层只用到 status / headers.get / headers.getSetCookie / text() / json()。
 */
function nodeRequest(url, init, timeout) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(url)
    } catch (e) {
      return reject(new Error('URL 非法：' + url))
    }
    const isHttps = u.protocol === 'https:'
    const lib = isHttps ? https : http
    const ms = timeout || 20000

    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: (init.method || 'GET').toUpperCase(),
        headers: init.headers || {}
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          let buf = Buffer.concat(chunks)
          // 少数站点即便没发 accept-encoding 也会压缩，兜一层
          const enc = String(res.headers['content-encoding'] || '').toLowerCase()
          try {
            if (enc === 'gzip') buf = zlib.gunzipSync(buf)
            else if (enc === 'deflate') buf = zlib.inflateSync(buf)
            else if (enc === 'br') buf = zlib.brotliDecompressSync(buf)
          } catch (e) {
            /* 解压失败就用原始字节 */
          }
          const text = buf.toString('utf8')
          resolve({
            status: res.statusCode,
            headers: wrapHeaders(res.headers),
            url,
            text: async () => text,
            arrayBuffer: async () =>
              buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
            json: () => JSON.parse(text)
          })
        })
      }
    )

    req.setTimeout(ms, () => {
      req.destroy(new Error('请求超时：' + url))
    })
    req.on('error', (e) => {
      reject(new Error('网络请求失败：' + (e && e.message ? e.message : String(e))))
    })
    if (init.body) req.write(init.body)
    req.end()
  })
}

async function doFetch(url, init, timeout) {
  // Node 18+ 走原生 fetch
  if (typeof fetch === 'function') {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout || 20000)
    try {
      return await fetch(url, Object.assign({}, init, { signal: controller.signal }))
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('请求超时：' + url)
      // cause 里才是真正的原因（ECONNRESET / ENOTFOUND / 证书错误），别丢掉
      const cause = e && e.cause
      const detail =
        cause && (cause.code || cause.errno || cause.message)
          ? '（' + String(cause.code || cause.errno || cause.message) + '）'
          : ''
      throw new Error('网络请求失败：' + (e && e.message ? e.message : String(e)) + detail)
    } finally {
      clearTimeout(timer)
    }
  }
  // Node 16 及以下走内置模块
  return nodeRequest(url, init, timeout)
}

/**
 * @param {string} url
 * @param {{method?:string, headers?:object, body?:any, jar?:CookieJar, timeout?:number, maxRedirect?:number}} opts
 * @returns {Promise<{status:number, headers:any, text:string, url:string, json:Function}>}
 */
async function request(url, opts) {
  opts = opts || {}
  const jar = opts.jar
  const maxRedirect = opts.maxRedirect === undefined ? 8 : opts.maxRedirect
  let currentUrl = url
  let method = (opts.method || 'GET').toUpperCase()
  let body = opts.body
  let redirects = 0

  while (redirects <= maxRedirect) {
    const headers = Object.assign(
      {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'accept-encoding': 'gzip, deflate',
        // 现代浏览器会带这些客户端提示头，缺了很容易被风控识别成脚本
        'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-site',
        'upgrade-insecure-requests': '1'
      },
      opts.headers || {}
    )
    if (jar) {
      const c = jar.header()
      if (c) headers.cookie = c
    }
    if (body && method === 'POST' && !headers['content-type']) {
      headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8'
    }

    const res = await doFetch(currentUrl, { method, headers, body, redirect: 'manual' }, opts.timeout)

    if (jar) readSetCookies(res).forEach((line) => jar.setFromHeader(line))

    const status = res.status
    const location = res.headers.get('location')
    if (status >= 300 && status < 400 && location && redirects < maxRedirect) {
      let next
      try {
        next = new URL(location, currentUrl).toString()
      } catch (e) {
        throw new Error('重定向地址非法：' + location)
      }
      if (status === 303 || (method === 'POST' && (status === 301 || status === 302))) {
        method = 'GET'
        body = undefined
      }
      currentUrl = next
      redirects++
      continue
    }

    const text = await res.text()
    return {
      status,
      headers: res.headers,
      text,
      url: currentUrl,
      json() {
        return JSON.parse(text)
      }
    }
  }
  throw new Error('重定向次数过多：' + url)
}

/**
 * 下载二进制资源（二维码图片等），返回 Buffer。
 * 和 request 不同，这里不转字符串，避免图片字节被 UTF-8 破坏。
 */
async function requestBinary(url, opts) {
  opts = opts || {}
  const jar = opts.jar
  const headers = Object.assign(
    {
      'user-agent': UA,
      accept: 'image/avif,image/webp,image/png,image/*,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9',
      // 图片不压缩，省掉解压环节
      'accept-encoding': 'identity'
    },
    opts.headers || {}
  )
  if (jar) {
    const c = jar.header()
    if (c) headers.cookie = c
  }

  const res = await doFetch(url, { method: 'GET', headers }, opts.timeout || 15000)
  if (jar) readSetCookies(res).forEach((line) => jar.setFromHeader(line))

  let buffer
  if (typeof res.arrayBuffer === 'function') {
    buffer = Buffer.from(await res.arrayBuffer())
  } else if (typeof res.buffer === 'function') {
    buffer = res.buffer()
  } else {
    buffer = Buffer.from(await res.text(), 'utf8')
  }

  return {
    status: res.status,
    contentType: res.headers.get('content-type') || '',
    buffer
  }
}

/** POST JSON，返回解析后的对象 */
async function postJson(url, payload, opts) {
  const res = await request(
    url,
    Object.assign({}, opts, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: Object.assign({}, (opts && opts.headers) || {}, {
        'content-type': 'application/json;charset=UTF-8'
      })
    })
  )
  return res.json()
}

function formBody(obj) {
  const parts = []
  Object.keys(obj).forEach((k) => {
    const v = obj[k]
    if (v === undefined || v === null) return
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
  })
  return parts.join('&')
}

/** 从 HTML 里抽指定属性/文本，返回第一个匹配 */
function matchOne(html, re) {
  const m = String(html || '').match(re)
  return m ? (m[1] !== undefined ? m[1] : m[0]) : ''
}

/** 把 "2026-10-25 23:59" / "2026/10/25" / "10-25 23:59" 之类转成毫秒时间戳 */
function parseDate(str, nowTs) {
  if (!str) return 0
  const now = nowTs || Date.now()
  let s = String(str).replace(/年|月/g, '-').replace(/日/g, '').trim()
  s = s.replace(/\//g, '-').replace(/\s+/g, ' ')

  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})[ T]*(\d{1,2})?:?(\d{1,2})?/)
  if (m) {
    const y = +m[1]
    const mo = +m[2] - 1
    const d = +m[3]
    const h = m[4] ? +m[4] : 23
    const mi = m[5] ? +m[5] : 59
    return new Date(y, mo, d, h, mi, 0).getTime()
  }

  // "10-25 23:59" 这类缺年份的
  m = s.match(/(\d{1,2})-(\d{1,2})[ T]*(\d{1,2})?:?(\d{1,2})?/)
  if (m) {
    const y = new Date(now).getFullYear()
    const ts = new Date(y, +m[1] - 1, +m[2], m[3] ? +m[3] : 23, m[4] ? +m[4] : 59, 0).getTime()
    // 早于现在 3 个月以上，视为明年
    return ts < now - 90 * 86400000 ? ts + 365 * 86400000 : ts
  }
  return 0
}

module.exports = { CookieJar, request, requestBinary, postJson, formBody, matchOne, parseDate, UA }
