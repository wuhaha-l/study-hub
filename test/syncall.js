/**
 * 首页「同步全部课程和任务」—— 三个平台真的一起更新
 *
 * 之前这颗按钮只调云端 handleSync，而云端会把 mode=intranet 的希冀直接过滤掉，
 * 所以对希冀完全空转。现在改成：本机直连抓希冀 + 云端抓学习通/U校园，并发合成一张表。
 * 这里不碰网络，注入假的 api / edu 校验合成规则。
 */
const S = require('../miniprogram/utils/syncall.js')

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + (extra === undefined ? '' : '  →  ' + JSON.stringify(extra)))
  }
}
function eq(name, a, b) {
  ok(name + '（期望 ' + JSON.stringify(b) + '）', JSON.stringify(a) === JSON.stringify(b), a)
}

/** 假的云端：返回 details，或者整体报错 */
function fakeApi(cloud) {
  return {
    sync() {
      return cloud.error ? Promise.reject(new Error(cloud.error)) : Promise.resolve(cloud.res)
    }
  }
}

/** 假的希冀：cookie 有没有、抓取成功还是失败 */
function fakeEdu(opt) {
  const o = opt || {}
  return {
    getCfg() {
      return { cookie: o.cookie === false ? '' : 'SESSION=abc' }
    },
    syncAndPush() {
      if (o.error) return Promise.reject(new Error(o.error))
      return Promise.resolve(o.res || { count: 0, tasks: [], submitted: 0 })
    }
  }
}

const ACC_ALL = [
  { platform: 'chaoxing', mode: 'cookie' },
  { platform: 'educoder', mode: 'intranet' },
  { platform: 'unipus', mode: 'cookie' }
]

