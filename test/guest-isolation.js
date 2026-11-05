/**
 * 数据隔离自检：同一个微信换身份，两边的数据不能串。
 *
 * 跑法：node test/guest-isolation.js
 *
 * 背景（这是个真出过的 bug）：小程序只有一个 openid。同一个微信先登学校账号、
 * 再切到访客，openid 一模一样 —— 只按 openid 查库，访客会把学校账号同步下来的
 * 任务、绑定的账号照单全收。用户看到的现像就是「游客登进去，学校的数据全在」。
 *
 * 修法是引入「数据归属键」（users.ownerOf）：
 *   学校账号 → 裸 openid（存量数据就是它，不用迁）
 *   访客/已退出 → 'g::' + openid
 *
 * 这个文件就是钉住这三件事：
 *   1. 归属键怎么算（含 anonymous）
 *   2. 同一 openid 下，学校那份和访客那份互不可见
 *   3. 老数据（裸 openid 存的）学校账号仍然读得到
 */
const path = require('path')
const ROOT = path.join(__dirname, '..')

/* ------------------------------------------------------------------ */
/* 假数据库（和云开发行为一致：支持 where 多字段 / doc / add / remove） */
/* ------------------------------------------------------------------ */
const cloud = require(path.join(ROOT, 'cloudfunctions', 'studyHub', 'node_modules', 'wx-server-sdk'))

const cols = {}
let seq = 0
function rows(name) {
  if (!cols[name]) cols[name] = []
  return cols[name]
}
function makeQuery(name, filter) {
  const q = {
    where(f) {
      return makeQuery(name, f)
    },
    limit() {
      return q
    },
    skip() {
      return q
    },
    async get() {
      let list = rows(name).slice()
      if (filter && Object.keys(filter).length) {
        list = list.filter((r) => Object.keys(filter).every((k) => r[k] === filter[k]))
      }
      return { data: list }
    },
    async add({ data }) {
      const _id = name + '_' + ++seq
      rows(name).push(Object.assign({ _id }, data))
      return { _id }
    },
    doc(id) {
      return {
        async get() {
          const row = rows(name).find((r) => r._id === id)
          if (!row) throw new Error('document not exist')
          return { data: row }
        },
        async update({ data }) {
          const row = rows(name).find((r) => r._id === id)
          if (row) Object.assign(row, data)
          return { stats: { updated: row ? 1 : 0 } }
        },
        async remove() {
          const i = rows(name).findIndex((r) => r._id === id)
          if (i > -1) rows(name).splice(i, 1)
          return { stats: { removed: i > -1 ? 1 : 0 } }
        }
      }
    }
  }
  return q
}

const fakeDb = {
  collection(name) {
    return makeQuery(name, null)
  }
}
cloud.database = () => fakeDb

const users = require(path.join(ROOT, 'cloudfunctions', 'studyHub', 'lib', 'users'))
const store = require(path.join(ROOT, 'cloudfunctions', 'studyHub', 'lib', 'store'))

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''))
  }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected })
}

const WX = 'wx_same_phone' // 同一个微信，两种身份共用这一个 openid

