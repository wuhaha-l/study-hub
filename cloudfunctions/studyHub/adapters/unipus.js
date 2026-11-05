/**
 * U校园（外研社 UniPus）适配器 —— 2026-10 按「AI 版 5.0」真实接口重写
 *
 * 为什么重写：老版适配器猜的 /api/user/info、/api/course/list 这批路径在
 * U校园里根本不存在，一个都打不中，所以「登录成功却拉不到任务」。
 * 现在这套路径来自对开源项目（UnipusHelperPro / AutoUnipus）的逆向核对，
 * 是 uai.unipus.cn 真实在用的内部接口。
 *
 * AI 版 5.0 接口（全部 cookie 鉴权，返回 {code:1,...} 为成功）：
 *   GET  https://uai.unipus.cn/api/account/user/info
 *          value.userInfo = {ssoId, name, code(学号), appUserId, schName}
 *   GET  https://uai.unipus.cn/api/cmgt/course/getCourseListByStudent
 *          value.courseList[] = {id, name, classId, startTime, endTime,
 *            courseResourceList[] = {id, instanceId, strategyId, name,
 *                                    finishPointNum, totalPointNum}}
 *   POST https://uai.unipus.cn/api/tla/courseStudyStrategy/detail
 *          body {id: strategyId, courseResourceId}
 *          value.courseUnitStrategyList[] = {unitId, caption, unitName,
 *            requiredTask[], studyStartTime, studyEndTime, sort}
 *          value.courseInfo = {term, startTime, endTime, className, ...}
 *   GET  https://uai.unipus.cn/api/tla/learningDetail/studyRecord/
 *        totalAndUnitSituation?id={课程id}&appUserId={appUserId}
 *          value.unitList[] = {nodeId, caption, name, finishProgress, required, role}
 *
 * 任务粒度：**只显示老师打了星号（必修）或给分（scoreTaskFlag）的任务** ——
 * 单元策略的 requiredTask 清单 / 叶子 required=true 算星号，叶子上
 * scoreTaskFlag=true 的「其他类型」（作业/测验等）也收；老师没点星的单元整个隐藏。
 * 课程级规则（COURSE_TASK_RULES）优先级更高：命中的课（如新文科英语只做 Test）
 * 扫全部单元、只显示名字匹配的叶子，星号的视频听力等一律不要。
 * 展示层级：书名进课程名（班·书），标题 = 单元 · 中间层级 · 具体部分，
 * 一眼看出「哪本书哪个章节哪个部分」。
 * 截止时间取单元的 studyEndTime（老师设的学习截止），完成度精确到任务本身。
 * externalId 用 instanceId 区分同班的不同教材。
 *
 * 登录态说明：
 *   - Cookie 必须带 sso.unipus.cn 的统一认证会话（扫码 / 浏览器整串复制都有）。
 *     uai.unipus.cn 自己没有会话时，先 GET 一次 /home 让 SSO 发一份。
 *   - 密码模式走 POST https://sso.unipus.cn/sso/0.1/sso/login（JSON 明文），
 *     不走网页表单那套动态 RSA（README 里说密码走不通指的是网页表单）。
 */
const { CookieJar, request, parseDate } = require('../lib/http')
const semester = require('../lib/semester')

const KEY = 'unipus'
const NAME = 'U校园'
const SSO = 'https://sso.unipus.cn'
const UAI = 'https://uai.unipus.cn'

const MAX_COURSES = 8
const MAX_RESOURCES = 2
// 有星号任务的单元才逐个拉任务树；设上限防止老师全册点星时请求数失控
const MAX_UNITS = 10

/**
 * 课程级任务规则：某些课老师只要求做其中一部分。
 *   course 匹配课程名；leaf 匹配叶子任务的完整路径（单元名 + 层级 + 任务名）。
 *   命中的课不用星号门槛（扫全部单元），只显示 leaf 命中的任务，其他全隐藏。
 *   不命中 leaf 的叶子归「选做（不用做）」，命中 leaf 的归「必做（标红）」。
 */
const COURSE_TASK_RULES = [
  // 新文科大学英语：老师只要求做 Unit Test，其他（视频/听力等）都不用做
  { course: /新文科/, leaf: /unit\s*test/i },
  // 视听说（视听说教程）：只做 Unit Test 和 Further Listening
  { course: /视听说/, leaf: /unit\s*test|further\s*listening/i }
]

