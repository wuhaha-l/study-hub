/**
 * 学习通（超星）适配器
 *
 * 流程：
 *   1. passport2.chaoxing.com/fanyalogin 登录（密码 AES-128-CBC 加密）
 *   2. mooc1-api.chaoxing.com/mycourse/backclazzdata 拿课程 + 班级
 *   3. 逐课程请求作业 / 章节任务点，解析出未完成项
 *
 * 说明：第 3 步依赖页面结构，超星改版时需要调整 parseWorkHtml / parseTaskPointHtml
 * 里的正则。出错不会阻塞其他平台，错误会带着 debug 信息一起返回。
 */
const crypto = require('crypto')
const { CookieJar, request, formBody, matchOne, parseDate } = require('../lib/http')
const semester = require('../lib/semester')

const KEY = 'chaoxing'
const NAME = '学习通'
const PASS_KEY = 'u2oh6Vu^HWe4_AES' // 超星网页端固定密钥
const REFER = 'https://i.chaoxing.com/'

/** 实在拿不到具体链接时的兜底，调用方可以据此判断「这条没链接」再补 */
const FALLBACK_URL = 'https://i.chaoxing.com/'

function aesEncryptPassword(pwd) {
  const key = Buffer.from(PASS_KEY, 'utf8')
  const cipher = crypto.createCipheriv('aes-128-cbc', key, key)
  return Buffer.concat([cipher.update(String(pwd), 'utf8'), cipher.final()]).toString('base64')
}

async function buildJar(account) {
  if (account.mode === 'cookie') {
    const jar = new CookieJar(account.cookie)
    if (!jar.size()) throw new Error('Cookie 为空，请重新复制')
    return jar
  }

  const jar = new CookieJar()
  const loginPage = 'https://passport2.chaoxing.com/login?refer=' + encodeURIComponent(REFER)
  await request(loginPage, { jar, maxRedirect: 3 }).catch(() => null)

  const body = formBody({
    fid: '-1',
    uname: account.username,
    password: aesEncryptPassword(account.password),
    refer: REFER,
    t: 'true',
    forbidotherlogin: '0'
  })

  const res = await request('https://passport2.chaoxing.com/fanyalogin', {
    method: 'POST',
    body,
    jar,
    headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      origin: 'https://passport2.chaoxing.com',
      referer: loginPage
    }
  })

  let data = null
  try {
    data = JSON.parse(res.text)
  } catch (e) {
    /* 下面统一处理 */
  }
  if (!data) throw new Error('登录接口无有效响应，可能触发了验证码风控，建议改用 Cookie 模式')
  if (!data.status) throw new Error(data.msg || data.message || '账号或密码不正确')

  // 补全登录态
  await request('https://i.chaoxing.com/base', { jar, maxRedirect: 5 }).catch(() => null)
  return jar
}

/** 只列字段名，不含值——排查登录态缺什么时够用，也不会泄露凭据 */
function cookieKeys(jar) {
  try {
    const keys = Object.keys(jar.toObject())
    return keys.length ? keys.join(',') : '空'
  } catch (e) {
    return '未知'
  }
}

/* ---------------- 课程列表：多路兜底 ---------------- */

const API_COURSES = 'https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1'

// 未登录时这些地址一律 302 到 passport2 登录页。
// 所以「被跳转到登录页」是登录态无效的铁证，比接口的报错文案更可信。
const COURSE_PAGES = [
  'https://mooc1.chaoxing.com/visit/courses',
  'https://i.mooc.chaoxing.com/space/index',
  'https://mooc1.chaoxing.com/visit/interaction'
]

function squeeze(t, n) {
  return String(t || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n || 60)
}

function hostOf(url) {
  const m = String(url).match(/^https?:\/\/([^/]+)/i)
  return m ? m[1] : String(url)
}

function isLoginPage(url) {
  return /passport2?\.chaoxing\.com\/login/i.test(String(url || ''))
}

/** backclazzdata 的 channelList → 课程数组 */
/**
 * 课程开始时间 → 毫秒时间戳（学期判定用）。
 * 真实返回里两种都有：
 *   content.beginDate = '2026-09-02 08:24'   ← 教学起始
 *   course.data[0].createtime = 1788308677000 ← 建课时间
 * 优先 beginDate，退而求其次用 createtime；都没有就返回 0，交给课程名兜底。
 */
function startMsOf(content, courseData) {
  const raw = (content && content.beginDate) || ''
  if (raw) {
    const t = Date.parse(String(raw).replace(/-/g, '/').replace('T', ' '))
    if (t && !isNaN(t)) return t
  }
  const ct = Number((courseData && courseData.createtime) || 0)
  if (ct > 1e12) return ct
  if (ct > 1e9) return ct * 1000
  return 0
}

function pickFromApiData(data) {
  const list = []
  const channels = (data && data.channelList) || []
  channels.forEach((ch) => {
    const content = (ch && ch.content) || {}
    const course = content.course
    if (!course || !Array.isArray(course.data)) return
    course.data.forEach((d) => {
      if (!d) return
      /*
       * 字段名各版本不一致，实测（2026-10）真实返回是：
       *   { id: 228014089, name: "大学英语 （III）", teacherfactor: "张琳" }
       * 班级号和 cpi 在同级的 content 上，不在 d 里：
       *   content.id = 151950673（clazzId）、content.cpi = 493413415
       * 老版接口用的是 courseid / clazzid，所以两种都认。
       */
      const courseId = d.courseid || d.courseId || d.id
      if (!courseId) return

      const clazzId = d.clazzid || d.classId || d.clazzId || content.id || ''
      const cpi = d.cpi || content.cpi || ch.cpi || ''

      list.push({
        courseId: String(courseId),
        clazzId: String(clazzId),
        cpi: String(cpi),
        name: d.name || content.name || '未命名课程',
        teacher: d.teacherfactor || d.teacherName || '',
        // 学期判定用：课程开始时间（优先教学周起点，其次建课时间）
        startMs: startMsOf(content, d),
        // 超星自己会把结课的班标成 isretire = 1，配合开始时间判断「上学期」
        retired: Number(content.isretire) === 1
      })
    })
  })
  return list
}

