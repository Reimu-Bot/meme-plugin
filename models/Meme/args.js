import _ from 'lodash'

import { Utils } from '#models'

/**
 * 处理 args
 *
 * 支持三种参数语法（按优先级匹配，先到先得）:
 *   1. #key value        — 标准形式（#mode loop / #方向 右）
 *   2. inline 中文 alias  — 直接跟在触发词后面（一直 循环 / 一直 套娃 @xx）
 *   3. preset 注入       — preset 表达式
 *
 * 注意：@\d+ 形式的 @提及 已经在 models/Meme/index.js:make() 里被 strip 掉了，
 *       所以这里 userText 不再含 @xxx，纯 alias 匹配不会被 @截断。
 */
async function handleArgs (e, memeKey, userText, allUsers, formData, isPreset, Preset) {
  // argsArray 分两阶段填充：
  //   阶段 A (inline alias)：先填，作为 shorthand
  //   阶段 B (#key value)  ：后填，显式指定，**覆盖**阶段 A
  // 这样 `一直 套娃 #mode loop` 会按用户显式意图取 mode=loop
  const argsArray = {}
  const consumed = []  // [{ start, end }] — 已被吃掉的 userText 区间

  /* ============ Step 1: 构造 inline alias 映射表 ============ */
  // 复用 Utils.Tools.getParamInfo 已经解析出来的 valueAliases（后端 parser_options 中
  // dest+store_value 形式的"中文名→真实值"映射，例如 {mode: {套娃:circle, 循环:loop}}）
  const paramInfos = await Utils.Tools.getParamInfo(memeKey)
  const aliasToParam = {}  // { "套娃": { param: "mode", value: "circle" } }
  for (const info of paramInfos) {
    if (info.valueAliases && Object.keys(info.valueAliases).length > 0) {
      for (const [ alias, realVal ] of Object.entries(info.valueAliases)) {
        // 同名 alias 只取第一个（理论上同一参数内不会重名）
        if (!(alias in aliasToParam)) {
          aliasToParam[alias] = { param: info.name, value: realVal }
        }
      }
    }
  }

  /* ============ Step 2: 扫 userText，提取 inline alias ============ */
  const aliasKeys = Object.keys(aliasToParam)
  if (aliasKeys.length > 0) {
    // 按 alias 长度倒序，避免短的误吃（"右" 不会误吃 "右上"）
    const sortedAliases = aliasKeys.sort((a, b) => b.length - a.length)
    const aliasPattern = sortedAliases
      .map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|')
    // token 边界：前/后必须是 ^/$ 或空白/常见标点；后置额外允许 @（紧贴 @ 不消耗）
    // —— 让 `循环@xxx` 这种紧贴 @ 也能识别 alias，但保留 @ 给 handleImages
    const isSeparator = c => c !== '' && c !== undefined && /[\s,，;；:：、]/.test(c)
    const isBoundaryOrAt = c => c === '' || c === undefined || c === '@' || isSeparator(c)
    // 先无脑找所有 alias 出现位置，再校验 token 边界
    // —— 比 "(^|sep)alias(sep|$)" 更稳：前一个 alias 消耗了后置空格时，
    //    下一个 alias 紧跟其后无前导分隔符也能被扫到
    const findRe = new RegExp(`(${aliasPattern})`, 'g')
    for (const m of userText.matchAll(findRe)) {
      const alias = m[1]
      const start = m.index
      const end = start + alias.length
      // 前面必须是 ^ 或 分隔符
      const before = start === 0 ? '' : userText[start - 1]
      if (start > 0 && !isSeparator(before)) continue
      // 后面必须是 $ 或 分隔符或 @（紧贴 @ 视为 alias 边界，但 @ 不消耗）
      const after = end === userText.length ? '' : userText[end]
      if (after !== '' && !isBoundaryOrAt(after)) continue
      // 消耗：alias + 紧贴的 1 个后置分隔符（空白/常见标点，@ 不消耗 → 留给 handleImages）
      let consumeEnd = end
      if (consumeEnd < userText.length && isSeparator(userText[consumeEnd])) {
        consumeEnd++
      }
      const { param, value } = aliasToParam[alias]
      argsArray[param] = value
      consumed.push({ start, end: consumeEnd })
    }
  }

  /* ============ Step 3: #key value 形式（显式指定，**覆盖** inline alias） ============ */
  const argsMatches = userText.match(/#(\S+)\s+([^#]+)/g)
  if (argsMatches) {
    for (const match of argsMatches) {
      const [ _, key, value ] = match.match(/#(\S+)\s+([^#]+)/)
      argsArray[key] = value.trim()  // 覆盖阶段 A 的 inline alias
    }
  }

  /* ============ Step 4: 从 userText 移除已消耗段 ============ */
  consumed.sort((a, b) => a.start - b.start)
  // 合并重叠区间
  const merged = []
  for (const seg of consumed) {
    if (merged.length === 0 || seg.start >= merged[merged.length - 1].end) {
      merged.push({ ...seg })
    } else {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, seg.end)
    }
  }
  let cleaned = ''
  let cursor = 0
  for (const seg of merged) {
    cleaned += userText.slice(cursor, seg.start)
    cursor = seg.end
  }
  cleaned += userText.slice(cursor)
  const finalText = cleaned.replace(/\s+/g, ' ').trim()

  /* ============ Step 5: preset 注入 ============ */
  if (isPreset && Preset?.arg_name) {
    argsArray[Preset.arg_name] = Preset.arg_value
  }
  logger.info(`[meme-debug-args] handleArgs: memeKey=${memeKey} userText=${JSON.stringify(userText)} → argsArray=${JSON.stringify(argsArray)} finalText=${JSON.stringify(finalText)}`)

  /* ============ 提交给后端 ============ */
  const argsResult = await handle(e, memeKey, allUsers, argsArray)

  if (!argsResult.success) {
    return {
      success: argsResult.success,
      message: argsResult.message
    }
  }
  if (argsResult.argsString) {
    formData.append('args', argsResult.argsString)
  }

  return {
    success: true,
    text: finalText
  }
}

async function handle (e, key, allUsers, args) {
  if (!args) args = {}

  const argsObj = {}
  const paramInfos = await Utils.Tools.getParamInfo(key)

  if (!paramInfos || paramInfos.length === 0) {
    return {
      success: false,
      message: '未找到任何参数信息'
    }
  }

  // 构建参数白名单 + value 中文别名映射
  const paramMap = {}
  const valueAliasMap = {}
  for (const info of paramInfos) {
    paramMap[info.name] = true
    if (info.valueAliases && Object.keys(info.valueAliases).length > 0) {
      valueAliasMap[info.name] = info.valueAliases
    }
  }

  for (const [ argName, argValue ] of Object.entries(args)) {
    if (!paramMap[argName]) {
      return {
        success: false,
        message: `该表情不支持参数：${argName}`
      }
    }
    // value 中文/别名映射: "右" → "right"
    const realValue = valueAliasMap[argName]?.[argValue] ?? argValue
    argsObj[argName] = realValue
  }

  const userInfos = [
    {
      text: await Utils.Common.getNickname(e, allUsers[0] || e.user_id),
      gender: await Utils.Common.getGender(e, allUsers[0] || e.user_id)
    }
  ]

  return {
    success: true,
    argsString: JSON.stringify({
      user_infos: userInfos,
      ...argsObj
    })
  }
}

export { handle, handleArgs }
