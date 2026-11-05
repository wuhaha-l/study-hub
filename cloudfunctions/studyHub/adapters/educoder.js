/**
 * 希冀平台（Educoder / 头歌）适配器
 *
 * 流程：
 *   1. GET  /users/sign_in 取 csrf-token
 *   2. POST /users/sign_in 登录
 *   3. GET  /api/myschools.json 拿课堂
 *   4. GET  /api/schools/{id}/courses.json 拿课程
 *   5. GET  /api/courses/{id}/tasks.json 拿实训任务与完成状态
 */
const { CookieJar, request, formBody, parseDate } = require('../lib/http')
const semester = require('../lib/semester')

const KEY = 'educoder'
const NAME = '希冀'
const ORIGIN = 'https://www.educoder.net'

function pick(obj, keys, dft) {
  for (let i = 0; i < keys.length; i++) {
    const v = obj[keys[i]]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return dft
}

async function buildJar(account) {
  if (account.mode === 'cookie') {
    const jar = new CookieJar(account.cookie)
    if (!jar.size()) throw new Error('Cookie 为空，请重新复制')
    return jar
  }

  const jar = new CookieJar()
  const loginPage = await request(ORIGIN + '/users/sign_in', { jar, maxRedirect: 4 })

  let token = ''
  const m = loginPage.text.match(/name="csrf-token"\s+content="([^"]+)"/)
  if (m) token = m[1]
  if (!token) {
    const m2 = loginPage.text.match(/name="authenticity_token"[^>]*value="([^"]+)"/)
    if (m2) token = m2[1]
  }

  const body = formBody({
    'user[login]': account.username,
    'user[password]': account.password,
    authenticity_token: token,
    commit: '登录'
  })

  const res = await request(ORIGIN + '/users/sign_in', {
    method: 'POST',
    body,
    jar,
    headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      referer: ORIGIN + '/users/sign_in',
      origin: ORIGIN
    },
    maxRedirect: 6
  })

  // 登录成功一般会跳到首页；失败则仍停在 sign_in
  if (/\/users\/sign_in/.test(res.url) && /密码|password|错误|无效|不正确/.test(res.text)) {
    throw new Error('账号或密码不正确')
  }
  const session = jar.get('_educoder_session') || jar.get('_shixi_session')
  if (!session) {
    // 走到这儿说明「公网头歌」这条路没通。三种常见原因：
    //   1. 学校用的是校内自建部署（地址长这样：http://10.67.4.14），账号根本不在公网头歌上
    //   2. 云函数出口是机房 IP，被风控，返回的是验证页 / 审计页，不是登录成功页
    //   3. 账号开了滑块或短信二次验证
    // 前一种在小程序里是有解的（内网直连），后两种没有。所以别再说「改用 Cookie 模式」含糊带过。
    const names = Object.keys(jar.toObject()).slice(0, 8).join(',')
    const titleM = String(loginPage.text || '').match(/<title>([\s\S]*?)<\/title>/i)
    const title = titleM ? titleM[1].replace(/\s+/g, ' ').trim().slice(0, 40) : ''
    throw new Error(
      '公网头歌 www.educoder.net 登录没拿到会话 Cookie。' +
        '如果你学校的希冀是校内自建部署（地址像 http://10.67.4.14），账号不在公网头歌上，' +
        '而且云函数也访问不到内网地址——请用小程序里的「希冀 · 校园内网直连」，' +
        '填学号 + 希冀密码 + 图片验证码就能登，会话只存在手机上。' +
        '诊断：最终地址 ' +
        res.url +
        '，HTTP ' +
        res.status +
        '，拿到的 Cookie [' +
        (names || '无') +
        ']，页面标题「' +
        (title || '无') +
        '」'
    )
  }

  return jar
}

async function getJson(jar, path) {
  const res = await request(ORIGIN + path, {
    jar,
    headers: {
      accept: 'application/json, text/javascript, */*; q=0.01',
      'x-requested-with': 'XMLHttpRequest',
      referer: ORIGIN + '/'
    }
  })
  try {
    return JSON.parse(res.text)
  } catch (e) {
    if (res.status === 401 || res.status === 403) throw new Error('登录态失效（' + res.status + '）')
    throw new Error('接口返回非 JSON：' + path)
  }
}

function normList(data) {
  if (Array.isArray(data)) return data
  if (!data) return []
  if (Array.isArray(data.data)) return data.data
  if (data.data && Array.isArray(data.data.items)) return data.data.items
  if (Array.isArray(data.items)) return data.items
  if (Array.isArray(data.courses)) return data.courses
  if (Array.isArray(data.homework_commons)) return data.homework_commons
  return []
}

/**
 * 课程列表。/api/courses/mine.json 是 Educoder 学生端真实在用的接口
 * （2026-10 在 www.educoder.net 验证过路径；旧的 myschools/schools 那组
 * 在新版本上已经不存在），先走它，读不到再退回老路。
 */