/** 在字符串里找最后一处匹配（课程名通常就在课程链接的正前方） */function lastGroup(str, re) {
  const g = new RegExp(re.source, 'gi')
  let m
  let last = ''
  let guard = 0
  while ((m = g.exec(str)) && guard++ < 300) last = m[1] || ''
  return last
}

const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  ldquo: '“', rdquo: '”', mdash: '—', hellip: '…', middot: '·'
}

/** 解实体 + 折掉多余空白，用于标题这类要直接展示的文本 */
function cleanText(s) {
  return decodeEntities(s).replace(/\s+/g, ' ').trim()
}

/** 标题里的 &nbsp; / &amp; 之类要去掉，否则列表里会显示成源码 */
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d{2,6});/g, (_, d) => {
      const n = Number(d)
      return n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : _
    })
    .replace(/&#x([0-9a-f]{2,6});/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]{2,8});/gi, (all, k) => {
      const v = ENTITIES[k.toLowerCase()]
      return v === undefined ? all : v
    })
    .replace(/\s{2,}/g, ' ')
}

/**
 * 「我学的课」页面 → 课程数组。
 * 页面里课程链接长这样：
 *   /visit/stucoursemiddle?courseid=123&clazzid=456&vc=1&cpi=789
 *   /mycourse/studentcourse?courseId=123&clazzid=456
 */
function parseCourseListHtml(html) {
  const out = []
  const seen = new Set()
  if (!html) return out

  /*
   * 首选：按课程卡片切块。`/visit/courses`（学生端）的真实结构是
   *   <li class="courseItem">
   *     <input type="hidden" name="courseId" value="266276793" />
   *     <input type="hidden" name="classId"  value="152467860" />
   *     ... <a href='/visit/stucoursemiddle?...&cpi=493413415'> 图片 </a>
   *     ... <a class="courseName" title="汇编语言">汇编语言</a>
   *     ... <p title="穆玲玲，张行进">穆玲玲，张行进</p>
   * 注意课程名在链接「后面」，早期版本往前找 title 会取到「移动到」之类的按钮文字。
   */
  const cards = String(html).split(/<li[^>]*class="[^"]*courseItem/i)
  cards.forEach((raw, idx) => {
    if (idx === 0) return
    const block = raw.slice(0, 3000)
    const courseId =
      matchOne(block, /name="courseId"\s+value="(\d{2,12})"/i) ||
      matchOne(block, /name="courseid"\s+value="(\d{2,12})"/i)
    if (!courseId || seen.has(courseId)) return
    seen.add(courseId)

    const clazzId =
      matchOne(block, /name="classId"\s+value="(\d{2,12})"/i) ||
      matchOne(block, /name="clazzid"\s+value="(\d{2,12})"/i)
    const cpi = matchOne(block, /[?&]cpi=(\d{1,12})/i)

    const name =
      matchOne(block, /class="[^"]*courseName[^"]*"[^>]*title="([^"<>]{2,80})"/i) ||
      matchOne(block, /class="[^"]*courseName[^"]*"[^>]*>\s*([^<>]{2,80})\s*</i) ||
      matchOne(block, /<h3[^>]*>[\s\S]{0,300}?title="([^"<>]{2,80})"/i) ||
      ''

    // 老师：块里第一个有内容的 <p title="...">
    const teacher = matchOne(block, /<p[^>]*title="([^"<>]{2,60})"/i) || ''

    out.push({
      courseId,
      clazzId: clazzId || '',
      cpi: cpi || '',
      name: decodeEntities(name).trim(),
      teacher: decodeEntities(teacher).trim()
    })
  })

  if (out.length) return out

  // 兜底：纯正则扫课程链接（老版页面没有 courseItem 卡片）
  const re = /(?:courseid|courseId)=(\d{2,12})([^"'<>\s]{0,160}?)clazzid=(\d{2,12})([^"'<>\s]{0,120})/gi
  let m
  let guard = 0
  while ((m = re.exec(html)) && guard++ < 200) {
    const courseId = m[1]
    if (seen.has(courseId)) continue
    seen.add(courseId)
    const rest = (m[2] || '') + (m[4] || '')
    const cpiMatch = rest.match(/(?:cpi|openc)=(\d{1,12})/i)

    // 先看「包住这个链接的 <a> 标签」自己有没有 title / 链接文字
    let name = ''
    const aStart = String(html).lastIndexOf('<a', m.index)
    const aEnd = String(html).indexOf('</a>', m.index)
    if (aStart >= 0 && aEnd > m.index && aEnd - aStart < 2000) {
      const tag = html.slice(aStart, aEnd)
      name =
        matchOne(tag, /title="([^"<>]{2,80})"/) ||
        matchOne(tag, /[^/]>\s*([^<>]{2,80})\s*$/) ||
        ''
    }
    // 再看紧挨着的 courseName 区块（学生端结构里课程名在链接后面）
    if (!name) {
      const after = html.slice(m.index, m.index + 1200)
      name =
        matchOne(after, /class="[^"]*courseName[^"]*"[\s\S]{0,100}?title="([^"<>]{2,80})"/i) ||
        matchOne(after, /class="[^"]*courseName[^"]*"[\s\S]{0,120}?>\s*([^<>]{2,80})\s*</i) ||
        ''
    }

    out.push({
      courseId,
      clazzId: m[3],
      cpi: cpiMatch ? cpiMatch[1] : '',
      name: decodeEntities(name).trim(),
      teacher: ''
    })
  }
  return out
}

