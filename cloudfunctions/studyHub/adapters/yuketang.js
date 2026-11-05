/**
 * 雨课堂（yuketang）适配器 —— 实验性 v1（Token 模式）
 *
 * 2026-10-24 首版。雨课堂网页端的认证是 Bearer token（存在浏览器
 * localStorage 里，不在 Cookie 上），而且不同学校的部署子域不同
 * （pro / changjiang / gsscut.yuketang.cn …），所以账号配置里要填两样：
 *   - 接口子域（如 https://pro.yuketang.cn）
 *   - token（F12 → Network → 任意请求的 Authorization 头里 Bearer 后面那段）
 *
 * 已核对的接口（开源抓包项目）：
 *   GET {host}/mooc-api/v1/lms/user/user-courses/?status=1&page=1&no_page=1&term=latest
 *   GET {host}/mooc-api/v1/lms/learn/course/chapter?cid=<课堂id>&term=latest
 * 作业 / 考试的截止接口各部署有差异，走多候选探测 + 调试轨迹。
 */
const { request, parseDate } = require('../lib/http')

const KEY = 'yuketang'
const NAME = '雨课堂'
const DEFAULT_HOST = 'https://pro.yuketang.cn'

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
  const cand = ['data', 'list', 'rows', 'results', 'courses', 'courseList']
  for (const k of cand) {
    if (Array.isArray(data[k])) return data[k]
    if (data[k] && Array.isArray(data[k].list)) return data[k].list
    if (data[k] && Array.isArray(data[k].results)) return data[k].results
  }
  return []
}

function headers(token) {
  return {
    authorization: 'Bearer ' + token,
    accept: 'application/json, text/plain, */*',
    'x-requested-with': 'XMLHttpRequest'
  }
}

async function tryJson(host, path, token) {
  try {
    const r = await request(host + path, { timeout: 12000, headers: headers(token) })
    if (r.status === 401 || r.status === 403) return { skip: 'HTTP ' + r.status }
    const j = JSON.parse(r.text)
    return { json: j, text: r.text }
  } catch (e) {
    return { skip: String((e && e.message) || e).slice(0, 60) }
  }
}

/** 学校部署的子域不固定：账号里填什么就用什么；没填就先试几个常见的 */
function resolveHosts(hostField) {
  const h = String(hostField || '').trim().replace(/\/+$/, '')
  if (h) return [h]
  return ['https://pro.yuketang.cn', 'https://changjiang.yuketang.cn', 'https://www.yuketang.cn']
}

async function sync(account) {
  const debug = []
  if (account.mode !== 'cookie') {
    throw new Error(
      '雨课堂 v1 只支持 Token 模式：电脑浏览器打开雨课堂网页版 → F12 → Network → ' +
        '任意请求的 Authorization 头里 Bearer 后面那段就是 token'
    )
  }
  // cookie 字段复用为「host|token」或纯 token
  const raw = String(account.cookie || '').trim()
  if (!raw) throw new Error('还没填 token：F12 → Network → 任意请求的 Authorization 里 Bearer 后面那段')
  const parts = raw.split('|')
  const hosts = resolveHosts(parts[0] && parts[0].indexOf('http') === 0 ? parts[0] : '')
  const token = parts.length > 1 ? parts[parts.length - 1] : (parts[0].indexOf('http') === 0 ? '' : parts[0])
  if (!token) throw new Error('没认出 token：格式应为「https://你的子域.yuketang.cn|Bearer后面的token」，或只填 token')

  // ① 我的课程：跨子域探测
  let courseList = null
  let host = ''
  let gotValid = false
  for (const h of hosts) {
    const r = await tryJson(h, '/mooc-api/v1/lms/user/user-courses/?status=1&page=1&no_page=1&term=latest', token)
    if (r.json) {
      gotValid = true
      const list = normList(r.json)
      if (list.length) {
        courseList = list
        host = h
        debug.push('课程来自 ' + h + '（' + list.length + ' 门）')
        break
      }
    }
  }
  if (!courseList) {
    throw new Error(
      gotValid
        ? 'token 通了但没读到课程（可能是空的或子域不对）。试过 ' + hosts.join('、') + '。轨迹：' + debug.join('；')
        : 'token 无效或子域没命中（试过 ' + hosts.join('、') + '）。' +
          'token 从 F12 的 Authorization 头里拿；子域看你浏览器地址栏。轨迹：' + debug.join('；')
    )
  }

  // ② 逐课拉章节/任务
  const tasks = []
  const seen = new Set()
  for (const c of courseList.slice(0, 15)) {
    const cid = pick(c, ['classroom_id', 'classroomId', 'id'], '')
    const cname = String(
      pick(c, ['course_name', 'courseName', 'name'], c.course ? pick(c.course, ['name'], '') : '') || '未命名课程'
    )
    if (!cid) continue
    const r = await tryJson(host, '/mooc-api/v1/lms/learn/course/chapter?cid=' + encodeURIComponent(cid) + '&term=latest', token)
    if (!r.json) continue
    // 章节树里塞着各类学习活动；放宽匹配：递归收集带 name/deadline 的节点
    const stack = normList(r.json)
    let node
    while ((node = stack.pop())) {
      if (!node || typeof node !== 'object') continue
      const kids = node.leaf_list || node.children || node.sections || node.sub_list
      if (Array.isArray(kids)) stack.push.apply(stack, kids)
      const title = String(pick(node, ['name', 'title'], '')).trim()
      const dl = pick(node, ['deadline', 'homework_deadline', 'exam_deadline', 'end_time'], '')
      if (!title || !dl) continue
      const key = `${KEY}:${cid}:${pick(node, ['id', 'homework_id', 'exam_id'], title)}`
      if (seen.has(key)) continue
      seen.add(key)
      tasks.push({
        externalId: key,
        courseId: String(cid),
        courseName: cname,
        title,
        taskType: /exam|考试/i.test(title + (node.type || '')) ? 'exam' : /homework|作业/i.test(title + (node.type || '')) ? 'homework' : 'practice',
        deadline: parseDate(dl),
        status: pick(node, ['finished', 'completed'], false) === true ? 'done' : 'todo'
      })
    }
  }

  if (!tasks.length) {
    throw new Error(
      '读到 ' + courseList.length + ' 门课但没解析出带截止时间的任务。轨迹：' + debug.join('；') +
        '。雨课堂各部署的字段有差异，把这段发我按真实返回补'
    )
  }
  return { tasks, debug }
}

module.exports = { key: KEY, name: NAME, sync }