;(async () => {
  /* ---------------- 1. 归属键规则 ---------------- */
  console.log('\n[归属键 ownerOf]')
  eq('学校账号用裸 openid', users.ownerOf(WX, 'school'), WX)
  eq('访客加 g:: 前缀', users.ownerOf(WX, 'guest'), 'g::' + WX)
  eq('已退出的访客也落在访客那边', users.ownerOf(WX, 'anonymous'), 'g::' + WX)
  eq('两种身份算出来的键不同', users.ownerOf(WX, 'school') === users.ownerOf(WX, 'guest'), false)
  eq('认得访客键', users.isGuestOwner('g::' + WX), true)
  eq('学校键不是访客键', users.isGuestOwner(WX), false)
  eq('反推真 openid（访客）', users.openidOfOwner('g::' + WX), WX)
  eq('反推真 openid（学校）', users.openidOfOwner(WX), WX)

  /* ---------------- 2. 学校账号先登录，产生数据 ---------------- */
  console.log('\n[学校账号那侧：先有存量数据]')
  // 模拟「老数据」—— 直接按裸 openid 写，和线上存量记录一模一样
  const schoolOwner = users.ownerOf(WX, 'school')
  await store.replacePlatformTasks(schoolOwner, 'chaoxing', [
    { externalId: 'cx-1', title: '汇编语言作业', deadline: Date.now() + 86400000 },
    { externalId: 'cx-2', title: '数据结构实验', deadline: Date.now() + 172800000 }
  ])
  await store.bumpReminder(schoolOwner, 5)
  const schoolTasks = await store.listTasks(schoolOwner)
  eq('学校侧有 2 条任务', schoolTasks.length, 2)
  eq('学校侧提醒额度 5', (await store.getReminder(schoolOwner)).remaining, 5)

  /* ---------------- 3. 同一个微信切成访客 ---------------- */
  console.log('\n[同一微信切访客：看不到学校数据]')
  const guestOwner = users.ownerOf(WX, 'guest')
  eq('访客侧任务为空', (await store.listTasks(guestOwner)).length, 0)
  eq('访客侧没有提醒额度记录', await store.getReminder(guestOwner), null)
  eq('访客侧没有平台账号', (await store.listAccounts(guestOwner)).length, 0)

  // 访客自己建一条待办，只能自己看到
  const gid = await store.saveCustomTask(guestOwner, { title: '买牛奶' })
  eq('访客能看到自己建的', (await store.listTasks(guestOwner)).map((t) => t.title), ['买牛奶'])
  eq('学校侧看不到访客那条', (await store.listTasks(schoolOwner)).length, 2)
  ok(
    '学校侧拿不到访客的任务 id',
    !(await store.listTasks(schoolOwner)).some((t) => t._id === gid)
  )

  // 访客动不了学校的任务（按 id 直取也要拦住）
  await store
    .toggleTask(guestOwner, schoolTasks[0]._id, true)
    .then(() => ok('访客改不了学校的任务（应该抛错）', false))
    .catch((e) => ok('访客改不了学校的任务（' + e.message + '）', /不存在/.test(e.message)))
  await store
    .deleteTask(guestOwner, schoolTasks[0]._id)
    .then(() => ok('访客删不了学校的任务（应该抛错）', false))
    .catch((e) => ok('访客删不了学校的任务（' + e.message + '）', /不存在/.test(e.message)))

  /* ---------------- 4. 访客退出（anonymous） ---------------- */
  console.log('\n[访客退出：仍然看不到学校数据]')
  await users.register({
    openid: WX,
    phone: '13600136000',
    password: 'abc123',
    nickname: '小访'
  })
  eq('注册后角色是访客', await users.roleOf(WX), 'guest')
  await users.logout(WX)
  eq('退出后角色是 anonymous', await users.roleOf(WX), 'anonymous')
  const anonOwner = users.ownerOf(WX, await users.roleOf(WX))
  eq('anonymous 的归属键还是访客那个', anonOwner, 'g::' + WX)
  eq('退出后只看到自己的待办', (await store.listTasks(anonOwner)).map((t) => t.title), ['买牛奶'])
  eq('退出后依然看不到学校的 2 条', (await store.listTasks(schoolOwner)).length, 2)

  // 重新登录回来，数据还在
  await users.login({ openid: WX, phone: '13600136000', password: 'abc123' })
  eq('重新登录回到 guest', await users.roleOf(WX), 'guest')
  eq('登录后自己的待办还在', (await store.listTasks(guestOwner)).map((t) => t.title), ['买牛奶'])

  /* ---------------- 5. 换成学校账号 ---------------- */
  console.log('\n[切回学校账号：回到自己那份]')
  await users.logout(WX)
  await users.markSchool({ openid: WX, username: '202515020339' })
  eq('升级成 school', await users.roleOf(WX), 'school')
  const back = users.ownerOf(WX, 'school')
  eq('看到的是学校那 2 条', (await store.listTasks(back)).length, 2)
  eq('学校的提醒额度还在', (await store.getReminder(back)).remaining, 5)
  eq('访客那条没跟过来', (await store.listTasks(back)).some((t) => t.title === '买牛奶'), false)

  // 老数据兼容：存量记录就是裸 openid 存的，上面 2 条正是这么写的
  ok('存量数据不用迁移（裸 openid 直接读得到）', (await store.listTasks(WX)).length === 2)

  /* ---------------- 6. 定时任务能覆盖到访客 ---------------- */
  console.log('\n[定时任务的遍历范围]')
  const owners = await store.listOwners()
  ok('学校账号在列表里', owners.indexOf(WX) > -1, owners)
  // 访客没有平台账号，只从 accounts 收集的话他永远收不到提醒 —— 所以还要看 reminders
  await store.bumpReminder(guestOwner, 1)
  const owners2 = await store.listOwners()
  ok('访客（订阅过提醒）也能被遍历到', owners2.indexOf('g::' + WX) > -1, owners2)
  eq('两个身份各占一个键，不会混', owners2.length, 2)

  /* ---------------- 6.5 换微信登录：数据跟着手机号走 ---------------- */
  console.log('\n[换微信登录：数据跟着手机号走]')
  const otherKey = users.ownerOf('wx_another_phone', 'guest')
  const mv = await store.moveOwner(guestOwner, otherKey)
  eq('搬了任务 + 提醒额度两条', mv.moved, 2)
  eq('旧键清空了', (await store.listTasks(guestOwner)).length, 0)
  eq('新键拿到了待办', (await store.listTasks(otherKey)).map((t) => t.title), ['买牛奶'])
  eq('新键拿到了提醒额度', (await store.getReminder(otherKey)).remaining, 1)
  eq('学校那份没被牵连', (await store.listTasks(schoolOwner)).length, 2)

  /* ---------------- 7. 本机数据（课表 / 便签 / 番茄） ---------------- */
  console.log('\n[本机数据：访客也读不到学校那份]')
  const mem = {}
  global.wx = {
    getStorageSync(k) {
      return Object.prototype.hasOwnProperty.call(mem, k) ? JSON.parse(JSON.stringify(mem[k])) : ''
    },
    setStorageSync(k, v) {
      mem[k] = JSON.parse(JSON.stringify(v))
    },
    removeStorageSync(k) {
      delete mem[k]
    },
    getStorageInfoSync() {
      return { keys: Object.keys(mem) }
    }
  }
  const AUTH = require(path.join(ROOT, 'miniprogram', 'utils', 'auth'))
  const SCOPE = require(path.join(ROOT, 'miniprogram', 'utils', 'scope'))
  const Notes = require(path.join(ROOT, 'miniprogram', 'utils', 'notes'))

  // 学校账号：键名保持原样（存量数据不用迁）
  AUTH.save({ role: 'school', username: '202515020339' })
  eq('学校态键名不变', SCOPE.key('notes_v1'), 'notes_v1')
  Notes.save({ title: '学校账号的笔记', body: '只有本校能看到' })
  eq('学校态有 1 条便签', Notes.list().length, 1)

  // 切成访客：同一台手机，另一个命名空间
  AUTH.save({ role: 'guest', phone: '136****8000' })
  eq('访客态加 g:: 前缀', SCOPE.key('notes_v1'), 'g::notes_v1')
  eq('访客看不到学校的便签', Notes.list().length, 0)
  eq('学校那份还在（没被删）', (mem['notes_v1'] || []).length, 1)
  Notes.save({ title: '访客自己的笔记', body: '只属于这个手机号' })
  eq('访客看到的是自己的', Notes.list().map((n) => n.title), ['访客自己的笔记'])
  eq('学校那份没被污染', (mem['notes_v1'] || []).map((n) => n.title), ['学校账号的笔记'])

  // 退出登录（anonymous）：仍然落在访客那边，不会串到学校
  AUTH.save({ role: 'anonymous' })
  eq('已退出的仍加前缀', SCOPE.key('notes_v1'), 'g::notes_v1')
  eq('已退出的看到访客那份', Notes.list().map((n) => n.title), ['访客自己的笔记'])
  eq('isGuest 认 anonymous', AUTH.isGuest(), true)
  eq('标签显示未登录', AUTH.label(), '未登录')

  // 切回学校
  AUTH.save({ role: 'school' })
  eq('切回学校看到学校那份', Notes.list().map((n) => n.title), ['学校账号的笔记'])

  console.log('\n----------------------------------------')
  console.log('通过 ' + pass + '  失败 ' + fail)
  process.exit(fail ? 1 : 0)
})().catch((e) => {
  console.error('测试崩了：', e)
  process.exit(1)
})
