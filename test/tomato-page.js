/**
 * 专注页：放弃后回到「准备专注」、圆环拖动调时长、待办必须选标签
 *   node test/tomato-page.js
 *
 * 把页面对象从 Page() 里捞出来，手搓一个最小实例（data + setData），
 * 直接调那几个方法 —— 这几个交互都靠「点完之后 data 变成什么」判断，
 * 不需要真跑小程序。
 */
const store = {}

global.wx = {
  getStorageSync: (k) => (store[k] === undefined ? '' : store[k]),
  setStorageSync: (k, v) => {
    store[k] = v
  },
  removeStorageSync: (k) => {
    delete store[k]
  },
  getStorageInfoSync: () => ({ keys: Object.keys(store) }),
  showModal: (o) => {
    modalCalls.push(o)
    if (o && typeof o.success === 'function') o.success({ confirm: modalConfirm, cancel: !modalConfirm })
  },
  showToast: (o) => toastCalls.push(o && o.title),
  showActionSheet: (o) => {
    if (o && typeof o.success === 'function') o.success({ tapIndex: 2 })
  },
  vibrateLong: () => null,
  vibrateShort: () => null
}

let modalCalls = []
let toastCalls = []
let modalConfirm = true

global.getApp = () => ({ globalData: { statusBarHeight: 20, navBarHeight: 44 } })

let captured = null
global.Page = (o) => {
  captured = o
}

const T = require('../miniprogram/utils/tomato')
const pagePath = require.resolve('../miniprogram/pages/tomato/tomato')
require(pagePath)

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)))
  }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), got)
}

/** 手搓一个页面实例：data 深拷一份，setData 合并后立刻回调 */
function makePage() {
  const p = Object.create(null)
  Object.keys(captured).forEach((k) => {
    p[k] = captured[k]
  })
  p.data = JSON.parse(JSON.stringify(captured.data))
  p.setData = function (patch, cb) {
    Object.keys(patch || {}).forEach((k) => {
      p.data[k] = patch[k]
    })
    if (typeof cb === 'function') cb()
  }
  return p
}

console.log('\n[放弃这一轮 → 直接回到「准备专注」]')
Object.keys(store).forEach((k) => delete store[k])
const p = makePage()
const run = T.startRun({ mode: 'focus', minutes: 40, taskId: 'k1', taskTitle: '背单词', tag: 'study', now: Date.now() })
T.saveRun(run)
p.setData({ run: run, hasRun: true, running: true, mode: 'focus', pickedMin: 40 })

modalConfirm = true
p.onSecondary()
eq('run 清掉了', p.data.run, null)
eq('hasRun 归 false（这就是之前卡在「继续/放弃」的原因）', p.data.hasRun, false)
eq('running 归 false', p.data.running, false)
eq('回到准备专注', p.data.mode, 'focus')
eq('文案回到「开始专注」', p.data.mainText, '开始专注')
eq('时长保留刚才那轮（40 分）', p.data.pickedMin, 40)
eq('时间显示 40:00', p.data.timeText, '40:00')
eq('本机不留计时器', T.loadRun(), null)
ok('没有记进统计', T.getSessions().length === 0)
eq('弹窗问过一次', modalCalls.length, 1)

// 放弃的是休息轮：一样回到「准备专注」
const brk = T.startRun({ mode: 'break', minutes: 5, now: Date.now() })
T.saveRun(brk)
p.setData({ run: brk, hasRun: true, running: true, mode: 'break', pickedMin: 5 })
modalCalls = []
p.onSecondary()
eq('休息放弃后也回专注态', p.data.mode, 'focus')
eq('文案是「准备专注」', p.data.modeText, '准备专注')

// 取消弹窗：什么都不动
const run2 = T.startRun({ mode: 'focus', minutes: 25, now: Date.now() })
T.saveRun(run2)
p.setData({ run: run2, hasRun: true, running: true })
modalCalls = []
modalConfirm = false
p.onSecondary()
eq('取消就还在计时', p.data.hasRun, true)
ok('计时器没被清', !!T.loadRun())
modalConfirm = true

console.log('\n[圆环拖动：0~59 分钟]')
Object.keys(store).forEach((k) => delete store[k])
const p2 = makePage()
p2._ringW = 200
p2.setData({ pickedMin: 25, pickedCustom: false, hasRun: false, mode: 'focus' })

