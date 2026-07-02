import { Config, Version } from '#components'
import { ImageOps, Utils } from '#models'

const OPERATION_MAP = [
  { pattern: /^图片旋转\s*(-?\d+(?:\.\d+)?)?$/i, fnc: 'rotate', getArgs: match => match[1] || 90 },
  { pattern: /^图片缩放\s+(.+)$/i, fnc: 'resize', getArgs: match => match[1] },
  { pattern: /^图片裁剪\s+((?!\d{1,2}\s*[xX*×]\s*\d{1,2}).+)$/i, fnc: 'crop', getArgs: match => match[1] },
  { pattern: /^图片裁剪\s+(\d{1,2}\s*[xX*×]\s*\d{1,2}.*)$/i, fnc: 'cropGrid', getArgs: match => match[1] },
  { pattern: /^裁剪\s*(\d{1,2}\s*[xX*×]\s*\d{1,2}.*)$/i, fnc: 'cropGrid', getArgs: match => match[1] },
  { pattern: /^图片灰度$/i, fnc: 'grayscale' },
  { pattern: /^图片反色$/i, fnc: 'invert' },
  { pattern: /^图片水平翻转$/i, fnc: 'flipHorizontal' },
  { pattern: /^图片垂直翻转$/i, fnc: 'flipVertical' },
  { pattern: /^图片横向拼接$/i, fnc: 'mergeHorizontal' },
  { pattern: /^图片纵向拼接$/i, fnc: 'mergeVertical' },
  { pattern: /^GIF(?:拆帧|分解)$/i, fnc: 'gifSplit' },
  { pattern: /^GIF合成\s*(.+)?$/i, fnc: 'gifMerge', getArgs: match => match[1] },
  { pattern: /^多图合成GIF\s*(.+)?$/i, fnc: 'gifMerge', getArgs: match => match[1] },
  { pattern: /^合成GIF\s*(.+)?$/i, fnc: 'spriteGif', getArgs: match => match[1] },
  { pattern: /^合成1GIF\s*(.+)?$/i, fnc: 'spriteGifMode1', getArgs: match => match[1] },
  { pattern: /^合成2GIF\s*(.+)?$/i, fnc: 'spriteGifMode2', getArgs: match => match[1] },
  { pattern: /^GIF倒放$/i, fnc: 'gifReverse' },
  { pattern: /^GIF改间隔\s*(.+)?$/i, fnc: 'gifChangeDuration', getArgs: match => match[1] }
]

export class imageOps extends plugin {
  constructor () {
    super({
      name: '清语表情:图片操作',
      event: 'message',
      priority: 100,
      rule: [
        {
          reg: '^#?(?:图片(?:旋转|缩放|裁剪|灰度|反色|水平翻转|垂直翻转|横向拼接|纵向拼接).*|裁剪.*|[Gg][Ii][Ff](?:拆帧|分解|合成|倒放|改间隔).*|多图合成[Gg][Ii][Ff].*|合成[12]?[Gg][Ii][Ff].*)$',
          fnc: 'imageOps'
        }
      ]
    })
  }

  async imageOps (e) {
    if (Config.imageOps && !Config.imageOps.enable) return false

    const message = this.cleanMessage(e.msg)
    const operation = this.getOperation(message)
    if (!operation) return false

    try {
      const images = await this.getImages(e)
      const result = await ImageOps.ImageOps[operation.fnc](images, operation.args)
      await this.replyResult(e, result)
      return true
    } catch (error) {
      logger.error(`[${Version.Plugin_AliasName}] 图片操作失败: ${error.message}`)
      if (Config.meme.errorReply) await e.reply(`[${Version.Plugin_AliasName}] 图片操作失败, 错误信息: ${error.message}`)
      return false
    }
  }

  async replyResult (e, result) {
    if (result?.type === 'images') {
      const nodes = await Promise.all(result.buffers.map(async (buffer, index) => ({
        message: [
          `${result.label || '结果'} ${index + 1}`,
          segment.image(await Utils.Common.getImageBase64(buffer, true))
        ]
      })))

      const forwardMsg = e.group?.makeForwardMsg
        ? await e.group.makeForwardMsg(nodes)
        : e.friend?.makeForwardMsg
          ? await e.friend.makeForwardMsg(nodes)
          : await Bot.makeForwardMsg(nodes)

      await e.reply(forwardMsg)
      return
    }

    await e.reply(segment.image(await Utils.Common.getImageBase64(result, true)), Config.meme.reply)
  }

  async getImages (e) {
    const images = await Utils.Common.getImage(e)
    const forwardImages = await this.getForwardImages(e)
    images.push(...forwardImages)

    const users = [
      ...new Set(e.message
        .filter(message => message?.type === 'at')
        .map(message => message?.qq?.toString())
        .filter(Boolean))
    ]

    if (users.length > 0) {
      const avatars = await Utils.Common.getAvatar(e, users)
      images.unshift(...avatars.filter(Boolean))
    }

    return images
  }

  async getForwardImages (e) {
    const messages = [ ...(e.message || []) ]
    const source = await this.getReplyMessage(e)
    if (source) {
      const sourceArray = Array.isArray(source) ? source : [ source ]
      messages.push(...sourceArray.flatMap(item => item.message || []))
    }

    const imageUrls = await this.extractForwardImageUrls(e, messages)
    const results = await Promise.allSettled(imageUrls.map(url => Utils.Common.getImageBuffer(url)))
    return results
      .filter(result => result.status === 'fulfilled' && result.value)
      .map(result => result.value)
  }

  async getReplyMessage (e) {
    if (!Config.meme.quotedImages) return null
    if (e.reply_id) return await e.getReply()
    if (!e.source) return null

    if (e.isGroup) return await Bot[e.self_id].pickGroup(e.group_id).getChatHistory(e.source.seq || e.reply_id, 1)
    if (e.isPrivate) return await Bot[e.self_id].pickFriend(e.user_id).getChatHistory(e.source.time || e.reply_id, 1)
    return null
  }

  async extractForwardImageUrls (e, messages) {
    const imageUrls = []
    const forwardMessages = messages.filter(message => message?.type === 'xml' || message?.type === 'forward')

    for (const message of forwardMessages) {
      const resid = this.getForwardResid(message)
      if (!resid || !e.bot?.getForwardMsg) continue

      try {
        const nodes = await e.bot.getForwardMsg(resid)
        for (const node of nodes || []) {
          for (const item of node.message || []) {
            if (item?.type === 'image' && item.url) imageUrls.push(item.url)
          }
        }
      } catch (error) {
        logger.warn(`[${Version.Plugin_AliasName}] 获取合并转发图片失败: ${error.message}`)
      }
    }

    return [ ...new Set(imageUrls) ]
  }

  getForwardResid (message) {
    if (message.id) return message.id
    const match = String(message.data || '').match(/m_resid="([\w/+]+)"/)
    return match?.[1] || null
  }

  cleanMessage (message = '') {
    return String(message).replace(/^#/, '').trim()
  }

  getOperation (message) {
    for (const item of OPERATION_MAP) {
      const match = message.match(item.pattern)
      if (match) {
        return {
          fnc: item.fnc,
          args: item.getArgs ? item.getArgs(match) : undefined
        }
      }
    }
    return null
  }
}
