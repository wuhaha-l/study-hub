/**
 * WXML 条件链体检（离线静态检查）
 *   node test/wxml-chain.js
 *
 * 规矩：wx:elif / wx:else 必须紧跟同一个父节点下的另一个条件节点。
 * 中间只要夹了一条注释（哪怕只隔几行空白），WXML 会静默丢弃这条链 —— 不报错、不警告，
 * 那块界面就是不渲染。首页踩过一次：loading 的 wx:if 后面接了条注释再接 wx:elif，
 * 结果「今日课程 + 任务列表」整块从真机上消失，只剩筛选胶囊和一大片空白。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'miniprogram', 'pages')

/** 找每个 wx:elif / wx:else 所在的标签起点，再看它前面紧挨着的是不是注释结尾 */
function chainComments(src) {
  const hits = []
  const re = /<[a-zA-Z][\w-]*[^>]*?\swx:(elif|else)(\s*=|\s*\/?>)/g
  let m
  while ((m = re.exec(src))) {
    const at = m.index
    let i = at - 1
    while (i >= 0 && /\s/.test(src[i])) i--
    if (src.slice(Math.max(0, i - 2), i + 1) === '-->') {
      // 回退到这条注释的开头，方便在报错里指出是哪一段
      const begin = src.lastIndexOf('<!--', i)
      const text = src.slice(begin, i + 1).split('\n')[0].trim()
      const line = src.slice(0, at).split('\n').length
      hits.push({ line, text })
    }
  }
  return hits
}

let pass = 0
let fail = 0
function ok(name) {
  pass++
  console.log('  ✓ ' + name)
}
function bad(name, detail) {
  fail++
  console.log('  ✗ ' + name + '\n    ' + detail)
}

const files = []
;(function walk(dir) {
  fs.readdirSync(dir).forEach((f) => {
    const p = path.join(dir, f)
    if (fs.statSync(p).isDirectory()) walk(p)
    else if (f.endsWith('.wxml')) files.push(p)
  })
})(ROOT)

console.log('\n[条件链：wx:elif / wx:else 正前方不能是注释]')
files.forEach((file) => {
  const rel = path.relative(path.join(__dirname, '..'), file)
  const src = fs.readFileSync(file, 'utf8')
  const hits = chainComments(src)
  if (!hits.length) {
    ok(rel)
    return
  }
  hits.forEach((h) => bad(rel + ':' + h.line, '紧挨着 `' + h.text + '`，这条链会整条失效'))
})

console.log('\n[条件链：elif/else 不能多于 wx:if（粗查孤儿分支）]')
files.forEach((file) => {
  const rel = path.relative(path.join(__dirname, '..'), file)
  const src = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '')
  const ifs = (src.match(/wx:if\s*=/g) || []).length
  const branches =
    (src.match(/wx:elif\s*=/g) || []).length + (src.match(/wx:else(\s|\/?>)/g) || []).length
  if (branches > ifs) bad(rel, 'elif/else ' + branches + ' 个，wx:if 只有 ' + ifs + ' 个')
  else ok(rel + '（if ' + ifs + ' / 分支 ' + branches + '）')
})

console.log('\n' + (fail ? '✗ ' + fail + ' 处问题' : '✓ 全部通过') + '（' + pass + ' 项）')
process.exit(fail ? 1 : 0)
