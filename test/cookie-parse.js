/**
 * Cookie 清洗逻辑测试
 * 运行： node test/cookie-parse.js
 */
const { normalizeCookie, checkCookie } = require('../miniprogram/utils/cookie')

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + (extra ? '  → ' + extra : ''))
  }
}

/* 1. DevTools Application 表格（制表符分隔，用户实际复制的那种） */
console.log('\n[表格格式]')
const tsv = `fid\t1257\t.chaoxing.com\t/\t2026-11-20T08:03:08.669Z\t7
cx_p_token\t2cab84126f8b6f6cf9b95fb6024260e9\t.chaoxing.com\t/\t2026-10-28T19:03:08.670Z\t42
_uid\t410991477\t.chaoxing.com\t/\t2026-10-28T19:03:08.669Z\t13
_d\t1792569793426\t.chaoxing.com\t/\t2026-10-28T19:03:08.669Z\t15
UID\t410991477\t.chaoxing.com\t/\t2026-10-28T19:03:08.669Z\t12
DSSTASH_LOG\tC_38-UN_115-US_410991477-T_1792569793427\t.chaoxing.com\t/\t2026-10-28T19:03:08.670Z\t51`

const r1 = normalizeCookie(tsv)
check('提取条数正确', r1.count === 6, 'count=' + r1.count)
check('格式为标准 k=v', r1.cookie.indexOf('fid=1257; ') === 0, r1.cookie.slice(0, 40))
check('不含制表符', r1.cookie.indexOf('\t') === -1)
check('不含域名信息', r1.cookie.indexOf('.chaoxing.com') === -1)
check('有提示', r1.notes.length > 0)

/* 2. 普通 Cookie 串原样保留 */
console.log('\n[普通格式]')
const plain = '_uid=410991477; _d=1792569793426; uf=abcdef123456'
const r2 = normalizeCookie(plain)
check('条数 3', r2.count === 3, 'count=' + r2.count)
check('内容不变', r2.cookie === plain, r2.cookie)

/* 3. 带 Cookie: 前缀 */
console.log('\n[带前缀]')
const r3 = normalizeCookie('Cookie: _uid=1; _d=2; uf=3')
check('去掉前缀', r3.cookie.indexOf('Cookie:') === -1, r3.cookie)
check('条数 3', r3.count === 3)

/* 4. cURL 命令 */
console.log('\n[cURL]')
const curl = `curl 'https://i.chaoxing.com/base?ws=1&t=179' -H 'accept: text/html' -H 'cookie: _uid=410991477; _d=1792569793426; uf=b2d2c93b' --compressed`
const r4 = normalizeCookie(curl)
check('从中提取 cookie', r4.cookie === '_uid=410991477; _d=1792569793426; uf=b2d2c93b', r4.cookie)
check('条数 3', r4.count === 3)

/* 5. 脏数据处理 */
console.log('\n[脏数据]')
const r5 = normalizeCookie('  _uid=1 ;;  _d=2;  ; uf=3  ;  ')
check('清理多余分号', r5.cookie === '_uid=1; _d=2; uf=3', r5.cookie)
check('条数 3', r5.count === 3)

/* 6. 换行拼接的 cookie */
console.log('\n[换行格式]')
const multiline = `_uid=410991477;
_d=1792569793426;
uf=abc`
const r6 = normalizeCookie(multiline)
check('合并成一行', r6.cookie.indexOf('\n') === -1, JSON.stringify(r6.cookie))
check('条数 3', r6.count === 3, 'count=' + r6.count)

/* 7. 完整性检查 */
console.log('\n[完整性检查]')
const c1 = checkCookie('_uid=1; _d=2; uf=3; fid=1257')
check('学习通凭证齐全', c1.chaoxingReady === true)
const c2 = checkCookie('fid=1257; _uid=1; _d=2')
check('缺 uf 能识别', c2.chaoxingReady === false && c2.hasUf === false)

console.log('\n----------------------------------------')
console.log(`通过 ${pass}  失败 ${fail}`)
process.exit(fail ? 1 : 0)