function pick(obj, keys, dft) {
  for (let i = 0; i < keys.length; i++) {
    const v = obj[keys[i]]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return dft
}

function tryParse(text) {
  try {
    return JSON.parse(text)
  } catch (e) {
    return null
  }
}

/** 秒 / 毫秒时间戳统一成毫秒 */
function toMs(v) {
  const n = Number(v)
  if (!n || isNaN(n)) return 0
  return n > 1e12 ? n : n * 1000
}

function brief(text) {
  return String(text || '').replace(/\s+/g, ' ').slice(0, 80)
}

/* ------------------------------------------------------------------ */
/* 登录                                                                */
/* ------------------------------------------------------------------ */

async function buildJar(account, debug) {
  if (account.mode === 'cookie') {
    const jar = new CookieJar(account.cookie)
    if (!jar.size()) throw new Error('Cookie 为空，请重新复制')
    return jar
  }

  // 密码模式：SSO 的 JSON 登录接口收明文（和网页表单是两套）。
  // 失败大概率是触发滑块/风控，提示改扫码。
  const jar = new CookieJar()
  const res = await request(SSO + '/sso/0.1/sso/login', {
    method: 'POST',
    body: JSON.stringify({
      username: account.username,
      password: account.password,
      remember: true,
      agreement: true,
      service: UAI + '/home'
    }),
    jar,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      accept: 'application/json, text/javascript, */*; q=0.01',
      referer: SSO + '/sso/login?service=' + encodeURIComponent(UAI + '/home'),
      origin: SSO
    },
    maxRedirect: 2
  }).catch(() => null)

  const j = res && tryParse(res.text)
  if (!j || String(j.code) !== '0' || !j.rs) {
    throw new Error(
      'U校园 账号或密码不对（' + (j && j.msg ? brief(j.msg) : '接口无返回') + '）。' +
        '反复失败多半触发了滑块验证，改用扫码登录或 Cookie 模式'
    )
  }
  debug.push('密码登录成功')
  return jar
}

/** uai 域没有会话时，带着 SSO 会话进一次首页，让 uai 种上自己的 cookie */
async function warmUai(jar, debug) {
  let landed = ''
  try {
    const r = await request(UAI + '/home', { jar, maxRedirect: 8, headers: { referer: UAI + '/' } })
    landed = String(r.url || '')
  } catch (e) {
    landed = ''
    debug.push('进 uai 首页失败：' + brief(e.message))
    return false
  }
  debug.push('uai 落点 ' + brief(landed))
  // 被留在登录页 = SSO 会话没了，后面接口必然全 401，提前说清楚
  if (/sso\.unipus\.cn\/sso\/login/.test(landed)) return false
  return true
}

/** 调一个 uai 的 JSON 接口；非 JSON / HTTP 错误返回 null */
async function uaiGet(jar, path) {
  const res = await request(UAI + path, {
    jar,
    headers: {
      accept: 'application/json, text/plain, */*',
      referer: UAI + '/home'
    }
  })
  if (res.status >= 400) return null
  return tryParse(res.text)
}

async function uaiPost(jar, path, payload) {
  const res = await request(UAI + path, {
    method: 'POST',
    body: JSON.stringify(payload),
    jar,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      accept: 'application/json, text/plain, */*',
      referer: UAI + '/home'
    }
  })
  if (res.status >= 400) return null
  return tryParse(res.text)
}

/**
 * 从单元任务树里挑出要显示的叶子任务。keep(leaf, path) 决定去留：
 *   - 默认（星号 + 给分）：required/requiredTask/scoreTaskFlag 任一命中
 *   - 规则课：路径匹配课程规则的叶子
 * 同时把从单元到叶子之间的层级名带出来（section/node 名），用于拼标题。
 * 根节点是单元自己（名字已在单元标题里），不算进层级。
 */
function collectLeaves(node, isRoot, chain, out, keep) {
  if (!node || typeof node !== 'object') return
  const name = String(node.name || '').trim()
  const kids = Array.isArray(node.children) ? node.children : []
  // 粒度就停在「Unit Test / Further Listening / Prepare」这一层：
  // role=group（新版）/ link（旧版）就是任务组这一层，即使它下面还有 children
  // 也不再往下钻——再细就是具体小题了，用户不需要。
  const isTaskGroup = !isRoot && (node.role === 'group' || node.role === 'link')
  if (!kids.length || isTaskGroup) {
    const isTask = !isRoot && node.role !== 'unit'
    if (!isTask) return
    const path = chain.concat(name ? [name] : []).join(' ')
    if (keep(node, path)) out.push({ leaf: node, chain })
    return
  }
  const nextChain = isRoot ? chain : name ? chain.concat([name]) : chain
  kids.forEach((k) => collectLeaves(k, false, nextChain, out, keep))
}