p2.onRingStart({ touches: [{ clientX: 100 }] })
p2.onRingMove({ touches: [{ clientX: 200 }] }) // 右移半个圆环 = +29.5 分
eq('右拖半个圆环 → 25 + 29 ≈ 55', p2.data.pickedMin, 55)
eq('时间跟着变', p2.data.timeText, '55:00')

p2.onRingMove({ touches: [{ clientX: 900 }] })
eq('拖到底封顶 59', p2.data.pickedMin, 59)

p2.onRingStart({ touches: [{ clientX: 400 }] })
p2.onRingMove({ touches: [{ clientX: -400 }] })
eq('往左拖到底就是 0', p2.data.pickedMin, 0)
eq('0 分钟显示 00:00', p2.data.timeText, '00:00')
eq('0 分钟时按钮变成提示', p2.data.mainText, '先拖个时长')

// 0 分钟不许开跑
toastCalls = []
p2.onMain()
eq('0 分钟时点开始只会提示', toastCalls, ['往右拖一下圆环，先选时长'])
eq('没有开出一轮', p2.data.run, null)

// 拖到 7 分就能开
p2.setData({ pickedMin: 7 })
p2.onMain()
ok('7 分钟能开跑', !!p2.data.run)
eq('这一轮就是 7 分钟', Math.round(p2.data.run.totalMs / 60000), 7)
p2.onSecondary()

// 计时中拖圆环不接管（那时候它是进度条）
const p3 = makePage()
p3._ringW = 200
const run3 = T.startRun({ mode: 'focus', minutes: 25, now: Date.now() })
p3.setData({ run: run3, hasRun: true, running: true, pickedMin: 25 })
p3.onRingStart({ touches: [{ clientX: 10 }] })
p3.onRingMove({ touches: [{ clientX: 190 }] })
eq('计时中拖不动时长', p3.data.pickedMin, 25)
// 按在圈上（旋钮）的路径也一样不接管
p3.onRingStart({ touches: [{ clientX: 200, clientY: 295 }] })
p3.onRingMove({ touches: [{ clientX: 305, clientY: 400 }] })
eq('计时中按圈也拖不动', p3.data.pickedMin, 25)

console.log('\n[圆环旋钮：绕圆心转，顺时针 = 加时间]')
// 圆心 (200,400)、半径 105。按在圈上 → 旋钮；按在圆心附近 → 横滑条。
// 屏幕坐标 y 朝下，所以 0° 是 3 点、90° 是 6 点、180° 是 9 点、270° 是 12 点。
const C = { cx: 200, cy: 400, r: 105 }
const at = (deg) => {
  const a = (deg * Math.PI) / 180
  return { clientX: C.cx + Math.cos(a) * C.r, clientY: C.cy + Math.sin(a) * C.r }
}

const p5 = makePage()
p5._ringRect = C
p5.setData({ pickedMin: 0, hasRun: false, mode: 'focus' })
p5.onRingStart({ touches: [at(270)] }) // 按在正上方
p5.onRingMove({ touches: [at(0)] }) // 顺时针转到 3 点
eq('顺时针转 1/4 圈 ≈ 15 分', p5.data.pickedMin, 15)
p5.onRingMove({ touches: [at(90)] }) // 转到 6 点
eq('转半圈 ≈ 30 分', p5.data.pickedMin, 30)
p5.onRingMove({ touches: [at(180)] }) // 转到 9 点
eq('转 3/4 圈 ≈ 44 分', p5.data.pickedMin, 44)
p5.onRingMove({ touches: [at(270)] }) // 转回正上方 = 一整圈
eq('转满一圈 = 59 分', p5.data.pickedMin, 59)
eq('弧也跟着满', Math.round(p5.data.progress * 100) / 100, 0)

const p6 = makePage()
p6._ringRect = C
p6.setData({ pickedMin: 44, hasRun: false, mode: 'focus' })
p6.onRingStart({ touches: [at(270)] })
p6.onRingMove({ touches: [at(180)] }) // 逆时针 1/4 圈
eq('逆时针转 1/4 圈 ≈ 44 - 15', p6.data.pickedMin, 29)
p6.onRingMove({ touches: [at(90)] })
eq('继续逆时针到半圈 ≈ 44 - 30', p6.data.pickedMin, 15)
p6.onRingMove({ touches: [at(0)] })
eq('逆时针转过 3/4 圈就到 0（不会变负）', p6.data.pickedMin, 0)