async function main() {
  console.log('\n[1] 三个平台：希冀走本机、另两个走云端，合成一张表')
  {
    const r = await S.syncAll({
      accounts: ACC_ALL,
      api: fakeApi({
        res: {
          count: 16,
          details: [
            { platform: 'chaoxing', count: 12, debug: ['汇编语言·作业: 必做 4、共 4 条'] },
            { platform: 'unipus', count: 4, debug: ['视听说·第一册: 必做（红）2、选做（不用做）1、共 4 条'] }
          ],
          srvVer: '20261027.5'
        }
      }),
      edu: fakeEdu({
        res: {
          count: 10,
          submitted: 3,
          tasks: [{ courseName: '离散数学' }, { courseName: '汇编语言' }]
        }
      })
    })
    eq('三行都在', r.rows.map((x) => x.platform), ['chaoxing', 'educoder', 'unipus'])
    eq('学习通 12 条', r.rows[0].count, 12)
    eq('希冀 10 条（本机抓的）', r.rows[1].count, 10)
    eq('希冀带上「3 条已提交」', r.rows[1].submitted, 3)
    eq('希冀标成 2 门课', r.rows[1].note, '2 门课')
    eq('U校园 4 条', r.rows[2].count, 4)
    eq('总数是三个平台相加', r.count, 26)
    eq('没有错误', r.errors, [])
    eq('云端版本号带出来', r.srvVer, '20261027.5')
  }

  console.log('\n[2] 希冀没在本机登录：跳过并说清楚怎么补，不算失败')
  {
    const r = await S.syncAll({
      accounts: ACC_ALL,
      api: fakeApi({ res: { details: [{ platform: 'chaoxing', count: 9 }] } }),
      edu: fakeEdu({ cookie: false })
    })
    const eduRow = r.rows.find((x) => x.platform === 'educoder')
    eq('希冀还是占一行（别让人以为平台消失了）', !!eduRow, true)
    eq('标成跳过', eduRow.skipped, true)
    ok('提示去账号页登录', /账号页/.test(eduRow.note), eduRow.note)
    eq('跳过不算错误', r.errors, [])
    eq('总数不含跳过的', r.count, 9)
  }

  console.log('\n[3] 希冀登录态过期：只影响希冀，学习通照旧')
  {
    const r = await S.syncAll({
      accounts: ACC_ALL,
      api: fakeApi({ res: { details: [{ platform: 'chaoxing', count: 9 }] } }),
      edu: fakeEdu({ error: '登录已失效，请重新登录希冀' })
    })
    eq('希冀那行报错', r.rows.find((x) => x.platform === 'educoder').error, '登录已失效，请重新登录希冀')
    eq('学习通不受影响', r.rows.find((x) => x.platform === 'chaoxing').count, 9)
    eq('错误汇总只有一条', r.errors.length, 1)
    ok('错误带平台名前缀', /^希冀：/.test(r.errors[0]), r.errors[0])
  }

  console.log('\n[4] 希冀上一条作业都没有：pushTasks 报「没有可写入的任务」不算故障')
  {
    const r = await S.syncAll({
      accounts: ACC_ALL,
      api: fakeApi({ res: { details: [] } }),
      edu: fakeEdu({ error: '没有可写入的任务' })
    })
    const eduRow = r.rows.find((x) => x.platform === 'educoder')
    eq('不报错', eduRow.error, '')
    eq('换成一句人话', eduRow.note, '平台上暂时没有作业')
    eq('errors 为空', r.errors, [])
  }

  console.log('\n[5] 云端整体挂掉：每个云端平台都点名，希冀不受牵连')
  {
    const r = await S.syncAll({
      accounts: ACC_ALL,
      api: fakeApi({ error: '云函数 studyHub 尚未部署' }),
      edu: fakeEdu({ res: { count: 6, tasks: [{ courseName: '离散数学' }] } })
    })
    const cs = r.rows.find((x) => x.platform === 'chaoxing')
    const up = r.rows.find((x) => x.platform === 'unipus')
    const ed = r.rows.find((x) => x.platform === 'educoder')
    eq('学习通标失败', cs.error, '云函数 studyHub 尚未部署')
    eq('U校园也标失败', up.error, '云函数 studyHub 尚未部署')
    eq('希冀照常 6 条', ed.count, 6)
    eq('希冀没有错误', ed.error, '')
    eq('失败不计入总数', r.count, 6)
  }

  console.log('\n[6] 账号列表里没有希冀、本机登录过：照样抓（第一次 pushTasks 之前就是这状态）')
  {
    const r = await S.syncAll({
      accounts: [{ platform: 'chaoxing', mode: 'cookie' }],
      api: fakeApi({ res: { details: [{ platform: 'chaoxing', count: 5 }] } }),
      edu: fakeEdu({ res: { count: 8, tasks: [{ courseName: '离散数学' }] } })
    })
    eq('希冀被抓进来了', r.rows.map((x) => x.platform), ['chaoxing', 'educoder'])
    eq('总数 13', r.count, 13)
  }

  console.log('\n[6b] 只有希冀一个平台：不去麻烦云函数（它只会回一句「已跳过」）')
  {
    let cloudCalls = 0
    const r = await S.syncAll({
      accounts: [{ platform: 'educoder', mode: 'intranet' }],
      api: {
        sync() {
          cloudCalls++
          return Promise.resolve({ details: [], skipped: ['希冀 由客户端抓取'] })
        }
      },
      edu: fakeEdu({ res: { count: 7, submitted: 2, tasks: [{ courseName: '离散数学' }] } })
    })
    eq('没调云端', cloudCalls, 0)
    eq('只有希冀一行', r.rows.map((x) => x.platform), ['educoder'])
    eq('7 条', r.count, 7)
  }

  console.log('\n[7] 弹窗文案：每个平台一行，带已完成条数')
  {
    const r = await S.syncAll({
      accounts: ACC_ALL,
      api: fakeApi({
        res: {
          details: [
            { platform: 'chaoxing', count: 12, debug: ['汇编语言·作业: 必做 4、共 4 条'] },
            { platform: 'unipus', count: 4, debug: ['视听说·第一册: 必做（红）2、选做（不用做）1、共 4 条'] }
          ]
        }
      }),
      edu: fakeEdu({ res: { count: 10, submitted: 3, tasks: [{ courseName: '离散数学' }] } })
    })
    const doneMap = { chaoxing: 5, educoder: 3, unipus: 0 }
    const rep = S.report(r, (p) => doneMap[p] || 0)
    eq('标题是总条数', rep.title, '已更新 26 项')
    ok('首行是总览', rep.content.indexOf('共 26 条 · 8 条已完成') === 0, rep.content.split('\n')[0])
    ok('学习通那行带已完成数', /学习通 {2}12 条 · 5 条已完成/.test(rep.content), rep.content)
    ok('希冀那行带已完成数', /希冀 {2}10 条 · 3 条已完成/.test(rep.content), rep.content)
    ok('U校园 0 条已完成时不写「0 条已完成」', !/U校园[^\n]*0 条已完成/.test(rep.content), rep.content)
    ok('教材明细缩进带出来', /· 视听说·第一册 {2}4 条/.test(rep.content), rep.content)
  }

  console.log('\n[8] 弹窗文案：失败 / 跳过的平台也要写清楚')
  {
    const r = await S.syncAll({
      accounts: ACC_ALL,
      api: fakeApi({ res: { details: [{ platform: 'chaoxing', count: 3 }] } }),
      edu: fakeEdu({ cookie: false })
    })
    const rep = S.report(r, () => 0)
    ok('希冀那行写「跳过 + 原因」', /希冀 {2}跳过 · /.test(rep.content), rep.content)
    ok('没有失败也照常出内容', rep.content.length > 5, rep.content)
  }

  console.log('\n[9] 一个平台都没有：不炸')
  {
    const r = await S.syncAll({
      accounts: [],
      api: fakeApi({ res: { details: [] } }),
      edu: fakeEdu({ cookie: false })
    })
    eq('没有行', r.rows.length, 0)
    eq('总数 0', r.count, 0)
    eq('弹窗也不空着', S.report(r, () => 0).content, '这次没有可写入的任务')
  }

  console.log('\n[10] 往期教材要单独标出来（免得以为在用却看不见）')
  {
    const r = await S.syncAll({
      accounts: [{ platform: 'unipus', mode: 'cookie' }],
      api: fakeApi({
        res: {
          details: [
            { platform: 'unipus', count: 2, debug: ['视听说·第一册：往期教材，已跳过'] }
          ]
        }
      }),
      edu: fakeEdu({ cookie: false })
    })
    const rep = S.report(r, () => 0)
    ok('往期教材有标记', /✕ 视听说·第一册（往期，已忽略）/.test(rep.content), rep.content)
  }

  console.log('\n----------------------------------------')
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
  if (fail) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
