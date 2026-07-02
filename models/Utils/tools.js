import chalk from 'chalk'

import { Config } from '#components'
import { db, Meme, Utils } from '#models'

const Tools = {
  /**
   * 获取表情包请求的基础 URL
   * @returns {Promise<string>} - 返回表情包基础 URL
   */
  async getBaseUrl () {
    if (!Config.server.url) throw new Error('未设置表情包API')
    return Config.server?.url?.replace(/\/+$/, '')
  },

  /**
   * 初始化表情包数据
   * 如果数据已加载则直接返回，否则从本地或远程加载表情包数据
   * @returns {Promise<void>}
   */
  async init () {
    logger.debug(chalk.cyan('🚀 开始加载表情包数据...'))

    const [ memeData, argData ] = await Promise.all([
      db.meme.getAll(),
      db.preset.getAll()
    ])

    const tasks = []
    if (!memeData?.length) {
      logger.debug(chalk.cyan('🚀 表情包数据不存在，开始生成...'))
      tasks.push(this.generateMemeData(true))
    } else {
      logger.debug(chalk.cyan('✅ 表情包数据已存在，加载完成'))
    }

    if (!argData?.length) {
      logger.debug(chalk.cyan('🚀 参数数据不存在，开始生成...'))
      tasks.push(this.generatePresetData())
    } else {
      logger.debug(chalk.cyan('✅ 参数数据已存在，加载完成'))
    }

    if (tasks.length) await Promise.all(tasks)
  },

  /**
   * 生成本地表情包数据
   * @param {boolean} forceUpdate - 是否进行全量更新数据, 默认为增量更新数据
   * @returns {Promise<void>}
   */
  async generateMemeData (forceUpdate = false) {
    try {
      const baseUrl = await this.getBaseUrl()
      if (!baseUrl) {
        logger.error('❌ 无法获取表情包请求基础路径')
        return
      }

      logger.info(chalk.magenta.bold('🌟 开始生成表情包数据...'))

      const localKeys = forceUpdate
        ? new Set()
        : new Set(await this.getAllKeys())

      const remoteKeysResponse = await Utils.Request.get(
        `${baseUrl}/memes/keys`
      )
      if (!remoteKeysResponse.success || !remoteKeysResponse.data.length) {
        logger.warn('⚠️ 未获取到任何表情包键值，跳过数据更新。')
        return
      }
      const remoteKeys = new Set(remoteKeysResponse.data)

      const keysToUpdate = forceUpdate
        ? [ ...remoteKeys ]
        : [ ...remoteKeys ].filter((key) => !localKeys.has(key))

      const keysToDelete = [ ...localKeys ].filter((key) => !remoteKeys.has(key))

      if (!keysToUpdate.length && !keysToDelete.length) {
        logger.info(chalk.cyan('✅ 表情包数据已是最新，无需更新或删除。'))
        return
      }

      logger.debug(
        chalk.magenta(`🔄 需要更新 ${keysToUpdate.length} 个表情包`)
      )
      logger.debug(chalk.red(`🗑️  需要删除 ${keysToDelete.length} 个表情包`))

      if (keysToDelete.length) {
        await this.removeKey(keysToDelete)
        logger.info(chalk.yellow(`🗑️ 已删除 ${keysToDelete.length} 个表情包`))
      }

      const processValue = (value) => {
        if (Array.isArray(value) && value.length === 0) return null
        if (
          typeof value === 'object' &&
          value !== null &&
          Object.keys(value).length === 0
        )
          return null
        return value
      }

      await Promise.all(
        keysToUpdate.map(async (key) => {
          const infoResponse = await Utils.Request.get(
            `${baseUrl}/memes/${key}/info`
          )
          if (!infoResponse.success) {
            logger.error(
              `❌ 获取表情包详情失败: ${key} - ${infoResponse.message}`
            )
            return
          }

          const info = infoResponse.data

          const keyWords = processValue(info.keywords)
          const tags = processValue(info.tags)
          const params = processValue(info.params_type)

          const min_texts = params?.min_texts ?? null
          const max_texts = params?.max_texts ?? null
          const min_images = params?.min_images ?? null
          const max_images = params?.max_images ?? null
          const defText = processValue(params?.default_texts)
          const args_type = params?.args_type ?? null

          // 把 args_type.parser_options 提升到 params 顶层，方便 getParams / getParamInfo 直接读取
          // （API 实际位置是 params_type.args_type.parser_options，老版本 getParams 一直读不到）
          const paramsForDb = params && typeof params === 'object'
            ? {
                ...params,
                parser_options: Array.isArray(params?.args_type?.parser_options)
                  ? params.args_type.parser_options
                  : (Array.isArray(params?.parser_options) ? params.parser_options : null)
              }
            : params

          await db.meme.add(
            key,
            info,
            keyWords,
            paramsForDb,
            min_texts,
            max_texts,
            min_images,
            max_images,
            defText,
            args_type,
            tags,
            { force: true }
          )
        })
      )

      logger.info(chalk.green.bold('✅ 表情包数据更新完成！'))
    } catch (error) {
      logger.error(`❌ 生成本地表情包数据失败: ${error.message}`)
      throw error
    }
  },

  /**
   * 生成预设参数数据
   * @returns {Promise<void>}
   */
  async generatePresetData () {
    try {
      logger.debug(chalk.blue.bold('🛠️ 开始生成预设参数数据...'))
      const preset = Meme.preset
      await db.preset.removeAll()
      await Promise.all(
        preset.map(async (preset) => {
          await db.preset.add(
            preset.name,
            preset.key,
            preset.arg_name,
            preset.arg_value
          )
        })
      )
      logger.debug(chalk.green.bold(`✅ 成功写入 ${preset.length} 条预设数据`))
    } catch (error) {
      logger.error(`❌ 预设数据生成失败: ${error.message}`)
      throw error
    }
  },

  /**
   * 发送表情包生成请求
   */
  async request (endpoint, params = {}, responseType = 'arraybuffer') {
    const baseUrl = await this.getBaseUrl()
    const url = `${baseUrl}/memes/${endpoint}/`

    const isFormData = params instanceof FormData
    const headers = responseType ? { Accept: responseType } : {}

    return Utils.Request.post(
      url,
      params,
      isFormData ? undefined : headers,
      responseType
    )
  },

  /**
   * 获取表情包的预览图片地址
   * @param {string} memeKey - 表情包的唯一标识符
   * @returns {Promise<string|null>} - 返回预览图片的 URL 或 null
   */
  async getPreviewUrl (memeKey) {
    return memeKey
      ? `${await this.getBaseUrl()}/memes/${memeKey}/preview`.trim()
      : null
  },

  /**
 * 将关键字转换为表情包键
 * @param {string} keyword - 表情包关键字
 * @param {string} [type='meme'] - 可选参数，决定从哪个数据源获取，'meme' 或 'preset'（默认 'meme'）
 * @returns {string|null} - 返回对应的表情包键或 null
 */
  async getKey (keyword, type = 'meme') {
    const dbField = type === 'preset' ? db.preset : db.meme
    const fieldName = type === 'preset' ? 'name' : 'keyWords'
    const key = type === 'preset' ? 'key' : 'key'

    return (
      (await dbField.getByField(fieldName, keyword, key)).toString() || null
    )
  },
  /**
   * 获取指定表情包的关键字
   * @param {string} memeKey - 表情包的唯一标识符
   * @returns {string[]|null} - 返回表情包关键字数组或 null
   */
  async getKeyWords (memeKey) {
    return JSON.parse(await db.meme.getByKey(memeKey, 'keyWords')) || null
  },

  /**
 * 获取所有的关键词
 * @param {string} [type='meme'] - 可选参数，决定从哪个数据库获取，'meme' 或 'preset'（默认 'meme'）
 * @returns {Promise<Array<string>>} - 返回包含所有关键词的数组
 */
  async getAllKeyWords (type = 'meme') {
    const keyWordsList = type === 'preset'
      ? await db.preset.getAllSelect('name')
      : await db.meme.getAllSelect('keyWords')

    return keyWordsList.map((item) => JSON.parse(item)).flat() || null
  },


  /**
   * 获取所有的 key
   * @returns {Array<string>} - 返回所有的表情包 key 的数组
   */
  async getAllKeys () {
    const keyList = await db.meme.getAllSelect('key')

    return keyList.flat() || null
  },

  /**
   * 获取快捷指令信息
   * @param {string} name - 表情包的唯一标识符(快捷指令)
   * @returns {Promise<object|null>} -返回快捷指令信息
   */
  async getPreseInfo (name) {
    return await db.preset.get(name)
  },

  /**
   * 获取所有的快捷指令信息
   * @param {string} memeKey - 表情的键值
   * @returns {Promise<Array<string>>} - 返回包含所有关键词的数组
   */
  async gatPresetAllName (memeKey) {
    const nameList = await db.preset.getAllByKey(memeKey) ?? []
    return nameList.map((item) => JSON.parse(item.name)) || null
  },

  /**
   * 获取表情包的参数类型
   * @param {string} memeKey - 表情包的键值
   * @returns {Promise<object|null>} - 返回参数类型信息或 null
   */
  async getParams (memeKey) {
    if (!memeKey) return null

    const memeParams = await db.meme.getByKey(memeKey, 'params')

    if (!memeParams) {
      return null
    }

    const parsed = JSON.parse(memeParams)
    const {
      min_texts,
      max_texts,
      min_images,
      max_images,
      default_texts,
      args_type,
      parser_options
    } = parsed

    // 兼容层：API 实际返回的是 params_type = { ..., args_type: { ..., parser_options: [...] } }
    // 老数据 / 部分库只把整坨 params_type 存到 params 字段，parser_options 实际在 args_type 里。
    // 这里做兜底，避免 getParamInfo 拿不到 inline alias（套娃/循环等）。
    const fallbackParserOptions =
      parser_options ||
      (Array.isArray(args_type?.parser_options) ? args_type.parser_options : null)

    return {
      min_texts,
      max_texts,
      min_images,
      max_images,
      default_texts,
      args_type,
      parser_options: fallbackParserOptions
    }
  },
  /**
   * 获取指定表情包参数的类型
   * @param {string} key - 表情包的唯一标识符
   * @param {string} paramName - 参数名称
   * @returns {string|null} - 返回参数的类型或 null
   */
  async getParamInfo (key) {
    const { args_type, parser_options } = await this.getParams(key)

    if (!args_type || !args_type.args_model) {
      return []
    }

    const argsModel = args_type.args_model
    const properties = argsModel.properties || {}

    // 从 parser_options 收集 value 的中文/别名映射
    // 结构: { direction: { "左": "left", "右": "right" }, ... }
    const valueAliasByDest = {}
    if (Array.isArray(parser_options)) {
      for (const opt of parser_options) {
        if (!opt || !opt.dest || !opt.action || opt.action.value === undefined) continue
        if (!Array.isArray(opt.names)) continue
        if (!valueAliasByDest[opt.dest]) valueAliasByDest[opt.dest] = {}
        for (const name of opt.names) {
          if (typeof name !== 'string') continue
          if (name.startsWith('--') || name.startsWith('-')) continue
          if (name === opt.action.value) continue
          valueAliasByDest[opt.dest][name] = opt.action.value
        }
      }
    }

    return Object.entries(properties)
      .filter(([ name ]) => name !== 'user_infos')
      .map(([ name, paramInfo ]) => ({
        name,
        description: paramInfo.description || null,
        valueAliases: valueAliasByDest[name] || {}
      }))
  },

  /**
   * 获取指定 key 的参数描述信息
   * @param {string} key - 需要获取描述的 key。
   * @returns {object|null} - 返回描述信息
   */
  async getDescriptions (key) {
    const params = await this.getParamInfo(key)

    if (!params || params.length === 0) {
      return null
    }

    return params.reduce((acc, { name, description }) => {
      acc[name] = description
      return acc
    }, {})
  },


  /**
   * 获取对应表情的表情
   * @param {string} key
   * @returns {string[]|null} 返回对应表情的表情
   */
  async getTags (key) {
    return JSON.parse(await db.meme.getByKey(key, 'tags')) || null
  },

  /**
   * 获取对应表情的默认文本
   * @param {string} key
   * @returns {string[]|null} 返回对应表情的默认文本
   */
  async getDeftext (key) {
    return JSON.parse(await db.meme.getByKey(key, 'defText')) || null
  },

  /**
   * 删除指定key的表情
   * @param {string||string[]} key
   * @returns {boolean}
   */
  async removeKey (keys) {
    if (!Array.isArray(keys)) {
      keys = [ keys ]
    }
    await Promise.all(keys.map((key) => db.meme.remove(key)))
  },

  /**
   * 检查输入是否在禁用表情包列表中
   * @param {string} input - 输入的关键字或表情包键
   * @returns {Promise<boolean>} - 如果在禁用列表中返回 true，否则返回 false
   */
  async isBlacklisted (input) {
    const blacklistedKeys = await Promise.all(
      Config.access.blackList.map(async (item) => {
        return (await this.getKey(item, 'meme')) || item
      })
    )

    if (blacklistedKeys.includes(input)) {
      return true
    }

    const memeKey = await this.getKey(input, 'meme')
    return blacklistedKeys.includes(memeKey)
  }
}

export { Tools }
