/**
 * 用假的 wx-server-sdk 数据库验证 store.js 的调用链。
 * 主要目的是防止再出现 "db.collection is not a function" 这类惰性句柄写错的问题。
 * 运行： node test/store-mock.js
 */
// 依赖装在云函数目录下，测试从那里取（和 store.js 里解析到的是同一个模块实例）
const cloud = require('../cloudfunctions/studyHub/node_modules/wx-server-sdk')

// ---- 用内存对象模拟云数据库 ----
const store = { accounts: [], tasks: [], reminders: [] }

function makeQuery(name, filter) {
  const q = {
    where(f) {
      return makeQuery(name, f)
    },
    skip() {
      return q
    },
    limit() {
      return q
    },
    async get() {
      let rows = store[name].slice()
      if (filter) {
        rows = rows.filter((r) => Object.keys(filter).every((k) => r[k] === filter[k]))
      }
      return { data: rows }
    },
    async add({ data }) {
      const _id = name + '_' + (store[name].length + 1)
      store[name].push(Object.assign({ _id }, data))
      return { _id }
    },
    doc(id) {
      return {
        async get() {
          const row = store[name].find((r) => r._id === id)
          if (!row) throw new Error('not found')
          return { data: row }
        },
        async update({ data }) {
          const row = store[name].find((r) => r._id === id)
          if (row) Object.assign(row, data)
          return {}
        },
        async remove() {
          store[name] = store[name].filter((r) => r._id !== id)
          return {}
        }
      }
    }
  }
  return q
}

cloud.database = function () {
  return {
    collection(name) {
      return makeQuery(name, null)
    }
  }
}

const s = require('../cloudfunctions/studyHub/lib/store')

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

;(async () => {
  const openid = 'test-openid'

  console.log('\n[账号 CRUD]')
  const id = await s.upsertAccount(openid, {
    platform: 'chaoxing',
    mode: 'cookie',
    username: 'test',
    maskedUser: 'te***st',
    secret: 'enc',
    status: 'ok'
  })
  check('写入账号', !!id, id)

  const list = await s.listAccounts(openid)
  check('读到账号', list.length === 1)
  check('字段正确', list[0].platform === 'chaoxing')

  await s.updateAccount(id, { status: 'invalid', lastError: 'cookie expired' })
  const after = await s.listAccounts(openid)
  check('更新账号', after[0].status === 'invalid')

  console.log('\n[任务写入与替换]')
  const n1 = await s.replacePlatformTasks(openid, 'chaoxing', [
    { externalId: 'a', courseName: '高数', title: '作业1', taskType: 'homework', status: 'todo' },
    { externalId: 'b', courseName: '高数', title: '作业2', taskType: 'homework', status: 'done' }
  ])
  check('写入任务', n1 === 2, 'n=' + n1)

  const tasks = await s.listTasks(openid)
  check('读到任务', tasks.length === 2)
  check('已完成状态保留', tasks.some((t) => t.status === 'done'))

  // 再同步一次，作业1 被手动标记完成，应该保留
  const manual = tasks.find((t) => t.externalId === 'a')
  await s.toggleTask(openid, manual._id, true)
  const n2 = await s.replacePlatformTasks(openid, 'chaoxing', [
    { externalId: 'a', courseName: '高数', title: '作业1', taskType: 'homework', status: 'todo' }
  ])
  check('替换式同步', n2 === 1, 'n=' + n2)
  const tasks2 = await s.listTasks(openid)
  check('手动勾选的完成状态被保留', tasks2[0].status === 'done', tasks2[0].status)

  console.log('\n[提醒额度]')
  await s.bumpReminder(openid, 1)
  await s.bumpReminder(openid, 1)
  const rem = await s.getReminder(openid)
  check('累加额度', rem.remaining === 2, 'remaining=' + rem.remaining)
  await s.bumpReminder(openid, -1)
  const rem2 = await s.getReminder(openid)
  check('扣减额度', rem2.remaining === 1, 'remaining=' + rem2.remaining)

  console.log('\n[自定义任务与定时提醒]')
  const REMIND_TS = 1792900000000
  const cid = await s.saveCustomTask(openid, {
    title: '交物理实验报告',
    courseName: '大学物理实验',
    deadline: REMIND_TS + 86400000,
    remindAt: REMIND_TS
  })
  check('新建自定义任务', !!cid, cid)
  const ct = (await s.listTasks(openid)).find((t) => t.platform === 'custom')
  check('platform=custom', !!ct)
  check('提醒时间入库', ct && ct.remindAt === REMIND_TS)

  // 到点挑选：只挑「到点 + 没发过 + 未完成 + 没超过一天」的
  const due = s.dueReminders(
    [
      { _id: 'a', remindAt: REMIND_TS, remindedAt: 0, status: 'todo' },
      { _id: 'b', remindAt: REMIND_TS, remindedAt: 1, status: 'todo' },
      { _id: 'c', remindAt: REMIND_TS + 7200000, remindedAt: 0, status: 'todo' },
      { _id: 'd', remindAt: REMIND_TS - 2 * 86400000, remindedAt: 0, status: 'todo' },
      { _id: 'e', remindAt: REMIND_TS, remindedAt: 0, status: 'done' }
    ],
    REMIND_TS + 3600000
  )
  check('只挑到点未提醒的', due.length === 1 && due[0]._id === 'a', JSON.stringify(due.map((x) => x._id)))
  check('没设提醒的不挑', s.dueReminders([{ _id: 'f' }], Date.now()).length === 0)

  await s.setTaskReminder(openid, ct._id, REMIND_TS + 3600000)
  const ct2 = (await s.listTasks(openid)).find((t) => t.platform === 'custom')
  check('改提醒时间', ct2 && ct2.remindAt === REMIND_TS + 3600000)

  await s.saveCustomTask(openid, {
    id: ct._id,
    title: '交物理实验报告（改）',
    courseName: '大学物理实验',
    deadline: REMIND_TS + 86400000,
    remindAt: 0
  })
  const ct3 = (await s.listTasks(openid)).find((t) => t.platform === 'custom')
  check('编辑生效（含关提醒）', ct3 && ct3.title === '交物理实验报告（改）' && ct3.remindAt === 0)

  let guardErr = null
  await s.saveCustomTask(openid, { id: tasks2[0]._id, title: 'x' }).catch((e) => (guardErr = e))
  check('平台任务不能当自定义编辑', guardErr && /只能编辑/.test(guardErr.message))

  let emptyErr = null
  await s.saveCustomTask(openid, { title: '  ' }).catch((e) => (emptyErr = e))
  check('空标题拒绝', emptyErr && /不能为空/.test(emptyErr.message))

  await s.deleteTask(openid, ct._id)
  check('删除自定义任务', !(await s.listTasks(openid)).some((t) => t.platform === 'custom'))

  await s.markReminded(tasks2[0]._id)
  const mt = (await s.listTasks(openid)).find((t) => t._id === tasks2[0]._id)
  check('标记已提醒', mt && mt.remindedAt > 0)

  console.log('\n[用户去重]')
  const ids = await s.listOpenids()
  check('listOpenids 去重', ids.length === 1, JSON.stringify(ids))

  console.log('\n[解绑]')
  await s.removeAccount(openid, id)
  const left = await s.listTasks(openid)
  check('解绑后任务被清空', left.length === 0, 'left=' + left.length)

  console.log('\n----------------------------------------')
  console.log(`通过 ${pass}  失败 ${fail}`)
  process.exit(fail ? 1 : 0)
})().catch((e) => {
  console.log('\n✗ 测试异常：' + e.message)
  console.log(e.stack)
  process.exit(1)
})