/** 官方 JSON 接口；返回 null 表示这条路走不通 */
async function tryApiCourses(jar, trace) {
  // Referer 换了两个值，超星对来源页敏感
  const referers = ['https://mooc1.chaoxing.com/mycourse/studentcourse', REFER]
  for (let i = 0; i < referers.length; i++) {
    let res
    try {
      res = await request(API_COURSES, {
        jar,
        maxRedirect: 0,
        timeout: 15000,
        headers: { referer: referers[i], accept: 'application/json, text/javascript, */*; q=0.01' }
      })
    } catch (e) {
      trace.push('课程接口请求失败(' + squeeze(e.message, 30) + ')')
      continue
    }
    if (res.status >= 300 && res.status < 400) {
      trace.push('课程接口被重定向到登录页')
      continue
    }

    let data
    try {
      data = JSON.parse(res.text)
    } catch (e) {
      trace.push('课程接口返回非 JSON(HTTP ' + res.status + ')：' + squeeze(res.text, 40))
      continue
    }

    if (data.status === false || data.result === 0) {
      trace.push('课程接口说「' + squeeze(data.msg || data.errorMsg || '请重新登录', 20) + '」')
      continue
    }

    const list = pickFromApiData(data)
    if (list.length) return list

    // 解析不出课程，两种可能：确实没课，或字段名又变了。别急着下结论，让 HTML 兜底再试
    const n = Array.isArray(data.channelList) ? data.channelList.length : 0
    trace.push(
      n
        ? '课程接口返回 ' + n + ' 个 channel，但没解析出课程（字段名可能变了）'
        : '课程接口通了但 channelList 为空'
    )
  }
  return null
}

/** HTML 课程页兜底：浏览器能看到的页面，比接口宽松 */
async function tryHtmlCourses(jar, trace) {
  for (let i = 0; i < COURSE_PAGES.length; i++) {
    const page = COURSE_PAGES[i]
    let res
    try {
      res = await request(page, {
        jar,
        maxRedirect: 5,
        timeout: 15000,
        headers: { referer: REFER, accept: 'text/html,application/xhtml+xml' }
      })
    } catch (e) {
      trace.push(hostOf(page) + ' 打不开')
      continue
    }
    if (isLoginPage(res.url)) {
      trace.push(hostOf(page) + ' 被跳登录页')
      continue
    }
    const list = parseCourseListHtml(res.text)
    if (list.length) return list
    trace.push(hostOf(page) + ' 无课程链接(' + String(res.text || '').length + '字节)')
  }
  return null
}

/**
 * 取课程列表。失败时不抛错，返回 null 并把每一条尝试路径写进 trace，
 * 让调用方能把「到底哪一步断了」原样展示出来。
 */
async function fetchCourses(jar, trace, jsonOnly) {
  const list = await tryApiCourses(jar, trace)
  if (list && list.length) return list
  if (jsonOnly) return null
  const html = await tryHtmlCourses(jar, trace)
  return html && html.length ? html : null
}

/**
 * 去掉登录域的会话类 cookie。
 *
 * 为什么需要这个：登录态 cookie（_uid/_d/uf）是在 passport2 上发的，
 * 而补全过程中访问 i.chaoxing.com / mooc1.chaoxing.com 会各发一个新的 JSESSIONID，
 * 扁平 cookie 串里同名会把前一个覆盖掉。带着「错的」会话号去请求，
 * 超星就会判定「请重新登录」。所以准备一份去掉会话号的版本再试一次。
 */
function slimCookie(str) {
  return String(str || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => !/^(JSESSIONID|route)\b/i.test(p))
    .join('; ')
}