async function fetchCourses(jar, debug) {
  const mine = ['/api/courses/mine.json', '/api/courses.json?scope=joined', '/api/courses.json']
  for (const p of mine) {
    try {
      const data = await getJson(jar, p)
      const list = normList(data)
      if (list.length) {
        debug.push('课程来自 ' + p)
        return list
      }
    } catch (e) {
      /* 换下一个 */
    }
  }
  // 老版本部署：课堂 → 课程
  const schools = await fetchSchools(jar)
  for (const school of schools.slice(0, 6)) {
    const sid = pick(school, ['id', 'school_id'], '')
    if (!sid) continue
    const paths = [
      `/api/schools/${sid}/courses.json?scope=joined`,
      `/api/schools/${sid}/courses.json`
    ]
    for (const p of paths) {
      try {
        const data = await getJson(jar, p)
        const list = normList(data)
        if (list.length) {
          debug.push('课程来自 ' + p)
          return list
        }
      } catch (e) {
        /* 换下一个 */
      }
    }
  }
  return []
}

async function fetchSchools(jar) {
  const tries = ['/api/myschools.json', '/api/schools.json', '/api/users/current_user.json']
  for (const p of tries) {
    try {
      const data = await getJson(jar, p)
      const list = normList(p.endsWith('current_user.json') ? data && data.schools : data)
      if (list.length) return list
    } catch (e) {
      /* 换下一个 */
    }
  }
  return []
}

function toTask(course, raw) {
  const done =
    raw.finished === true ||
    raw.is_finished === true ||
    raw.status === 'finished' ||
    raw.status === 1 ||
    raw.passed === true ||
    raw.work_status === 2 // Educoder：已交且评分
  const deadline = parseDate(pick(raw, ['deadline', 'end_time', 'end_at', 'expire_at'], ''))
  const id = pick(raw, ['id', 'task_id', 'challenge_id', 'homework_id'], '')
  const title = pick(raw, ['name', 'title', 'challenge_name', 'homework_name'], '未命名任务')
  return {
    externalId: `${KEY}:${course.id}:${id || title}`,
    courseId: String(course.id || ''),
    courseName: pick(course, ['name', 'title', 'course_name'], '未命名课程'),
    title: String(title),
    taskType: raw.challenge_id || raw.homework_type === 'shixun' || raw.type === 'challenge' ? 'practice' : 'homework',
    deadline,
    status: done ? 'done' : 'todo',
    progress: null,
    url: id ? `${ORIGIN}/homework_commons/${id}` : `${ORIGIN}/`
  }
}

async function fetchTasksOfCourse(jar, course) {
  // homework_commons 是 Educoder 给课程挂作业/实训的真实载体（旧版 tasks.json 不存在）
  const paths = [
    `/api/courses/${course.id}/homework_commons.json?page=1&limit=200`,
    `/api/courses/${course.id}/homework_commons.json`,
    `/api/courses/${course.id}/homework_commons/list.json`,
    `/api/courses/${course.id}/tasks.json?limit=200`,
    `/api/courses/${course.id}/homeworks.json?limit=200`,
    `/api/courses/${course.id}/challenges.json?limit=200`
  ]
  const out = []
  for (const p of paths) {
    try {
      const data = await getJson(jar, p)
      const list = normList(data)
      list.forEach((raw) => {
        if (!raw) return
        const t = toTask(course, raw)
        if (t.title && t.title !== '未命名任务') out.push(t)
      })
    } catch (e) {
      /* 换下一个 */
    }
  }
  // 按 externalId 去重
  const seen = new Set()
  return out.filter((t) => {
    if (seen.has(t.externalId)) return false
    seen.add(t.externalId)
    return true
  })
}

async function sync(account) {
  const debug = []
  const jar = await buildJar(account)

  const courses = await fetchCourses(jar, debug)
  debug.unshift(`课程数 ${courses.length}`)
  if (!courses.length) {
    throw new Error('登录成功但没有读到课程，可能是 Cookie 不完整')
  }

  const allTasks = []
  for (const course of courses.slice(0, 20)) {
    if (!course || !course.id) continue
    try {
      const list = await fetchTasksOfCourse(jar, course)
      // 学期标签：优先课程开始时间，其次课程名里的「2026春季」这类字样。
      // 打上标签首页才会默认只看本学期（和超星一个口径）。
      const startMs = parseDate(
        pick(course, ['start_date', 'start_time', 'begin_date', 'begin_time', 'created_at', 'create_time'], '')
      )
      const sem = semester.ofCourse({
        startMs,
        name: pick(course, ['name', 'title', 'course_name'], '')
      })
      list.forEach((t) => {
        t.semesterKey = sem.key
        t.semesterLabel = sem.label
        t.semesterShort = sem.short
        t.semesterRank = sem.rank
      })
      allTasks.push.apply(allTasks, list)
      if (list.length) {
        debug.push(`${pick(course, ['name', 'title'], course.id)}: ${list.length}（${sem.short}）`)
      }
    } catch (e) {
      /* 单课失败不影响整体 */
    }
  }

  if (!allTasks.length) {
    throw new Error(`读到 ${courses.length} 门课但没有解析出任务，接口可能已改版`)
  }

  return { tasks: allTasks, debug }
}

module.exports = { key: KEY, name: NAME, sync }
