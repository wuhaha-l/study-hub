/**
 * 极简 AES-128-ECB 加密（只实现「加密」，够登录用）。
 *
 * 为什么要自己写：小程序 JS 环境里没有 crypto、没有 Buffer，而这个学校的希冀平台
 * （educg / 「计算机类课程一体化平台」）在提交登录前会用 CryptoJS 处理密码：
 *
 *   key      = 'Client8Sess!06ID'   （16 字节 → AES-128）
 *   mode     = ECB
 *   padding  = Pkcs7
 *   toString → base64（CryptoJS 的默认输出）
 *
 * 换句话说：服务器要的是「AES-128-ECB(明文, 上面那把 key) 再 base64」。
 * 只要把同样的算法实现一遍，就能把明文密码算成服务器认的那串，
 * 于是——不用再让用户去浏览器里复制 Cookie 了。
 *
 * S 盒不抄表，按 GF(2^8) 逆元 + 仿射变换现算，省得手抄 256 个字节抄错。
 * 每个字节只在模块加载时算一次。
 */

/* ---------------- GF(2^8) ---------------- */

function gmul(a, b) {
  let p = 0
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a
    const hi = a & 0x80
    a = (a << 1) & 0xff
    if (hi) a ^= 0x1b
    b >>= 1
  }
  return p
}

/** a 的 n 次方（平方乘，n 最大 254） */
function gpow(a, n) {
  let r = 1
  let base = a
  while (n > 0) {
    if (n & 1) r = gmul(r, base)
    base = gmul(base, base)
    n >>= 1
  }
  return r
}

function rotl8(v, n) {
  return ((v << n) | (v >>> (8 - n))) & 0xff
}

/* ---------------- S 盒 ---------------- */

const SBOX = new Uint8Array(256)
for (let a = 0; a < 256; a++) {
  const inv = a === 0 ? 0 : gpow(a, 254)
  let s = inv
  for (let r = 1; r <= 4; r++) s ^= rotl8(inv, r)
  SBOX[a] = s ^ 0x63
}

/* ---------------- 密钥扩展（AES-128） ---------------- */

function expandKey(key) {
  const w = new Uint8Array(176)
  w.set(key)
  let rcon = 1
  for (let i = 16; i < 176; i += 4) {
    let t0 = w[i - 4]
    let t1 = w[i - 3]
    let t2 = w[i - 2]
    let t3 = w[i - 1]
    if (i % 16 === 0) {
      const tmp = t0
      t0 = SBOX[t1] ^ rcon
      t1 = SBOX[t2]
      t2 = SBOX[t3]
      t3 = SBOX[tmp]
      rcon = gmul(rcon, 2)
    }
    w[i] = w[i - 16] ^ t0
    w[i + 1] = w[i - 15] ^ t1
    w[i + 2] = w[i - 14] ^ t2
    w[i + 3] = w[i - 13] ^ t3
  }
  return w
}

/* ---------------- 单块加密 ---------------- */

// 状态按「列优先」排：state[行 + 4 * 列]
function encryptBlock(rk, input) {
  let s = new Uint8Array(16)
  for (let i = 0; i < 16; i++) s[i] = input[i] ^ rk[i]

  for (let round = 1; round <= 10; round++) {
    // SubBytes
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]]

    // ShiftRows：第 r 行左移 r 格
    const t = new Uint8Array(16)
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) t[r + 4 * c] = s[r + 4 * ((c + r) & 3)]
    }
    s = t

    // MixColumns（最后一轮不做）
    if (round !== 10) {
      for (let c = 0; c < 4; c++) {
        const i0 = 4 * c
        const a0 = s[i0]
        const a1 = s[i0 + 1]
        const a2 = s[i0 + 2]
        const a3 = s[i0 + 3]
        s[i0] = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3
        s[i0 + 1] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3
        s[i0 + 2] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3)
        s[i0 + 3] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2)
      }
    }

    // AddRoundKey
    const off = round * 16
    for (let i = 0; i < 16; i++) s[i] ^= rk[off + i]
  }
  return s
}

/* ---------------- 编码 ---------------- */

/** 字符串 → UTF-8 字节（CryptoJS 对字符串明文按 UTF-8 处理） */
function utf8Bytes(str) {
  const s = String(str == null ? '' : str)
  const out = []
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i)
    // 代理对：合成一个码点
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00)
        i++
      }
    }
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    else
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f)
      )
  }
  return new Uint8Array(out)
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    const has1 = i + 1 < bytes.length
    const has2 = i + 2 < bytes.length
    out += B64[b0 >> 2]
    out += B64[((b0 & 0x03) << 4) | ((has1 ? b1 : 0) >> 4)]
    out += has1 ? B64[((b1 & 0x0f) << 2) | ((has2 ? b2 : 0) >> 6)] : '='
    out += has2 ? B64[b2 & 0x3f] : '='
  }
  return out
}

/* ---------------- 对外 ---------------- */

/**
 * AES-128-ECB + PKCS7 + base64，等价于
 *   CryptoJS.AES.encrypt(plain, Utf8.parse(key), { mode: ECB, padding: Pkcs7 }).toString()
 */
function encryptEcb(plain, keyStr) {
  const key = utf8Bytes(keyStr)
  if (key.length !== 16) throw new Error('AES-128 需要 16 字节密钥，实际 ' + key.length)

  const data = utf8Bytes(plain)
  // PKCS7：明文正好 16 的整数倍时也要补满一整块
  const pad = 16 - (data.length % 16)
  const buf = new Uint8Array(data.length + pad)
  buf.set(data)
  for (let i = data.length; i < buf.length; i++) buf[i] = pad

  const rk = expandKey(key)
  const out = new Uint8Array(buf.length)
  for (let off = 0; off < buf.length; off += 16) {
    out.set(encryptBlock(rk, buf.subarray(off, off + 16)), off)
  }
  return base64(out)
}

module.exports = { encryptEcb, utf8Bytes, base64, SBOX }
