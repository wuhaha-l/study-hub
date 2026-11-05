/**
 * 层叠体检（离线静态检查）
 *   node test/layer.js
 *
 * 规矩一：别拿「position: fixed + z-index: 0」的整屏层当背景。
 *   按 CSS 层叠顺序，z-index: 0 的定位元素画在所有**未定位**的普通流元素之上，
 *   一层不透明的渐变会把下面的内容整片盖住。而 .head 有 z-index: 2、scroll-view
 *   自带 position: relative，它们反而浮在上面 —— 于是真机上出现「磁贴和筛选胶囊都在，
 *   课程卡和任务列表一片空白，控制台零报错」，浏览器预览却完全正常。
 *   首页就是这么栽的：.page-bg 盖住了今天课程、分组标题、任务卡和「新任务」按钮。
 *
 * 规矩二：背景挂在根容器上。首页 .page 必须有 background-image，
 *   否则删掉背景层之后页面就成了白板，属于「修一个坑挖另一个坑」。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'miniprogram')
const PAGES = path.join(ROOT, 'pages')

let pass = 0
let fail = 0

function ok(msg) {
  pass++
  console.log('  ✓ ' + msg)
}
function bad(msg, detail) {
  fail++
  console.log('  ✗ ' + msg)
  if (detail) String(detail).split('\n').forEach((l) => console.log('      ' + l))
}

/** 把 wxss 切成规则块：[{ selector, body, line }]（先剥掉注释，否则注释里的形容会被当成真样式） */
function rules(css) {
  const out = []
  // 注释换成等量换行，行号才不会跑偏
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(clean))) {
    const before = clean.slice(0, m.index)
    out.push({
      selector: m[1].trim().replace(/\s+/g, ' '),
      body: m[2],
      line: before.split('\n').length
    })
  }
  return out
}

function listFiles(dir, ext) {
  const out = []
  fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
    const p = path.join(dir, d.name)
    if (d.isDirectory()) out.push(...listFiles(p, ext))
    else if (p.endsWith(ext)) out.push(p)
  })
  return out
}

console.log('\n[1] 整屏背景层：不允许 position: fixed + z-index: 0')
listFiles(PAGES, '.wxss')
  .concat([path.join(ROOT, 'app.wxss')].filter(fs.existsSync))
  .forEach((file) => {
    const rel = path.relative(path.join(__dirname, '..'), file)
    const css = fs.readFileSync(file, 'utf8')
    rules(css).forEach((r) => {
      const b = r.body
      if (!/position\s*:\s*fixed/.test(b)) return
      // 只看「盖满整屏」的：有 z-index 且为 0（或显式 0），
      // 负值和 100+ 的弹层/遮罩都是正常用法
      const zi = b.match(/z-index\s*:\s*(-?\d+)/)
      if (!zi || Number(zi[1]) !== 0) return
      bad(
        rel + ':' + r.line + ' 「' + r.selector + '」是 fixed + z-index:0 的整屏层',
        '它会盖住所有未定位的内容。背景请挂在根容器上，别用独立整屏层。'
      )
    })
  })
if (!fail) ok('没有「fixed + z-index:0」的整屏层')

console.log('\n[2] 首页根容器：背景必须挂在自己身上')
{
  const wxss = fs.readFileSync(path.join(PAGES, 'index', 'index.wxss'), 'utf8')
  const wxml = fs.readFileSync(path.join(PAGES, 'index', 'index.wxml'), 'utf8')
  const pageRule = rules(wxss).find((r) => r.selector === '.page')
  if (!pageRule) bad('index.wxss 找不到 .page 根规则')
  else if (!/background-image\s*:/.test(pageRule.body)) bad('.page 没有 background-image，页面会变成白板')
  else ok('.page 自带渐变背景')

  const darkRule = rules(wxss).find((r) => r.selector === '.page.theme-dark' && /background-image/.test(r.body))
  if (!darkRule) bad('深色没有对应的 .page.theme-dark 背景规则')
  else ok('.page.theme-dark 自带深色渐变')

  if (/page-bg/.test(wxml)) bad('index.wxml 里还留着 page-bg 元素')
  else ok('index.wxml 没有多余的背景层元素')

  if (!/^<view class="page/.test(wxml.trim())) bad('index.wxml 根节点不是 .page')
  else ok('根节点是 .page')
}

console.log('\n[3] 弹层必须浮在内容之上')
{
  const wxss = fs.readFileSync(path.join(PAGES, 'index', 'index.wxss'), 'utf8')
  const layers = rules(wxss).filter((r) => /position\s*:\s*fixed/.test(r.body))
  if (!layers.length) bad('没有找到任何 fixed 弹层（长按菜单 / 遮罩去哪了）')
  layers.forEach((r) => {
    const zi = r.body.match(/z-index\s*:\s*(\d+)/)
    if (!zi) bad('「' + r.selector + '」fixed 但没有 z-index')
    else if (Number(zi[1]) < 100) bad('「' + r.selector + '」z-index 只有 ' + zi[1] + '，可能被内容盖住')
    else ok('「' + r.selector + '」z-index ' + zi[1])
  })
}

console.log('\n' + (fail ? '✗ ' + fail + ' 处问题' : '✓ 全部通过') + '（' + pass + ' 项）')
process.exit(fail ? 1 : 0)
