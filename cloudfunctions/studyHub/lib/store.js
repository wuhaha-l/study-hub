/**
 * 数据存储层。
 *
 * 注意第一参数为什么叫 owner 而不是 openid：这里所有的隔离键都是
 * `users.ownerOf(openid, role)` 算出来的「数据归属键」，学校账号等于裸 openid、
 * 访客等于 'g::' + openid。字段名仍叫 `openid`（存量数据就是它），但**传进来的
 * 值必须是归属键**，直接塞裸 openid 会让访客看到学校账号的任务。
 */
const cloud = require('wx-server-sdk')

/**
 * 懒加载数据库句柄。
 * 不能在模块顶层直接 cloud.database()——那时 cloud.init() 可能还没执行，
 * 会抛 "Cloud API isn't enabled"，导致整个云函数进程启动即崩溃（-504002）。
 */
let _db = null
function db() {
  if (!_db) _db = cloud.database()
  return _db
}

const ACCOUNTS = 'accounts'
const TASKS = 'tasks'
const REMINDERS = 'reminders'
const PAGE = 100

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

async function queryAll(col, where) {
  const hasWhere = where && Object.keys(where).length > 0
  const out = []
  let skip = 0
  for (;;) {
    const q = hasWhere ? db().collection(col).where(where) : db().collection(col)
    const res = await q.skip(skip).limit(PAGE).get()
    const data = res.data || []
    out.push.apply(out, data)
    if (data.length < PAGE) break
    skip += PAGE
    if (skip > 3000) break
  }
  return out
}

/* ---------------- 账号 ---------------- */

async function listAccounts(owner) {
  return queryAll(ACCOUNTS, { openid: owner })
}

async function findAccount(owner, platform) {
  const res = await db().collection(ACCOUNTS).where({ openid: owner, platform }).limit(1).get()
  return (res.data && res.data[0]) || null
}

async function getAccountById(owner, id) {
  try {
    const res = await db().collection(ACCOUNTS).doc(id).get()
    const doc = res.data
    if (!doc || doc.openid !== owner) return null
    return doc
  } catch (e) {
    return null
  }
}

async function upsertAccount(owner, payload) {
  const now = Date.now()
  const exist = await findAccount(owner, payload.platform)
  if (exist) {
    await db()
      .collection(ACCOUNTS)
      .doc(exist._id)
      .update({ data: Object.assign({}, payload, { updatedAt: now }) })
    return exist._id
  }
  const res = await db()
    .collection(ACCOUNTS)
    .add({ data: Object.assign({ openid: owner, createdAt: now, updatedAt: now }, payload) })
  return res._id
}

async function updateAccount(id, data) {
  await db()
    .collection(ACCOUNTS)
    .doc(id)
    .update({ data: Object.assign({}, data, { updatedAt: Date.now() }) })
}

async function removeAccount(owner, id) {
  const doc = await getAccountById(owner, id)
  if (!doc) throw new Error('账号不存在或无权操作')
  await db().collection(ACCOUNTS).doc(id).remove()
  // 连带清掉该平台的任务
  const olds = await queryAll(TASKS, { openid: owner, platform: doc.platform })
  for (const part of chunk(olds.map((t) => t._id), 20)) {
    await Promise.all(
      part.map((tid) =>
        db()
          .collection(TASKS)
          .doc(tid)
          .remove()
          .catch(() => null)
      )
    )
  }
  return true
}

/* ---------------- 任务 ---------------- */

async function listTasks(owner) {
  const tasks = await queryAll(TASKS, { openid: owner })
  return tasks.sort((a, b) => {
    if (a.deadline && b.deadline) return a.deadline - b.deadline
    if (a.deadline) return -1
    if (b.deadline) return 1
    return 0
  })
}

/**
 * 用最新抓取结果替换某平台的任务，同时保留用户手动勾选的状态。
 */