/** 从 HTML 片段中抽取作业 / 考试条目 */
function parseWorkHtml(html, course) {
  const items = []
  if (!html) return items

  // 先按行块切分，缩小匹配范围
  const blocks = String(html).split(/<(?:li|tr|div class="ul|div class="work)/i)
  blocks.forEach((raw, idx) => {
    if (idx === 0) return
    const block = raw.slice(0, 1600)

    const title =
      matchOne(block, /<a[^>]*>\s*([^<>]{3,90})\s*<\/a>/i) ||
      matchOne(block, /<div[^>]*class="[^"]*title[^"]*"[^>]*>\s*([^<>]{3,90})/i)
    if (!title) return
    if (/^(返回|刷新|搜索|全部|更多|首页|登录)$/.test(title)) return

    // 状态
    let status = 'todo'
    if (/已完成|已提交|已交|通过|满分/.test(block)) status = 'done'
    else if (/待重做|被打回|未通过/.test(block)) status = 'todo'
    else if (/未交|待交|未提交|未完成|待做|进行中/.test(block)) status = 'todo'

    // 截止时间
    const deadlineRaw =
      matchOne(block, /截止时间[：:]\s*([\d]{4}[-/年][\d]{1,2}[-/月][\d]{1,2}日?(?:\s*[\d]{1,2}:[\d]{2})?)/i) ||
      matchOne(block, /(\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})/)
    const deadline = parseDate(deadlineRaw)

    const workId = matchOne(block, /(?:workid|workId)["'=:\s]+(\d+)/i)
    const isExam = /考试|测验/.test(block) || /exam/i.test(block)

    items.push({
      externalId: `${KEY}:${course.courseId}:${workId || title}`,
      courseId: course.courseId,
      courseName: course.name,
      title: decodeEntities(title).trim(),
      taskType: isExam ? 'exam' : 'homework',
      deadline,
      status,
      progress: null,
      url: workId
        ? `https://mooc1.chaoxing.com/mooc-ans/work/doHomeWorkNew?courseId=${course.courseId}&classId=${course.clazzId}&workId=${workId}`
        : 'https://i.chaoxing.com/'
    })
  })

  // 去重
  const seen = new Set()
  return items.filter((it) => {
    if (seen.has(it.externalId)) return false
    seen.add(it.externalId)
    return true
  })
}

/**
 * 进入课程首页，拿 enc / openc 两个动态口令。
 *
 * 为什么非要这一步：作业、考试、章节页全部要带 enc，而 enc 是每次访问课程时
 * 现算的。直接拼 `mycourse/studentcourse?courseId=..&clazzid=..` 不带 enc，
 * 超星会返回一个机构通用模板（看着像正常页面，其实一个字都没有）。
 *
 * `/visit/stucoursemiddle` 是课程卡片上的真实链接，它 302 到带 enc 的地址，
 * 跟随后从最终 URL 里把参数取出来。
 */
async function fetchCourseEntry(jar, course) {
  const url =
    'https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=' + course.courseId +
    '&clazzid=' + course.clazzId + '&vc=1&cpi=' + encodeURIComponent(course.cpi)

  const res = await request(url, {
    jar,
    timeout: 25000,
    maxRedirect: 8,
    headers: { referer: 'https://mooc1.chaoxing.com/visit/courses' }
  })

  const html = String(res.text || '')
  const enc =
    matchOne(html, /[?&]enc=([0-9a-f]{16,40})/i) ||
    matchOne(String(res.url || ''), /[?&]enc=([0-9a-f]{16,40})/i)
  const openc = matchOne(html, /[?&]openc=([0-9a-z]{16,40})/i)

  if (!enc) throw new Error('课程页没取到 enc（可能不是本班学生）')

  return { enc, openc, pageUrl: String(res.url || url), html }
}

/**
 * 课程目录页 → 章节任务点（按「章」汇总，不是按小节）。
 * 真实结构（2026-10 实测）：
 *   <div class="units">
 *     <h2 class="levelfirst"><a title="认识汇编语言">
 *         <span class="chapterNumber">第1章</span>认识汇编语言</a></h2>
 *     <div class="leveltwo"><h3><a href='/mooc-ans/mycourse/studentstudy?chapterId=1225659815'>
 *         <span class="chapterNumber">1.1</span><span class="articlename" title="导学">导学</span></a>
 *         <input type="hidden" value="1" class="knowledgeJobCount"/>  ← 该小节未完成任务点数
 * 为什么按章汇总：大学物理这种课一个学期能有一百多个小节的视频任务点，
 * 逐小节摊到首页会把「要交的作业」全冲掉。按章汇总后每门课最多十几条，
 * 点进去直接落在该章第一个没做完的小节。
 */
function parseChapterHtml(html, course) {
  const out = []
  if (!html) return out
  const courseId = (course && course.courseId) || ''

  String(html)
    .split('<div class="units">')
    .slice(1)
    .forEach((block) => {
      // 章名直接取 h2 的整段文字：不同课程写法不一样，
      // 有的把「第1章」放在 <span class="chapterNumber"> 里，有的直接写在 <a> 里，
      // 统一去标签取文字最稳（例：「第1章 认识汇编语言」「第3章 栈和队列」）。
      const h2End = block.indexOf('</h2>')
      const h2 = h2End > 0 ? block.slice(0, h2End + 5) : block.slice(0, 800)
      let name = cleanText(h2.replace(/<i[\s\S]{0,200}?<\/i>/gi, ' ').replace(/<[^>]+>/g, ' '))
      // 有的课程章号写两遍（chapterNumber 一次、标题里又一次）：第1章 第一章 质点运动学
      const dup = name.match(
        /^(第\s*[0-9一二三四五六七八九十百零]+\s*[章讲课单元篇])\s*第\s*[0-9一二三四五六七八九十百零]+\s*[章讲课单元篇]/
      )
      if (dup) name = name.slice(dup[1].length).trim()
      const no = (matchOne(name, /(第\s*[0-9一二三四五六七八九十百零]+\s*[章讲课单元篇])/) || '').replace(/\s+/g, '')

      const ids = []
      const re = /studentstudy\?chapterId=(\d+)/g
      let m
      while ((m = re.exec(block))) if (ids.indexOf(m[1]) < 0) ids.push(m[1])

      const todo = []
      ids.forEach((id, i) => {
        const at = block.indexOf('chapterId=' + id)
        const nextAt = i + 1 < ids.length ? block.indexOf('chapterId=' + ids[i + 1]) : block.length
        const seg = block.slice(at, nextAt > at ? nextAt : block.length)
        const input = matchOne(seg, /<input[^>]*knowledgeJobCount[^>]*>/i) || ''
        const unfinished = Number(matchOne(input, /value="(\d+)"/) || 0)
        if (!unfinished) return
        todo.push({
          chapterId: id,
          no: cleanText(matchOne(seg, /class="chapterNumber"[^>]*>([\s\S]{0,200}?)<\/span>/) || '').replace(/\s+/g, ''),
          title: cleanText(matchOne(seg, /articlename[^>]*title="([^"]{1,160})"/) || ''),
          unfinished
        })
      })

      const total = todo.reduce((a, s) => a + s.unfinished, 0)
      if (!total) return
      out.push({
        no,
        title: name,
        unfinished: total,
        sections: todo,
        chapterId: todo[0].chapterId,
        courseId
      })
    })

  return out
}

/** 拼带齐 enc/openc 的公共查询串 */
function courseQuery(course, entry) {
  const parts = [
    'classId=' + encodeURIComponent(course.clazzId),
    'courseId=' + encodeURIComponent(course.courseId),
    'ut=s',
    'enc=' + encodeURIComponent(entry.enc),
    'cpi=' + encodeURIComponent(course.cpi)
  ]
  if (entry.openc) parts.push('openc=' + encodeURIComponent(entry.openc))
  return parts.join('&')
}

/**
 * 作业 / 考试状态判定。
 *
 * 之前只认 `<strong>` 里的文字：
 *   <span class="fl">作业状态：</span><strong>待批阅</strong>
 * 但同一个人不同课程、不同学期，这段 HTML 的包法并不一样，实测见过：
 *   <span class="fl">作业状态：</span><span class="status">已完成</span>
 *   <span class="fl">作业状态：</span> 待批阅          ← 连标签都没有
 *   <span class="fl">作业状态：</span><strong class="green">已完成</strong>
 * 只认 strong 就会把「平台已经交了的」继续算成未交 —— 表现就是
 * 「我在学习通交了作业，同步完小程序还是未完成」。
 *
 * 所以改成：截「状态：」后面一小段 → 剥标签 → 按词表判断；
 * 状态栏整段都认不出来时，才退回整块行文本兜底。
 */
function plainText(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/** '' = 这段文字里看不出状态 */
function verdictOf(text, isExam) {
  const t = String(text || '')
  if (!t) return ''
  // 「未通过」里含「通过」，先排掉这一类，否则未通过会被当成完成
  if (/未通过|待重做|被打回/.test(t)) return 'todo'
  if (/待批阅|待批|已批阅|已完成|已提交|已交|通过|满分/.test(t)) return 'done'
  if (/待做|待交|未交|未提交|未完成|未开始|进行中|已过期/.test(t)) return 'todo'
  // 考试结束后状态栏只剩「已结束」，考没考都这么写，只能当完成处理
  if (isExam && /已结束/.test(t)) return 'done'
  return ''
}

function statusWordOf(block, isExam) {
  // 状态栏：从「作业状态：/考试状态：」往后取一小段（够包住 1~2 层标签）
  const seg = matchOne(block, /(?:作业|考试)状态[：:]?\s*(?:<\/span>)?([\s\S]{0,140})/i)
  const v = verdictOf(plainText(seg), isExam)
  if (v) return v
  // 状态栏没写 / 结构不认识：整行文字里总得出现一个状态词
  return verdictOf(plainText(block), isExam) || 'todo'
}

/**
 * 作业列表页 → 条目数组。
 * 真实结构（2026-10 实测）：
 *   <div class="titTxt">
 *     <a class="inspectTask" data="57451962" title="实验报告3 C语言程序的机器表示">实验报告3 …</a>
 *     <span class="pt5"><span class="fl">截止时间：</span>2026-11-15 23:59</span>
 *     <span class="pt5"><span class="fl">作业状态：</span><strong>待做</strong></span>
 * 标题在 title 属性里是完整的，</a> 里的文本会被截断加省略号，所以优先取 title。
 */
function parseWorkListHtml(html, course, kind) {
  const items = []
  if (!html) return items
  const isExam = kind === 'exam'

  const blocks = String(html).split(/<div[^>]*class="titTxt"/i)
  blocks.forEach((raw, idx) => {
    if (idx === 0) return
    const block = raw.slice(0, 2500)

    const link = matchOne(block, /<a[^>]*class="[^"]*inspectTask[^"]*"[^>]*>/i) ||
      matchOne(block, /<a[^>]*class="[^"]*(?:inspect|exam)[^"]*"[^>]*>/i)

    const title = matchOne(block, /<a[^>]*title="([^"]{1,200})"/i) ||
      matchOne(block, /<a[^>]*>\s*([^<>]{2,200}?)\s*<\/a>/i)
    if (!title) return
    const cleanTitle = decodeEntities(title).trim()
    if (/^(做作业|重新编辑|进入考试|查看|详情|确定|取消)$/.test(cleanTitle)) return

    /*
     * 作业 id 有两种写法：
     *   汇编语言 → <a class="inspectTask" data="57451962" ...>   在 data 属性
     *   园林赏析 → <a href="/mooc-ans/work/selectWorkQuestionYiPiYue?...&workId=52762044&...">
     * 考试页则是两者都没有（只有 title），只能靠标题当唯一标识。
     */
    const workId =
      matchOne(block, /\b(?:workId|examId)=(\d{4,20})/i) ||
      matchOne(link || block, /\bdata="(\d{4,20})"/i)

    // 真实跳转链接：href 不是 javascript: 时直接用
    const rawHref = matchOne(block, /<a[^>]*href="([^"]{10,500})"/i)
    let direct = ''
    if (rawHref && !/^javascript:|^#/i.test(rawHref)) {
      direct = /^https?:/i.test(rawHref) ? rawHref : 'https://mooc1.chaoxing.com' + rawHref
    }

    // 作业是「截止时间：」，考试是「考试时间：2026-10-28 10:10 至 2026-10-28 10:25」，取后者
    const deadlineRaw =
      matchOne(block, /截止时间[：:]<\/span>\s*([\d]{4}[-/][\d]{1,2}[-/][\d]{1,2}(?:\s+[\d]{1,2}:[\d]{2})?)/i) ||
      matchOne(block, /考试时间[：:]<\/span>[\s\S]{0,60}?至\s*([\d]{4}[-/][\d]{1,2}[-/][\d]{1,2}\s+[\d]{1,2}:[\d]{2})/i) ||
      matchOne(block, /(\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})/)
    const deadline = parseDate(deadlineRaw)

    // 「待批阅」「已完成」说明已经交上去了；「待做」「未开始」「已过期」算没做完
    const status = statusWordOf(block, isExam)

    const url =
      direct ||
      (workId
        ? isExam
          ? `https://mooc1.chaoxing.com/exam-ans/exam/test?courseId=${course.courseId}&classId=${course.clazzId}&examId=${workId}`
          : `https://mooc1.chaoxing.com/mooc-ans/work/doHomeWorkNew?courseId=${course.courseId}&classId=${course.clazzId}&workId=${workId}`
        : FALLBACK_URL)

    items.push({
      externalId: `${KEY}:${course.courseId}:${isExam ? 'exam' : 'work'}:${workId || cleanTitle}`,
      courseId: course.courseId,
      courseName: course.name,
      title: cleanTitle,
      taskType: isExam ? 'exam' : 'homework',
      deadline,
      status,
      progress: null,
      url
    })
  })

  const seen = new Set()
  const uniq = items.filter((it) => {
    if (seen.has(it.externalId)) return false
    seen.add(it.externalId)
    return true
  })
  // 同一个作业在「未交」「已交」两个区块各出现一次（workId 还不一样），再合一层
  return dedupeWorks(uniq)
}

