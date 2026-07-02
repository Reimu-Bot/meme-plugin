import { Config, Version } from '#components'
import { Meme, Utils } from '#models'

let memeRegExp, presetRegExp

/**
 * 生成正则表达式
 * @param {Function} getKeywords 获取关键词的函数
 * @returns {RegExp | null}
 */
const createRegex = async (getKeywords) => {
  const keywords = await getKeywords()
  if (!keywords) return null

  const prefix = Config.meme.forceSharp ? '^#' : '^#?'
  const escapedKeywords = keywords.map((keyword) =>
    keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  )
  return new RegExp(`${prefix}(${escapedKeywords.join('|')})(.*)`, 'i')
}

memeRegExp = await createRegex(() => Utils.Tools.getAllKeyWords('meme'))
presetRegExp = await createRegex(() => Utils.Tools.getAllKeyWords('preset'))

export class meme extends plugin {
  constructor () {
    super({
      name: '清语表情:表情包生成',
      event: 'message',
      priority: -Infinity,
      rule: []
    })

    this.rule.push(
      {
        reg: memeRegExp,
        fnc: 'meme'
      },
      {
        reg: presetRegExp,
        fnc: 'preset'
      }
    )
  }

  /**
   * 更新正则
   */
  async updateRegExp () {
    memeRegExp = await createRegex(() => Utils.Tools.getAllKeyWords('meme'))
    presetRegExp = await createRegex(() => Utils.Tools.getAllKeyWords('preset'))

    this.rule = [
      {
        reg: memeRegExp,
        fnc: 'meme'
      },
      {
        reg: presetRegExp,
        fnc: 'preset'
      }
    ]

    return true
  }

  async meme (e) {
    logger.info(`[meme-debug] meme() entered, msg=${JSON.stringify(e.msg)}, user_id=${e.user_id}, group_id=${e.group_id || 'private'}`)
    return this.validatePrepareMeme(e, memeRegExp, Utils.Tools.getKey)
  }

  async preset (e) {
    return this.validatePrepareMeme(
      e,
      presetRegExp,
      Utils.Tools.getKey,
      true,
      'preset'
    )
  }

  /**
   * 通用处理函数, 用于验证权限获取需要的参数之类的
   */
  async validatePrepareMeme (
    e,
    regExp,
    getKeyFunc,
    isPreset = false,
    type = 'meme'
  ) {
    if (!Config.meme.enable) return false
    const message = (e.msg || '').trim()
    const match = message.match(regExp)
    logger.info(`[meme-debug] validatePrepareMeme: match=${!!match} matchedKeyword=${match?.[1]?.trim()} userText=${JSON.stringify(match?.[2]?.trim())}`)
    if (!match) return false

    const matchedKeyword = match[1]
    const userText = match[2]?.trim() || ''
    if (!matchedKeyword) return false

    const memeKey = await getKeyFunc(matchedKeyword, type)
    if (!memeKey) return false

    /** 用户权限检查 */
    if (!this.checkUserAccess(e.user_id)) return false

    /* 黑名单检查 */
    if (
      Config.access.blackListEnable &&
      (await Utils.Tools.isBlacklisted(matchedKeyword))
    ) {
      logger.info(
        `[清语表情] 该表情 "${matchedKeyword}" 在禁用列表中，跳过生成`
      )
      return false
    }

    const params = await Utils.Tools.getParams(memeKey)
    logger.info(`[meme-debug] params for ${memeKey}: min_texts=${params?.min_texts} max_texts=${params?.max_texts} min_images=${params?.min_images} max_images=${params?.max_images}`)
    if (!params) return false

    /* 防误触发（放宽：允许 @昵称 / @QQ号 / #参数 / inline alias(套娃/循环等) 自由混用） */
    if (params.min_texts === 0 && params.max_texts === 0 && userText) {
      const trimmedText = userText.trim()
      let stripped = trimmedText
        .replace(/@\S+/g, '')
        .replace(/#\S+\s+[^#]+/g, '')
      logger.info(`[meme-debug] anti-mis start: trimmedText=${JSON.stringify(trimmedText)} strippedAfterHash=${JSON.stringify(stripped)}`)

      // 额外：把 valueAliases 里的 inline alias 也从 stripped 删掉
      // （例如 `循环`、`套娃` 这类写在 parser_options 里的中文别名）
      const paramInfos = await Utils.Tools.getParamInfo(memeKey)
      if (paramInfos && paramInfos.length > 0) {
        const aliasKeys = []
        for (const info of paramInfos) {
          if (info.valueAliases) {
            for (const alias of Object.keys(info.valueAliases)) {
              if (alias.startsWith('--') || alias.startsWith('-')) continue
              aliasKeys.push(alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            }
          }
        }
        if (aliasKeys.length > 0) {
          // 按长度倒序排，避免短的误吃
          aliasKeys.sort((a, b) => b.length - a.length)
          // 匹配独立 token：前 ^ 或 空白/常见标点，后 $ 或 空白/常见标点/@
          // —— 加 @ 是为了让 `循环@xxx` 这种紧贴 @ 的写法也能被吃掉 alias 段
          // —— 但 @ 不消耗（用 lookahead），保留给后续 handleImages 处理 allUsers
          const aliasRe = new RegExp(
            `(?:^|([\\s,，;；:：、]))(${aliasKeys.join('|')})(?=$|[\\s,，;；:：、@])`,
            'g'
          )
          stripped = stripped
            .replace(aliasRe, (m, lead) => lead || ' ')
            .replace(/\s+/g, ' ')
            .trim()
        }
      }

      if (stripped.length > 0) {
        logger.info(`[meme-debug] anti-mis REJECTED, final stripped=${JSON.stringify(stripped)}`)
        if (Config.meme.errorReply) {
          await e.reply(
            `[${Version.Plugin_AliasName}] 参数格式不正确\n` +
            `支持写法：\n` +
            `  #表情 @1234567\n` +
            `  #表情 #key value\n` +
            `  #表情 @昵称 #key value\n` +
            `  #表情 循环 @1234567   (inline alias)\n` +
            `当前内容：${trimmedText}`
          )
        }
        return false
      }
    }

    const extraData = isPreset
      ? { Preset: await Utils.Tools.getPreseInfo(matchedKeyword) }
      : {}

    return this.makeMeme(e, memeKey, params, userText, isPreset, extraData)
  }
  // mark end of validatePrepareMeme for debug

  /**
   * 用户权限检查
   */
  checkUserAccess (userId) {
    if (!Config.access.enable) return true

    if (
      (Config.access.mode === 0 &&
        !Config.access.userWhiteList.includes(userId)) ||
      (Config.access.mode === 1 && Config.access.userBlackList.includes(userId))
    ) {
      logger.info(
        `[${Version.Plugin_AliasName}] 用户 ${userId} 没有权限，跳过生成`
      )
      return false
    }
    return true
  }

  /**
   * 调用 Meme 生成方法
   */
  async makeMeme (e, memeKey, params, userText, isPreset, extraData) {
    try {
      const result = await Meme.make(
        e,
        memeKey,
        params.min_texts,
        params.max_texts,
        params.min_images,
        params.max_images,
        params.default_texts,
        params.args_type,
        userText,
        isPreset,
        extraData
      )
      await e.reply(segment.image(result), Config.meme.reply)
      return true
    } catch (error) {
      logger.error(error.message)
      if (Config.meme.errorReply) {
        await e.reply(
          `[${Version.Plugin_AliasName}] 生成表情失败, 错误信息: ${error.message}`
        )
      }
      return false
    }
  }
}