async function replacePlatformTasks(owner, platform, tasks) {
  const olds = await queryAll(TASKS, { openid: owner, platform })
  const manualDone = new Set(
    olds.filter((t) => t.manualDone || t.status === 'done').map((t) => t.externalId)
  )

  for (const part of chunk(olds.map((t) => t._id), 20)) {
    await Promise.all(
      part.map((id) =>
        db()
          .collection(TASKS)
          .doc(id)
          .remove()
          .catch(() => null)
      )
    )
  }

  const now = Date.now()
  const docs = tasks.map((t) => {
    const isDone = t.status === 'done' || manualDone.has(t.externalId)
    return {
      openid: owner,
      platform,
      externalId: t.externalId,
      courseId: t.courseId || '',
      courseName: t.courseName || '',
      title: t.title || '',
      taskType: t.taskType || 'other',
      deadline: t.deadline || 0,
      progress: t.progress || null,
      status: isDone ? 'done' : 'todo',
      manualDone: isDone && t.status !== 'done' ? true : false,
      url: t.url || '',
      // 老师标记的必做任务（U校园规则课的星号/Test）：首页标题标红
      required: t.required === true,
      // 选做（老师没标星的）：首页归「不用做」分组，不和必做混在一起
      optional: t.optional === true,
      // 学期：首页默认只显示本学期，这些字段决定一条任务归哪学期
      semesterKey: t.semesterKey || '',
      semesterLabel: t.semesterLabel || '',
      semesterShort: t.semesterShort || '',
      semesterRank: Number(t.semesterRank) || 0,
      updatedAt: now
    }
  })

  let inserted = 0
  for (const part of chunk(docs, 10)) {
    await Promise.all(
      part.map((data) =>
        db()
          .collection(TASKS)
          .add({ data })
          .then(() => {
            inserted++
          })
          .catch(() => null)
      )
    )
  }
  return inserted
}

async function toggleTask(owner, taskId, done) {
  const res = await db().collection(TASKS).doc(taskId).get().catch(() => null)
  const doc = res && res.data
  if (!doc || doc.openid !== owner) throw new Error('任务不存在')
  await db()
    .collection(TASKS)
    .doc(taskId)
    .update({ data: { status: done ? 'done' : 'todo', manualDone: !!done, updatedAt: Date.now() } })
  return true
}

/* ---------------- 自定义任务（用户手输的待办） ---------------- */

/** 新建 / 编辑自定义任务。带 id 为编辑（只能改自己的自定义任务），否则新建 */
async function saveCustomTask(owner, t) {
  const now = Date.now()
  const title = String((t && t.title) || '').trim()
  if (!title) throw new Error('任务名不能为空')
  const data = {
    courseName: String((t && t.courseName) || '').trim(),
    deadline: Number(t && t.deadline) || 0,
    remindAt: Number(t && t.remindAt) || 0,
    updatedAt: now
  }
  if (t && t.id) {
    const res = await db().collection(TASKS).doc(t.id).get().catch(() => null)
    const doc = res && res.data
    if (!doc || doc.openid !== owner || doc.platform !== 'custom') {
      throw new Error('只能编辑自己创建的任务')
    }
    await db().collection(TASKS).doc(t.id).update({
      data: Object.assign({ title, remindedAt: 0 }, data)
    })
    return t.id
  }
  const r = await db()
    .collection(TASKS)
    .add({
      data: Object.assign(
        {
          openid: owner,
          platform: 'custom',
          externalId: ['custom', now, Math.floor(Math.random() * 1e6)].join('-'),
          courseId: '',
          title,
          taskType: 'custom',
          progress: null,
          status: 'todo',
          manualDone: false,
          url: '',
          required: false,
          remindedAt: 0,
          semesterKey: '',
          semesterLabel: '',
          semesterShort: '',
          semesterRank: 0,
          createdAt: now
        },
        data
      )
    })
  return r._id
}

/** 删除任务（自定义任务用；只能删自己的） */
async function deleteTask(owner, taskId) {
  const res = await db().collection(TASKS).doc(taskId).get().catch(() => null)
  const doc = res && res.data
  if (!doc || doc.openid !== owner) throw new Error('任务不存在')
  await db().collection(TASKS).doc(taskId).remove()
  return true
}