/**
 * 同一份作业被渲染成两条时合并。
 *
 * 超星作业页把同一个作业分成「未交作业」「已交作业」两个区块各渲染一次，
 * 两处的 workId 还各不相同 —— 按 externalId 去重根本挡不住。结果是数据库里
 * 并存一条「待做」和一条「待批阅」：用户明明交了，首页那条待做永远消不掉，
 * 因为确实还有一条记录在。
 *
 * 按「课程 + 标题 + 截止时间」认同一份，已完成优先。
 * 截止时间不同就不合并 —— 那通常是两份真作业（比如同名的小测 1、小测 1 补考）。
 */
function dedupeWorks(items) {
  const arr = Array.isArray(items) ? items : []
  const DAY = 86400000
  const norm = (s) => String(s || '').replace(/[\s\u3000]+/g, '')
  const near = (a, b) => {
    const x = a || 0
    const y = b || 0
    if (!x || !y) return true
    return Math.abs(x - y) < DAY
  }

  const groups = {}
  const slots = []
  arr.forEach((it, i) => {
    const k = norm(it.courseId) + '|' + norm(it.title)
    const g = groups[k]
    if (g) {
      g.items.push(it)
      return
    }
    const slot = { pos: i, items: [it] }
    groups[k] = slot
    slots.push(slot)
  })
  slots.sort((a, b) => a.pos - b.pos)

  /*
   * 有「已完成」的那条就只留它 —— 同课程同标题下，其余全是超星两个区块的分身，
   * 不看截止时间（两边渲染出来的时间经常对不上，上一版卡时间窗口才没合掉）。
   * 全是未完成时仍卡时间窗口，免得把「小测 1 / 小测 1（补考）」这种同名真作业吞掉。
   */
  const out = []
  slots.forEach((s) => {
    const done = s.items.filter((x) => x.status === 'done')
    if (done.length) {
      out.push(done[0])
      return
    }
    const keep = []
    s.items.forEach((it) => {
      if (!keep.some((k) => near(k.deadline, it.deadline))) keep.push(it)
    })
    keep.forEach((it) => out.push(it))
  })
  return out
}