/** 层级名去重：连续同名只留一个（树上常见「节点名=子节点名」的套娃） */
function dedupeChain(arr) {
  const out = []
  arr.forEach((n) => {
    if (!out.length || out[out.length - 1] !== n) out.push(n)
  })
  return out
}

/** 课程名带上书名：一个班可能挂多本教材，按书分开才看得出任务属于哪本 */
function courseLabelOf(cname, resName) {
  const c = String(cname || '').trim()
  const r = String(resName || '').trim()
  if (!r || r === c || c.indexOf(r) > -1 || r.indexOf(c) > -1) return c
  return c + '·' + r
}

/* ------------------------------------------------------------------ */
/* 同步                                                                */
/* ------------------------------------------------------------------ */

async function sync(account) {
  const debug = []
  // 诊断只打一次：第一个解析出叶子的单元，把真实字段分布放进 debug。
  // 任务数异常（被上层拒写）时，这段就是唯一能看清接口真实结构的线索。
  let diagDone = false
  const jar = await buildJar(account, debug)

  const warm = await warmUai(jar, debug)
  if (!warm) {
    throw new Error(
      'Cookie 里的统一认证登录态（sso.unipus.cn）已失效。' +
        '重新扫码一次，或从浏览器复制带 sso.unipus.cn 域的完整 Cookie'
    )
  }

  // 1. 用户信息 = 登录态检查 + 拿 appUserId（后面查进度要用）
  const me = await uaiGet(jar, '/api/account/user/info')
  const user = me && me.value && me.value.userInfo
  if (!me || me.code !== 1 || !user || !user.appUserId) {
    throw new Error(
      'Cookie 无效或已过期（用户信息接口不认，返回：' + (me ? brief(JSON.stringify(me)) : '非 JSON') + '）'
    )
  }
  debug.push('用户 ' + (user.name || '') + (user.schName ? ' · ' + user.schName : ''))

  // 2. 课程列表
  const list = await uaiGet(jar, '/api/cmgt/course/getCourseListByStudent')
  const courses = (list && list.value && list.value.courseList) || []
  debug.push('课程数 ' + courses.length)
  if (!courses.length) {
    throw new Error('接口通了但没有读到课程，请确认这门学期确实在用 U校园')
  }

  // 3. 每门课 → 每本教材：单元策略（含截止）+ 单元完成度
  const tasks = []
  for (const course of courses.slice(0, MAX_COURSES)) {
    const courseId = pick(course, ['id'], '')
    const cname = String(pick(course, ['name'], '未命名课程'))
    if (!courseId) continue
    const resources = Array.isArray(course.courseResourceList) ? course.courseResourceList : []
    if (!resources.length) {
      debug.push(cname + '：没有教材资源，跳过')
      continue
    }

    for (const res0 of resources.slice(0, MAX_RESOURCES)) {
      const instanceId = String(pick(res0, ['instanceId', 'resourceId'], ''))
      const strategyId = pick(res0, ['strategyId'], '')
      const resName = String(pick(res0, ['name'], ''))
      if (!instanceId || !strategyId) continue
      // 任务归属到「班·书」：书名进 courseName，任务标题里就只剩单元和部分
      const courseLabel = courseLabelOf(cname, resName)

      // 3a. 单元策略：unitId / 单元名 / 学习起止（学习截止就是交作业的线）
      const st = await uaiPost(jar, '/api/tla/courseStudyStrategy/detail', {
        id: Number(strategyId) || strategyId,
        courseResourceId: String(pick(res0, ['id'], ''))
      })
      const units = (st && st.value && st.value.courseUnitStrategyList) || []
      const courseInfo = (st && st.value && st.value.courseInfo) || {}
      if (!units.length) {
        debug.push(cname + '·' + resName + '：没读到单元策略')
        continue
      }

      // 3b. 单元策略里的 requiredTask = 老师打了星号的必做任务清单
      //     （U校园学生端带 ★ 的就是它）。必做（标星）与选做（没标）都要展示：
      //     必做未完成的标红「必做」，选做的归「不用做」分组。
      //     规则课（COURSE_TASK_RULES 命中）只认 leaf 正则命中的叶子为必做。
      //     规则匹配「课程名 + 书名」——因为「视听说」「读写」这类关键词
      //     经常只出现在书名（resName）里，课程名（cname）反而只有「大英1」这种。
      const rule = COURSE_TASK_RULES.find(
        (r) => r.course.test(cname) || r.course.test(resName)
      )

      // 3c. 单元完成度（0~100，给「树没解析出来」的保底路径用）
      //     同样传教材资源 id（res0.id），和 unitTaskSituation 保持一致。
      const prog = await uaiGet(
        jar,
        '/api/tla/learningDetail/studyRecord/totalAndUnitSituation?id=' +
          encodeURIComponent(String(pick(res0, ['id'], ''))) +
          '&appUserId=' + encodeURIComponent(user.appUserId)
      )
      const unitList = (prog && prog.value && prog.value.unitList) || []
      const progByNode = {}
      unitList.forEach((u) => {
        if (u && u.nodeId) progByNode[String(u.nodeId)] = u
      })

      // 整课完成度兜底（单元进度缺失时用）
      const fin = Number(pick(res0, ['finishPointNum'], -1))
      const tot = Number(pick(res0, ['totalPointNum'], 0))
      const courseDone = tot > 0 && fin >= tot

      const startMs = toMs(pick(courseInfo, ['startTime'], '')) || toMs(pick(course, ['startTime'], ''))
      // 学期判定：教材自己的 term（形如「2026秋」）最准，其次课程/教材开始时间，
      // 最后才从课程名里猜。往期教材过滤完全依赖这个结果，宁可多认几种写法。
      const sem =
        semester.fromName(String(pick(courseInfo, ['term'], ''))) ||
        semester.ofCourse({ startMs, name: cname })

      // 往期教材不参与：U校园账号里通常挂着前几个学期上过的课（每门课还有 2 本
      // 教材、每本 10 个单元），全收进来任务数会凭空翻好几倍（实测 108 条）。
      // 用户这学期只用两本书，往期的一个都不需要。学期判断不出来的（rank=0，
      // 比如课程名没带学期字样）保守保留，宁多勿漏。
      const curSem = semester.current()
      if (sem.rank > 0 && curSem && curSem.rank > 0 && sem.rank < curSem.rank) {
        debug.push(`${cname}·${resName}：往期教材（${sem.short}），跳过`)
        continue
      }

      let n = 0
      let requiredCount = 0
      let optionalCount = 0
      // 扫全部单元：标星的是必做、没标星的是选做（进「不用做」分组）
      const scanUnits = units.slice(0, MAX_UNITS)
      for (const u of scanUnits) {
        const unitId = String(pick(u, ['unitId', 'nodeId'], ''))
        const unitTitle = [u.caption, u.unitName].filter(Boolean).join(' ').trim()
        if (!unitId || !unitTitle) continue
        const requiredIds = new Set((u.requiredTask || []).map(String))
        const deadline = toMs(pick(u, ['studyEndTime'], '')) || parseDate(pick(u, ['studyEndTime'], ''))
        const tagAndPush = (t) => {
          t.semesterKey = sem.key
          t.semesterLabel = sem.label
          t.semesterShort = sem.short
          t.semesterRank = sem.rank
          tasks.push(t)
          n++
          if (t.required) requiredCount++
          else if (t.optional) optionalCount++
        }

        // 3d. 单元任务树：把打了星 / 老师给分 / 规则命中的叶子任务精确挑出来（带层级名）
        //     注意：这个接口的 id 参数要传「教材资源 id」（res0.id，和
        //     courseStudyStrategy/detail 的 courseResourceId 一致），
        //     传课程 id 会报 "CourseStudyStrategy not exist"。
        const tree = await uaiGet(
          jar,
          '/api/tla/learningDetail/studyRecord/unitTaskSituation?nodeId=' +
            encodeURIComponent(unitId) +
            '&id=' + encodeURIComponent(String(pick(res0, ['id'], ''))) +
            '&appUserId=' + encodeURIComponent(user.appUserId) +
            '&ssoId=' + encodeURIComponent(pick(user, ['ssoId'], ''))
        )
        const roots = (tree && tree.value && Array.isArray(tree.value.list)) ? tree.value.list : []
        const hits = []
        // 收集单元里全部叶子：必做（星号/给分/规则命中）和选做（没标的）都要，
        // 选做单独进「不用做」分组，不再整个隐藏。
        roots.forEach((root) => collectLeaves(root, true, [], hits, () => true))

        // 【诊断】把叶子节点的真实字段分布打一次进 debug。
        // 过滤规则（role / tabType）完全依赖字段名，字段名一旦对不上就静默失效，
        // 任务数会照旧爆炸。这段输出就是验证字段名到底叫什么的唯一可靠依据。
        if (hits.length && !diagDone) {
          diagDone = true
          const roleStat = {}
          const tabStat = {}
          hits.forEach(({ leaf }) => {
            const r = String(leaf.role)
            const t = String(leaf.tabType)
            roleStat[r] = (roleStat[r] || 0) + 1
            tabStat[t] = (tabStat[t] || 0) + 1
          })
          debug.push('【诊断】叶子 role 分布 ' + JSON.stringify(roleStat))
          debug.push('【诊断】叶子 tabType 分布 ' + JSON.stringify(tabStat))
          debug.push('【诊断】叶子字段名 ' + Object.keys(hits[0].leaf).sort().join(','))
          debug.push('【诊断】叶子样例 ' + JSON.stringify(hits[0].leaf).slice(0, 260))
        }

        if (!hits.length) {
          // 树没解析出来（结构变了/接口挂了）：保底显示单元本身，星号任务不能凭空消失。
          // 规则课也一样要保底——否则没解析出来的单元（里面的 Unit Test）会整块消失，
          // 用户会以为这些单元没任务而漏做。这里只保底「未完成的单元」。
          const pu = progByNode[unitId]
          const fpRaw = pu ? Number(pu.finishProgress) : NaN
          const done = courseDone || (!isNaN(fpRaw) && fpRaw >= 100)
          if (done) continue // 保底的单元也全做完了 → 不占列表
          tagAndPush({
            externalId: `${KEY}:${instanceId}:${unitId}`,
            courseId: String(courseId),
            courseName: courseLabel,
            title: unitTitle,
            taskType: 'practice',
            deadline,
            status: 'todo',
            progress: !isNaN(fpRaw) ? { done: Math.round(fpRaw), total: 100 } : null,
            url: UAI + '/home'
          })
          continue
        }

        // ── 只保留 Unit Test / Further Listening 这一层 ──
        //
        // 真实接口把 Further Listening / Unit Test 下面的每个细分小题
        // （Conversation 1、Part A、Passage 2…）都单独返回成一个 role=group
        // 的叶子，实测一个单元 44 条。全收进来整册上千条，首页直接撑爆 1MB。
        // 用户要的是「这一项做了没」，不是每个小题一行，所以只显示这两类。
        //
        // 显示范围：
        //   - 规则课（新文科 / 视听说）：只显示规则指定那几类
        //     （新文科 = Unit Test，视听说 = Unit Test + Further Listening）
        //   - 其他课：统一只显示 Unit Test / Further Listening
        const SHOW_LEAF = rule ? rule.leaf : /unit\s*test|further\s*listening/i

        // 判断一片叶子属于哪一类目标项：
        //   'ut' = Unit Test，'fl' = Further Listening，'' = 不是目标项
        // 先看叶子自己的名字；名字不含就看它的层级路径（目标项是中间层时，
        // 下面的细分小题名字叫 Conversation 1 / Part A，但路径里带着 Further Listening）。
        // 注意：不能用接口返回的 leaf.path —— 那串只有 id（u1/u1g27/u1g364），
        // 不含名字，拿它匹配等于永远匹配不上。
        const kindOf = (name, pathWithNames) => {
          const n = String(name || '').trim()
          const p = String(pathWithNames || '')
          const hay = SHOW_LEAF.test(n) ? n : SHOW_LEAF.test(p) ? p : ''
          if (!hay) return ''
          if (/unit\s*test/i.test(hay)) return 'ut'
          if (/further\s*listening/i.test(hay)) return 'fl'
          return ''
        }

        // 目标项的规范名和识别用正则。列表里一条代表的是「整项」，
        // 不是某一小题，所以标题一律用规范名：
        //   Further Listening > Conversation 1  → Further Listening
        //   Unit Test > Part B                   → Unit Test
        //   Further Listening 3                  → Further Listening
        const KIND_LABEL = { ut: 'Unit Test', fl: 'Further Listening' }
        const KIND_RE = { ut: /unit\s*test/i, fl: /further\s*listening/i }

        // 先把每片叶子的「显示路径 + 类型」算出来（后面两轮都要用）
        const items = hits.map(({ leaf, chain }) => {
          const leafName = String(leaf.name || '').trim()
          const segs = dedupeChain(chain.concat(leafName ? [leafName] : []))
          const kind = kindOf(leafName, segs.join(' > '))
          if (!kind) return { leaf, leafName, shown: segs.join(' > '), kind: '' }
          // 路径截断到目标项这一层，最后一段换成规范名——
          // 否则标题会挂着某一小题的名字，看起来像「只指向一项」。
          const at = segs.findIndex((s) => KIND_RE[kind].test(s))
          const head = at >= 0 ? segs.slice(0, at) : segs.slice(0, -1)
          const shown = head.concat([KIND_LABEL[kind]]).join(' > ')
          return { leaf, leafName, shown, kind }
        })

        // 这一项算不算「必做」——按类型整体看，只要有一片叶子带星 / 给分就算。
        // 规则课（新文科 / 视听说）目标项一律必做（老师明确只做这几类）。
        const kindIsRequired = {}
        items.forEach(({ leaf, kind }) => {
          if (!kind) return
          const r =
            rule ||
            leaf.required === true ||
            requiredIds.has(String(leaf.nodeId || '')) ||
            leaf.scoreTaskFlag === true
          if (r) kindIsRequired[kind] = true
        })

        // ── 每个单元每种类型只留一条 ──
        // 之前按「名字」去重是错的：Conversation 1 和 Passage 2 名字不同，
        // 会被当成两条，一个单元能冒出七八条（实测整册 108 条）。
        // 现在按类型硬去重：一个单元最多 1 条 Unit Test + 1 条 Further Listening。
        const seenKind = new Set()
        const beforeUnit = tasks.length
        items.forEach(({ leaf, shown, kind }) => {
          if (!kind) return // 不是 Unit Test / Further Listening → 不显示
          if (seenKind.has(kind)) return // 同单元同类型已有代表 → 细分小题丢弃
          seenKind.add(kind)

          const fpRaw = Number(leaf.finishProgress)
          const done = courseDone || (!isNaN(fpRaw) && fpRaw >= 100)
          if (done) return // 这一项做完了 → 不占列表

          const req = !!kindIsRequired[kind]
          const path = shown

          tagAndPush({
            // 用「单元 + 类型」做稳定 id：一条代表整项，不该跟着某一小题的
            // nodeId 变化，否则每次同步 id 都可能变。
            externalId: `${KEY}:${instanceId}:${unitId}-${kind}`,
            courseId: String(courseId),
            courseName: courseLabel,
            title: String(path ? unitTitle + ' · ' + path : unitTitle).slice(0, 118),
            taskType: 'practice',
            deadline,
            status: 'todo',
            required: req,
            optional: !req,
            progress: !isNaN(fpRaw) ? { done: Math.round(fpRaw), total: 100 } : null,
            url: UAI + '/home'
          })
        })

        // 兜底：这个单元根本没有 Unit Test / Further Listening（树里一条都没命中）。
        // 不能让它整块消失——用户会以为这些单元没作业而漏做。
        // 注意：如果命中了但都已完成（seenKind 非空），说明作业做完了，
        // 不该再冒出一条单元级的"待做"，所以那种情况不兜底。
        if (tasks.length === beforeUnit && seenKind.size === 0) {
          const pu = progByNode[unitId]
          const fpRaw = pu ? Number(pu.finishProgress) : NaN
          const done = courseDone || (!isNaN(fpRaw) && fpRaw >= 100)
          if (!done) {
            tagAndPush({
              externalId: `${KEY}:${instanceId}:${unitId}`,
              courseId: String(courseId),
              courseName: courseLabel,
              title: unitTitle,
              taskType: 'practice',
              deadline,
              status: 'todo',
              progress: !isNaN(fpRaw) ? { done: Math.round(fpRaw), total: 100 } : null,
              url: UAI + '/home'
            })
          }
        }
      }

      debug.push(
        `${cname}·${resName}: 必做（红）${requiredCount}、选做（不用做）${optionalCount}、共 ${n} 条`
      )
    }
  }

  if (!tasks.length) {
    throw new Error(
      '读到 ' + courses.length + ' 门课，但没有读到任何单元任务。' +
        '这通常是单元任务树接口没返回数据；如果 U校园里确实有该做的任务，把 debug 信息发我看下'
    )
  }
  return { tasks, debug }
}

module.exports = { key: KEY, name: NAME, sync }
