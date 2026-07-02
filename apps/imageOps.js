import { Config, Version } from '#components'
import { ImageOps, Utils } from '#models'

const OPERATION_MAP = [
  { pattern: /^图片旋转\s*(-?\d+(?:\.\d+)?)?$/i, fnc: 'rotate', getArgs: match => match[1] || 90 },
  { pattern: /^图片缩放\s+(.+)$/i, fnc: 'resize', getArgs: match => match[1] },
  { pattern: /^图片裁剪\s+(.+)$/i, fnc: 'crop', getArgs: match => match[1] },
  { pattern: /^图片灰度$/i, fnc: 'grayscale' },
  { pattern: /^图片反色$/i, fnc: 'invert' },
  { pattern: /^图片水平翻转$/i, fnc: 'flipHorizontal' },
  { pattern: /^图片垂直翻转$/i, fnc: 'flipVertical' },
  { pattern: /^图片横向拼接$/i, fnc: 'mergeHorizontal' },
  { pattern: /^图片纵向拼接$/i, fnc: 'mergeVertical' },
  { pattern: /^GIF拆帧$/i, fnc: 'gifSplit' },
  { pattern: /^GIF合成\s*(\d+)?$/i, fnc: 'gifMerge', getArgs: match => match[1] },
  { pattern: /^GIF倒放$/i, fnc: 'gifReverse' },
  { pattern: /^GIF改间隔\s*(\d+)?$/i, fnc: 'gifChangeDuration', getArgs: match => match[1] }
]

export class imageOps extends plugin {
  constructor () {
    super({
      name: '清语表情:图片操作',
      event: 'message',
      priority: 100,
      rule: [
        {
          reg: '^#?(图片(?:旋转|缩放|裁剪|灰度|反色|水平翻转|垂直翻转|横向拼接|纵向拼接).*|GIF(?:拆帧|合成|倒放|改间隔).*)$',
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
      const messages = await Promise.all(result.buffers.map(async (buffer, index) => [
        `第 ${index + 1} 帧`,
        segment.image(await Utils.Common.getImageBase64(buffer, true))
      ]))

      if (e.group?.makeForwardMsg) {
        await e.reply(await e.group.makeForwardMsg(messages.flat()))
      } else {
        for (const message of messages.slice(0, 10)) {
          await e.reply(message)
        }
      }
      return
    }

    await e.reply(segment.image(await Utils.Common.getImageBase64(result, true)), Config.meme.reply)
  }

  async getImages (e) {
    const images = await Utils.Common.getImage(e)
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