/** 作业列表 */
async function fetchWorks(jar, course, entry) {
  const url = 'https://mooc1.chaoxing.com/mooc-ans/work/getAllWork?' +
    courseQuery(course, entry) + '&isdisplaytable=2&mooc=1'
  const res = await request(url, {
    jar,
    timeout: 25000,
    headers: { referer: entry.pageUrl }
  })
  if (res.status === 404) throw new Error('作业页 404')
  return parseWorkListHtml(res.text, course, 'work')
}

/** 考试列表 */
async function fetchExams(jar, course, entry) {
  const url = 'https://mooc1.chaoxing.com/exam-ans/exam/test?' + courseQuery(course, entry)
  const res = await request(url, {
    jar,
    timeout: 25000,
    headers: { referer: entry.pageUrl }
  })
  if (res.status === 404) throw new Error('考试页 404')
  const list = parseWorkListHtml(res.text, course, 'exam')
  // 考试页不给每条单独的 id / 链接，退回到课程首页，点进去至少能找到
  list.forEach((t) => {
    if (t.url === FALLBACK_URL) t.url = entry.pageUrl
  })
  return list
}

/** 章节任务点：抓课程目录页，统计每个章节未完成的任务点 */
function parseTaskPointHtml(html, course) {
  const items = []
  if (!html) return items
  // 课程目录页里每个章节通常带「任务点 x/y」或未完成标记
  const re = /<(?:div|li)[^>]*class="[^"]*(?:chapter_item|posCatalog_name)[^"]*"[^>]*>([\s\S]{0,900}?)<\/(?:div|li)>/gi
  let m
  let guard = 0
  while ((m = re.exec(html)) && guard++ < 200) {
    const block = m[1]
    const title = matchOne(block, />\s*([^<>]{3,80}?)\s*</)
    if (!title) continue
    const prog = block.match(/(\d+)\s*\/\s*(\d+)/)
    if (!prog) continue
    const done = +prog[1]
    const total = +prog[2]
    if (total === 0) continue
    items.push({
      externalId: `${KEY}:${course.courseId}:tp:${title}`,
      courseId: course.courseId,
      courseName: course.name,
      title: decodeEntities(title).trim(),
      taskType: 'video',
      deadline: 0,
      status: done >= total ? 'done' : 'todo',
      progress: { done, total },
      url: `https://mooc1.chaoxing.com/mycourse/studentcourse?courseId=${course.courseId}&clazzid=${course.clazzId}`
    })
  }
  return items
}

