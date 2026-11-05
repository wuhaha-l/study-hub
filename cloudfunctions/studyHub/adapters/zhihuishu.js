/**
 * 智慧树（知到）适配器 —— 实验性 v1（Cookie 模式）
 *
 * 2026-10-24 首版。登录走 passport 的 CAS（cookie 模式跳开），接口来自
 * 开源抓包项目的核对：
 *   GET https://onlineservice.zhihuishu.com/login/getLoginUserInfo   ← 登录态 + 用户信息
 *   课程 / 作业 / 考试的接口分散在 onlineservice / onlineweb / examh5 几个域，
 *   且不同学校部署有差异 —— 所以这里用「多候选路径探测」：逐个试，
 *   命中哪个用哪个，全没命中就把轨迹抛出来，按真账号返回再校准。
 *
 * Cookie 获取：电脑浏览器登录 zhihuishu.com 后，把整串 Cookie 复制过来。
 */
const { CookieJar, request, parseDate } = require('../lib/http')

const KEY = 'zhihuishu'
const NAME = '智慧树'
const ORIGIN = 'https://onlineservice.zhihuishu.com'
const WEB_ORIGIN = 'https://onlineweb.zhihuishu.com'

const COMMON_HEADERS = {
  accept: 'application/json, text/javascript, */*; q=0.01',
  'x-requested-with': 'XMLHttpRequest',
  referer: WEB_ORIGIN + '/'
}

function pick(obj, keys, dft) {
  for (let i = 0; i < keys.length; i++) {
    const v = obj[keys[i]]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return dft
}

function normList(data) {
  if (Array.isArray(data)) return data
  if (!data) return []
  const cand = ['data', 'list', 'rows', 'result', 'records', 'courseList', 'items']
  for (const k of cand) {
    if (Array.isArray(data[k])) return data[k]
    if (data[k] && Array.isArray(data[k].list)) return data[k].list
  }
  return []
}

async function tryJson(jar, url, opts) {
  try {
    const r = await request(url, Object.assign({ jar, headers: COMMON_HEADERS }, opts || {}))
    if (r.status === 401 || r.status === 403) return { skip: 'HTTP ' + r.status }
    const j = JSON.parse(r.text)
    return { json: j, text: r.text }
  } catch (e) {
    return { skip: String((e && e.message) || e).slice(0, 60) }
  }
}

/** 登录态检查：getLoginUserInfo 认 cookie */
async function checkLogin(jar, debug) {
  const r = await tryJson(jar, ORIGIN + '/login/getLoginUserInfo')
  const j = r.json
  const user =
    j && (j.user || j.data || j.result || (j.rs && j.rs.user) || null)
  const okish = j && (j.result === 0 || j.code === 0 || j.status === 0 || !!user)
  if (!r.json || !okish) {
    throw new Error(
      'Cookie 无效或已过期（登录信息接口不认，返回：' +
        (j ? JSON.stringify(j).slice(0, 120) : r.skip || '非 JSON') + '）'
    )
  }
  const name = String(pick(user || {}, ['nickName', 'nickname', 'name', 'userName'], ''))
  debug.push('登录态有效' + (name ? '：' + name : ''))
  return user || {}
}

/** 课程列表：多候选路径探测 */
async function fetchCourses(jar, debug) {
  const candidates = [
    { url: ORIGIN + '/student/course/getCourseList', method: 'POST', body: 'pageNumber=1&pageSize=50' },
    { url: ORIGIN + '/student/course/getStudingCourseList', method: 'POST', body: 'pageNumber=1&pageSize=50' },
    { url: WEB_ORIGIN + '/onlinestuh5/api/student/course/list' },
    { url: ORIGIN + '/gateway/student/course/list' }
  ]
  for (const c of candidates) {
    const r = await tryJson(jar, c.url, {
      method: c.method || 'GET',
      body: c.body,
      headers: Object.assign({}, COMMON_HEADERS, c.body ? { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' } : {})
    })
    if (r.json) {
      const list = normList(r.json)
      if (list.length) {
        debug.push('课程来自 ' + c.url.replace(ORIGIN, '').replace(WEB_ORIGIN, '') + '（' + list.length + ' 门）')
        return { list, raw: r.json }
      }
    }
  }
  debug.push('课程候选路径全未命中')
  return { list: [], raw: null }
}

/** 作业 / 考试：候选路径探测（不同学校入口不同） */
async function fetchTasksOfCourse(jar, course, debug) {
  const cid = pick(course, ['id', 'courseId', 'course_id'], '')
  if (!cid) return []
  const candidates = [
    ORIGIN + '/student/homework/getHomeworkList?courseId=' + cid,
    ORIGIN + '/student/exam/getExamList?courseId=' + cid,
    ORIGIN + '/student/work/getWorkList?courseId=' + cid,
    WEB_ORIGIN + '/onlinestuh5/api/homework/list?courseId=' + cid
  ]
  const out = []
  for (const url of candidates) {
    const r = await tryJson(jar, url)
    if (!r.json) continue
    const list = normList(r.json)
    list.forEach((raw) => {
      if (!raw) return
      const title = String(pick(raw, ['title', 'name', 'homeworkName', 'examName', 'workName'], '')).trim()
      if (!title) return
      const isExam = /exam/i.test(url) || String(pick(raw, ['type'], '')).toLowerCase().indexOf('exam') > -1
      out.push({
        externalId: `${KEY}:${cid}:${pick(raw, ['id', 'homeworkId', 'examId', 'workId'], title)}`,
        courseId: String(cid),
        title,
        taskType: isExam ? 'exam' : 'homework',
        deadline: parseDate(pick(raw, ['deadline', 'endTime', 'end_time', 'handTime', 'submitTime'], '')),
        status: /finish|submit|complet/i.test(JSON.stringify(pick(raw, ['status', 'state'], ''))) ? 'done' : 'todo'
      })
    })
  }
  return out
}

async function sync(account) {
  const debug = []
  if (account.mode !== 'cookie') {
    throw new Error('智慧树 v1 只支持 Cookie 模式：电脑浏览器登录 zhihuishu.com 后复制整串 Cookie')
  }
  const jar = new CookieJar(account.cookie)
  if (!jar.size()) throw new Error('Cookie 为空，请重新复制')

  await checkLogin(jar, debug)

  const { list: courses } = await fetchCourses(jar, debug)
  if (!courses.length) {
    throw new Error('登录态有效但没读到课程。轨迹：' + debug.join('；') + '。把这段发我，按真实返回补接口')
  }
  debug.push('课程数 ' + courses.length)

  const tasks = []
  const seen = new Set()
  for (const course of courses.slice(0, 15)) {
    const list = await fetchTasksOfCourse(jar, course, debug)
    list.forEach((t) => {
      if (seen.has(t.externalId)) return
      seen.add(t.externalId)
      t.courseName = String(pick(course, ['name', 'courseName', 'nameZh'], '未命名课程'))
      tasks.push(t)
    })
  }

  if (!tasks.length) {
    throw new Error(
      '读到 ' + courses.length + ' 门课但没解析出作业/考试。轨迹：' + debug.join('；') +
        '。把这段发我，按真实返回补接口'
    )
  }
  return { tasks, debug }
}

module.exports = { key: KEY, name: NAME, sync }