/** 给任务设置提醒时间（自定义/平台任务都行），改时间会重置已提醒标记 */
async function setTaskReminder(owner, taskId, remindAt) {
  const res = await db().collection(TASKS).doc(taskId).get().catch(() => null)
  const doc = res && res.data
  if (!doc || doc.openid !== owner) throw new Error('任务不存在')
  await db()
    .collection(TASKS)
    .doc(taskId)
    .update({ data: { remindAt: Number(remindAt) || 0, remindedAt: 0, updatedAt: Date.now() } })
  return true
}

/** 到点该提醒的任务：设了 remindAt、没发过、时间已过；超过一天还没发成就不再追 */
function dueReminders(tasks, now) {
  const t = now || Date.now()
  return (tasks || []).filter(
    (x) =>
      x &&
      x.remindAt &&
      !x.remindedAt &&
      x.remindAt <= t &&
      t - x.remindAt < 86400000 &&
      x.status !== 'done'
  )
}

async function markReminded(taskId) {
  await db()
    .collection(TASKS)
    .doc(taskId)
    .update({ data: { remindedAt: Date.now() } })
    .catch(() => null)
}

/* ---------------- 提醒（订阅消息额度） ---------------- */

/**
 * 把一个归属键下的数据整体搬到另一个键。
 *
 * 什么时候用：同一个手机号换了微信登录。访客的数据挂在 'g::旧openid' 名下，
 * 换了微信之后 openid 变了，不搬的话登进去是空的，用户会以为数据丢了。
 */
async function moveOwner(from, to) {
  if (!from || !to || from === to) return { moved: 0 }
  let moved = 0
  for (const col of [ACCOUNTS, TASKS, REMINDERS]) {
    let rows = []
    try {
      rows = await queryAll(col, { openid: from })
    } catch (e) {
      continue // 集合还没建，跳过
    }
    for (const r of rows) {
      await db()
        .collection(col)
        .doc(r._id)
        .update({ data: { openid: to } })
        .catch(() => null)
      moved++
    }
  }
  return { moved }
}

/**
 * 定时任务要遍历的归属键（owner），不是裸 openid。
 *
 * 来源取两处：
 *   accounts  —— 绑过平台的学校账号（要拉取、要提醒）
 *   reminders —— 点过「订阅提醒」的人，**这一条是为访客准备的**：
 *                访客没有平台账号，只从 accounts 收集的话他们设的提醒永远发不出去。
 * 两处存的都是 owner key，直接拿去用；发订阅消息前再用 users.openidOfOwner() 反推。
 */
async function listOwners() {
  const [accs, rems] = await Promise.all([queryAll(ACCOUNTS, {}), queryAll(REMINDERS, {})])
  const set = new Set()
  accs.forEach((a) => {
    if (a.openid) set.add(a.openid)
  })
  rems.forEach((r) => {
    if (r.openid) set.add(r.openid)
  })
  return Array.from(set)
}

/** 旧名字，保留兼容 */
const listOpenids = listOwners

async function getReminder(owner) {
  const res = await db().collection(REMINDERS).where({ openid: owner }).limit(1).get()
  return (res.data && res.data[0]) || null
}

/** delta 为 +1（用户授权一次）或 -1（消费一条） */
async function bumpReminder(owner, delta) {
  const now = Date.now()
  const exist = await getReminder(owner)
  if (exist) {
    const remaining = Math.max(0, (exist.remaining || 0) + delta)
    await db().collection(REMINDERS).doc(exist._id).update({ data: { remaining, updatedAt: now } })
    return remaining
  }
  const remaining = Math.max(0, delta)
  await db()
    .collection(REMINDERS)
    .add({ data: { openid: owner, remaining, createdAt: now, updatedAt: now } })
  return remaining
}

module.exports = {
  listAccounts,
  findAccount,
  getAccountById,
  upsertAccount,
  updateAccount,
  removeAccount,
  listTasks,
  replacePlatformTasks,
  toggleTask,
  saveCustomTask,
  deleteTask,
  setTaskReminder,
  dueReminders,
  markReminded,
  moveOwner,
  listOwners,
  listOpenids,
  getReminder,
  bumpReminder
}