async function fetchTaskPoints(jar, course) {
  const url = `https://mooc1.chaoxing.com/mycourse/studentcourse?courseId=${course.courseId}&clazzid=${course.clazzId}&pageHeader=0`
  const res = await request(url, { jar, headers: { referer: REFER } })
  return parseTaskPointHtml(res.text, course)
}

/**
 * 抓取明细里标一下这门课有几项待做、几项已经交了。
 * 「已完成 N」这半句很关键：用户说「我交了他怎么还显示未完成」时，
 * 一眼就能看出是平台页面上状态没变，还是我们这边解析漏了。
 */
function statusCount(list) {
  const l = list || []
  if (!l.length) return ''
  const done = l.filter((t) => t.status === 'done').length
  const todo = l.length - done
  if (!done) return `（待做 ${todo}）`
  return `（已完成 ${done}${todo ? ' / 待做 ' + todo : ''}）`
}

/** 章节（按章汇总）→ 任务条目 */
function chapterToTask(c, course, entry) {
  const label = c.title || c.no || '章节任务点'
  return {
    externalId: 'chaoxing:' + course.courseId + ':chapter:' + (c.no || c.chapterId),
    courseId: String(course.courseId),
    courseName: course.name,
    title: label + '（' + c.unfinished + ' 个任务点未完成）',
    taskType: 'chapter',
    deadline: 0,
    status: 'todo',
    progress: null,
    url:
      'https://mooc1.chaoxing.com/mooc-ans/mycourse/studentstudy?chapterId=' + c.chapterId +
      '&courseId=' + course.courseId + '&clazzid=' + course.clazzId +
      (entry && entry.enc ? '&enc=' + entry.enc : '')
  }
}

/** 合并相邻的重复项，避免报错里出现一长串一样的话 */
function compactTrace(items) {
  const out = []
  items.forEach((t) => {
    const last = out[out.length - 1]
    if (last && last.text === t) last.n++
    else out.push({ text: t, n: 1 })
  })
  return out.map((x) => (x.n > 1 ? x.text + '×' + x.n : x.text)).join('；')
}

/**
 * @param {object} account 凭据
 * @param {object} [options] { limit } 最多抓几门课，默认 25。
 *   本地代理传小一点，避免小程序请求超时（wx.request 单次最长 60 秒）。
 */
async function sync(account, options) {
  const limit = Math.max(1, Math.min(60, Number((options && options.limit) || 25)))
  // 章节任务点没有截止时间，量可能很大；默认抓，options.chapters === false 可关掉
  const wantChapters = !options || options.chapters !== false
  const debug = []
  const trace = []
  const jar0 = await buildJar(account)
  const full = jar0.header()

  // 两套 cookie 各试一次：完整版优先，失败再试去掉会话号的版本
  const variants = [{ label: '完整', cookie: full }]
  const slim = slimCookie(full)
  if (slim && slim !== full && /(^|;)\s*_uid=/.test('; ' + slim)) {
    variants.push({ label: '精简', cookie: slim })
  }

  let courses = null
  let jar = jar0
  for (let i = 0; i < variants.length; i++) {
    const j = i === 0 ? jar0 : new CookieJar(variants[i].cookie)
    debug.push(`试${variants[i].label} Cookie`)
    if (i > 0) trace.push('[换' + variants[i].label + ' Cookie 再试]')
    const got = await fetchCourses(j, trace, i > 0)
    if (got && got.length) {
      courses = got
      jar = j
      debug.push(`${variants[i].label} Cookie 成功，课程数 ${got.length}`)
      break
    }
  }

  if (!courses || !courses.length) {
    throw new Error('读取课程失败（Cookie 字段：' + cookieKeys(jar0) + '）｜' + compactTrace(trace))
  }

  const tasks = []
  const errors = []
  const seenIds = new Set()
  courses = courses.filter((c) => {
    if (seenIds.has(c.courseId)) return false
    seenIds.add(c.courseId)
    return true
  })

  // 串行，避免触发风控
  for (const course of courses.slice(0, limit)) {
    // 每门课先换一次 enc/openc，作业和考试都要用
    let entry = null
    try {
      entry = await fetchCourseEntry(jar, course)
    } catch (e) {
      errors.push(`${course.name} 进不去（${e.message}）`)
      debug.push(`${course.name}: 课程页失败 ${e.message}`)
      continue
    }

    try {
      const works = await fetchWorks(jar, course, entry)
      tasks.push.apply(tasks, works)
      debug.push(`${course.name}: 作业 ${works.length}${statusCount(works)}`)
    } catch (e) {
      errors.push(`${course.name} 作业读取失败（${e.message}）`)
      debug.push(`${course.name}: 作业 失败 ${e.message}`)
    }

    try {
      const exams = await fetchExams(jar, course, entry)
      tasks.push.apply(tasks, exams)
      if (exams.length) debug.push(`${course.name}: 考试 ${exams.length}${statusCount(exams)}`)
    } catch (e) {
      errors.push(`${course.name} 考试读取失败（${e.message}）`)
      debug.push(`${course.name}: 考试 失败 ${e.message}`)
    }

    // 章节任务点：直接复用课程目录页，不用额外请求
    if (wantChapters) {
      try {
        const units = parseChapterHtml(entry.html, course)
        const items = units.slice(0, 12).map((c) => chapterToTask(c, course, entry))
        tasks.push.apply(tasks, items)
        if (units.length) {
          debug.push(
            `${course.name}: 有任务点的章 ${units.length} 个` +
              (units.length > 12 ? '（只取前 12）' : '')
          )
        }
      } catch (e) {
        errors.push(`${course.name} 章节任务点读取失败（${e.message}）`)
      }
    }
  }

  if (!tasks.length) {
    throw new Error(
      '读到 ' + courses.length + ' 门课，但没有作业或考试。' +
        (errors.length ? '（' + errors[0] + '）' : '可能这学期确实没有线上作业')
    )
  }

  // 给每条任务标上「属于哪个学期」，首页默认只看本学期，上学期的一键藏起来
  const byId = {}
  courses.forEach((c) => {
    byId[String(c.courseId)] = c
  })
  const semCount = {}
  tasks.forEach((t) => {
    const c = byId[String(t.courseId)]
    const sem = semester.ofCourse(c || { name: t.courseName })
    t.semesterKey = sem.key
    t.semesterLabel = sem.label
    t.semesterShort = sem.short
    t.semesterRank = sem.rank
    t.courseRetired = !!(c && c.retired)
    semCount[sem.short] = (semCount[sem.short] || 0) + 1
  })
  const nowSem = semester.current()
  const oldCourses = courses.filter((c) => {
    const sem = semester.ofCourse(c)
    return sem.key !== nowSem.key
  })
  if (oldCourses.length) {
    debug.push(
      '非本学期课程 ' + oldCourses.length + ' 门：' +
        oldCourses.map((c) => c.name + '（' + semester.ofCourse(c).short + '）').join('、')
    )
  }
  debug.push(
    '学期分布：' +
      Object.keys(semCount)
        .map((k) => k + ' ' + semCount[k] + ' 项')
        .join('，')
  )

  return { tasks, debug, errors }
}

