const chaoxing = require('./chaoxing')
const educoder = require('./educoder')
const unipus = require('./unipus')
const zhihuishu = require('./zhihuishu')
const icourse163 = require('./icourse163')
const yuketang = require('./yuketang')

const registry = {
  chaoxing,
  educoder,
  unipus,
  zhihuishu,
  icourse163,
  yuketang
}

function get(platform) {
  const a = registry[platform]
  if (!a) throw new Error('不支持的平台：' + platform)
  return a
}

function list() {
  return Object.keys(registry).map((k) => ({ key: registry[k].key, name: registry[k].name }))
}

module.exports = { get, list, registry }