// 手指经过正下方（atan2 在 ±180° 处会跳符号）时不能当成往回转
const p7 = makePage()
p7._ringRect = C
p7.setData({ pickedMin: 40, hasRun: false, mode: 'focus' })
p7.onRingStart({ touches: [at(175)] })
p7.onRingMove({ touches: [at(185)] })
eq('跨过正下方只多 2 分，不跳到底', p7.data.pickedMin, 42)

// 圆心附近按下 = 横滑条（手指离圆心太近时角度本来就乱跳）
const p8 = makePage()
p8._ringRect = C
p8._ringW = 210
p8.setData({ pickedMin: 10, hasRun: false, mode: 'focus' })
p8.onRingStart({ touches: [{ clientX: 200, clientY: 400 }] })
p8.onRingMove({ touches: [{ clientX: 300, clientY: 400 }] })
eq('圆心横拖仍然是「右 = 加」', p8.data.pickedMin, 38)

console.log('\n[待办：每条都要一个标签]')
Object.keys(store).forEach((k) => delete store[k])
const p4 = makePage()
p4.reload()
p4.setData({ addShow: true, addTitle: '跑步 30 分钟', addTag: '' })

toastCalls = []
p4.onAddTask()
eq('没选标签不许加', toastCalls, ['先选一个标签'])
eq('确实没加进去', p4.data.tasks.length, 0)

p4.onAddTag({ currentTarget: { dataset: { k: 'life' } } })
eq('选中生活', p4.data.addTag, 'life')
p4.onAddTask()
eq('加进去了', p4.data.tasks.length, 1)
eq('标签落库', p4.data.tasks[0].tag, 'life')
eq('列表上带文案', p4.data.tasks[0].tagText, '生活')
eq('加完清空输入和标签', [p4.data.addTitle, p4.data.addTag, p4.data.addShow], ['', '', false])

// 再点一次同一个标签 = 取消选中
p4.setData({ addShow: true })
p4.onAddTag({ currentTarget: { dataset: { k: 'life' } } })
eq('先选上', p4.data.addTag, 'life')
p4.onAddTag({ currentTarget: { dataset: { k: 'life' } } })
eq('再点一次取消', p4.data.addTag, '')
p4.onAddTag({ currentTarget: { dataset: { k: 'rest' } } })
p4.onAddTask()

// 点标签胶囊改标签（actionSheet 第 3 项 = 生活）
const first = p4.data.tasks[0]
p4.onTaskTag({ currentTarget: { dataset: { id: first.id } } })
eq('点胶囊改成生活', T.getTasks().filter((t) => t.id === first.id)[0].tag, 'life')

// 选中待办后开始专注：这一轮带上它的标签
p4.setData({ hasRun: false, run: null, pickedMin: 25 })
const lifeTask = p4.data.tasks.filter((t) => t.tag === 'life')[0]
p4.onPickTask({ currentTarget: { dataset: { id: lifeTask.id } } })
eq('选中待办带上标签', p4.data.taskTag, 'life')
eq('这一轮记成生活', p4.data.run.tag, 'life')
p4.onSecondary()

console.log('\n[统计面板：学习 / 休息 / 生活]')
eq('三个口径', p4.data.learn.kinds.map((x) => x.t), ['学习', '休息', '生活'])
eq('默认看学习', p4.data.learn.metric, 'study')
eq('标题', p4.data.learn.title, '学习时长')
p4.onMetric({ currentTarget: { dataset: { k: 'life' } } })
eq('切到生活', p4.data.learn.title, '生活时长')
eq('生活空的时候有引导语', p4.data.learn.foot, '给待办打上「生活」标签，开始专注就会长出来')
eq('空数据不出关键词块', p4.data.learn.kws.length, 0)

// 造一条生活记录，再看面板
T.addSession({ title: '跑步 30 分钟', tag: 'life', mode: 'focus', sec: 130, at: Date.now() })
p4.reload(true)
eq('生活时长 2 分 10 秒', p4.data.learn.totalTxt, '2 分 10 秒')
eq('关键词分组出来了', p4.data.learn.kws.length, 1)
eq('关键词就是待办里的词', p4.data.learn.kws[0].kw, '跑步')
eq('显示到秒', p4.data.learn.kws[0].txt, '2 分 10 秒')

console.log('\n----------------------------------------')
console.log((fail ? '✗ ' : '✓ ') + '通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail ? 1 : 0)