/**
 * 诊断用：把作业列表页里每一行的「状态」原文抓出来。
 *
 * 用户在平台上交了作业、同步后却还是未完成时，光看解析结果是分不清
 * 「平台页面本来就写着待做」和「平台写了已完成但我们没认出来」的。
 * 这里把平台原文原样带回来，一眼就能判断该补词表还是该改页面结构。
 *
 * 只抓前几门课，故意不做缓存、不写库。
 */
function workRows(html, course) {
  const rows = []
  String(html || '')
    .split(/<div[^>]*class="titTxt"/i)
    .forEach((raw, idx) => {
      if (idx === 0) return
      const block = raw.slice(0, 2500)
      const title =
        matchOne(block, /<a[^>]*title="([^"]{1,200})"/i) ||
        matchOne(block, /<a[^>]*>\s*([^<>]{2,80}?)\s*<\/a>/i)
      if (!title) return
      const seg = matchOne(block, /(?:作业|考试)状态[：:]?\s*(?:<\/span>)?([\s\S]{0,140})/i)
      rows.push({
        title: decodeEntities(title).trim().slice(0, 40),
        // 平台原文（剥掉标签后截 24 字）：这才是「它到底怎么写的」的证据
        raw: plainText(seg).slice(0, 24),
        status: statusWordOf(block, false)
      })
    })
  // 诊断里也要合，否则用户会看到两行同名、一行待做一行已完成，比不诊断还困惑
  return dedupeWorks(rows).slice(0, 15)
}

async function diagnose(account, options) {
  const maxCourses = Math.max(1, Math.min(5, Number((options && options.courses) || 2)))
  const out = { courseCount: 0, courses: [], error: '' }

  let jar = null
  try {
    jar = await buildJar(account)
  } catch (e) {
    out.error = '凭据读取失败：' + (e.message || String(e))
    return out
  }

  const trace = []
  let courses = null
  try {
    courses = await fetchCourses(jar, trace, false)
  } catch (e) {
    out.error = e.message || String(e)
  }
  if (!courses || !courses.length) {
    out.error = out.error || '读不到课程列表（可能是登录态过期）'
    out.trace = compactTrace(trace)
    return out
  }

  out.courseCount = courses.length
  for (const course of courses.slice(0, maxCourses)) {
    let entry = null
    try {
      entry = await fetchCourseEntry(jar, course)
    } catch (e) {
      out.courses.push({ name: course.name, error: '进不去课程页：' + (e.message || e) })
      continue
    }
    try {
      const url =
        'https://mooc1.chaoxing.com/mooc-ans/work/getAllWork?' +
        courseQuery(course, entry) +
        '&isdisplaytable=2&mooc=1'
      const res = await request(url, {
        jar,
        timeout: 25000,
        headers: { referer: entry.pageUrl }
      })
      const html = res.text || ''
      const rows = await workRows(html, course)
      out.courses.push({
        name: course.name,
        http: res.status,
        bytes: html.length,
        rows: rows,
        // 一个状态都没抓到：八成是页面结构变了，把关键片段带回去当证据
        hint: rows.length && !rows.some((r) => r.raw) ? plainText(html).slice(0, 200) : ''
      })
    } catch (e) {
      out.courses.push({ name: course.name, error: '作业页失败：' + (e.message || e) })
    }
  }
  return out
}

module.exports = {
  key: KEY,
  name: NAME,
  sync,
  diagnose,
  // 供本地测试使用
  _internal: {
    parseWorkHtml,
    parseWorkListHtml,
    parseTaskPointHtml,
    parseChapterHtml,
    chapterToTask,
    parseCourseListHtml,
    pickFromApiData,
    slimCookie,
    courseQuery,
    aesEncryptPassword,
    fetchCourses,
    fetchCourseEntry,
    statusWordOf,
    statusCount,
    plainText,
    workRows,
    dedupeWorks
  }
}
