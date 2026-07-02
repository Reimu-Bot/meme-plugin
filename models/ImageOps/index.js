import { createRequire } from 'node:module'

import sharp from 'sharp'

import { Config } from '#components'

const require = createRequire(import.meta.url)
const { Gif, GifCodec, GifFrame, GifUtil } = require('gifwrap')

const DEFAULT_CONFIG = {
  enable: true,
  maxImages: 9,
  maxInputPixels: 16000000,
  maxOutputBytes: 10485760,
  maxGifFrames: 80,
  defaultGifDelay: 80
}

const getConfig = () => ({ ...DEFAULT_CONFIG, ...(Config.imageOps || {}) })

const normalizeDegree = (degree) => {
  const value = Number(degree)
  if (!Number.isFinite(value)) throw new Error('旋转角度必须是数字')
  return value
}

const parseSize = (text) => {
  const match = String(text || '').match(/(\d{1,5})\s*[xX*×]\s*(\d{1,5})/)
  if (!match) throw new Error('缩放格式错误，请使用 #图片缩放 512x512')

  const width = Number(match[1])
  const height = Number(match[2])
  validatePositive(width, '宽度')
  validatePositive(height, '高度')
  return { width, height }
}

const parseCrop = (text) => {
  const match = String(text || '').match(/(\d{1,5})\D+(\d{1,5})\D+(\d{1,5})\D+(\d{1,5})/)
  if (!match) throw new Error('裁剪格式错误，请使用 #图片裁剪 x y 宽 高')

  const left = Number(match[1])
  const top = Number(match[2])
  const width = Number(match[3])
  const height = Number(match[4])
  validatePositive(width, '宽度')
  validatePositive(height, '高度')
  return { left, top, width, height }
}

const parseDelayCentisecs = (text) => {
  const match = String(text || '').match(/\d+/)
  const delay = match ? Number(match[0]) : getConfig().defaultGifDelay
  if (!Number.isInteger(delay) || delay < 10 || delay > 655350) {
    throw new Error('GIF 间隔必须是 10 到 655350 毫秒之间的整数')
  }
  return Math.max(1, Math.round(delay / 10))
}

const validatePositive = (value, name) => {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name}必须是正整数`)
}

const ensureEnabled = () => {
  if (!getConfig().enable) throw new Error('图片操作功能已关闭')
}

const ensureOutputSize = (buffer) => {
  const { maxOutputBytes } = getConfig()
  if (maxOutputBytes > 0 && buffer.length > maxOutputBytes) {
    throw new Error(`处理后图片过大，已超过 ${Math.round(maxOutputBytes / 1024 / 1024)}MB`)
  }
  return buffer
}

const createSharp = (buffer) => {
  const { maxInputPixels } = getConfig()
  return sharp(buffer, {
    animated: true,
    limitInputPixels: maxInputPixels > 0 ? maxInputPixels : false
  })
}

const toBuffer = async (image) => ensureOutputSize(await image.toBuffer())

const metadataOf = async (buffer) => await sharp(buffer, { animated: true }).metadata()

const normalizeImages = (images, min = 1) => {
  const { maxImages } = getConfig()
  if (!images || images.length < min) throw new Error(`请发送或引用至少 ${min} 张图片`)
  return images.slice(0, maxImages)
}

const ensureGifFrameCount = (frames) => {
  const { maxGifFrames } = getConfig()
  if (maxGifFrames > 0 && frames.length > maxGifFrames) {
    throw new Error(`GIF 帧数过多，最多处理 ${maxGifFrames} 帧`)
  }
}

const compositeImages = async (images, direction) => {
  const normalized = normalizeImages(images, 2)
  const items = await Promise.all(normalized.map(async (input) => {
    const metadata = await metadataOf(input)
    return {
      input: await sharp(input).png().toBuffer(),
      width: metadata.width || 0,
      height: metadata.height || 0
    }
  }))

  if (items.some(item => !item.width || !item.height)) throw new Error('无法读取图片尺寸')

  const width = direction === 'horizontal'
    ? items.reduce((sum, item) => sum + item.width, 0)
    : Math.max(...items.map(item => item.width))
  const height = direction === 'horizontal'
    ? Math.max(...items.map(item => item.height))
    : items.reduce((sum, item) => sum + item.height, 0)

  let left = 0
  let top = 0
  const composite = items.map((item) => {
    const current = { input: item.input, left, top }
    if (direction === 'horizontal') left += item.width
    else top += item.height
    return current
  })

  return ensureOutputSize(await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 0 }
    }
  }).composite(composite).png().toBuffer())
}

const readGif = async (images) => {
  const [image] = normalizeImages(images)
  const gif = await GifUtil.read(image)
  ensureGifFrameCount(gif.frames)
  return gif
}

const encodeGif = async (frames, loops = 0) => {
  ensureGifFrameCount(frames)
  GifUtil.quantizeWu(frames, 256)
  const gif = await new GifCodec().encodeGif(frames, {
    loops,
    colorScope: Gif.LocalColorsOnly
  })
  return ensureOutputSize(gif.buffer)
}

const frameToPng = async (frame, width, height) => {
  const buffer = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 0 }
    }
  }).composite([
    {
      input: frame.bitmap.data,
      raw: {
        width: frame.bitmap.width,
        height: frame.bitmap.height,
        channels: 4
      },
      left: frame.xOffset,
      top: frame.yOffset
    }
  ]).png().toBuffer()
  return ensureOutputSize(buffer)
}

const imageToGifFrame = async (image, width, height, delayCentisecs) => {
  const { data, info } = await sharp(image)
    .resize(width, height, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 0 }
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  return new GifFrame(info.width, info.height, data, {
    delayCentisecs,
    disposalMethod: GifFrame.DisposeToBackgroundColor
  })
}

export const ImageOps = {
  async rotate (images, degree = 90) {
    ensureEnabled()
    const [image] = normalizeImages(images)
    return await toBuffer(createSharp(image).rotate(normalizeDegree(degree)))
  },

  async resize (images, text) {
    ensureEnabled()
    const [image] = normalizeImages(images)
    const size = parseSize(text)
    return await toBuffer(createSharp(image).resize(size))
  },

  async crop (images, text) {
    ensureEnabled()
    const [image] = normalizeImages(images)
    const area = parseCrop(text)
    return await toBuffer(createSharp(image).extract(area))
  },

  async grayscale (images) {
    ensureEnabled()
    const [image] = normalizeImages(images)
    return await toBuffer(createSharp(image).grayscale())
  },

  async invert (images) {
    ensureEnabled()
    const [image] = normalizeImages(images)
    return await toBuffer(createSharp(image).negate())
  },

  async flipHorizontal (images) {
    ensureEnabled()
    const [image] = normalizeImages(images)
    return await toBuffer(createSharp(image).flop())
  },

  async flipVertical (images) {
    ensureEnabled()
    const [image] = normalizeImages(images)
    return await toBuffer(createSharp(image).flip())
  },

  async mergeHorizontal (images) {
    ensureEnabled()
    return await compositeImages(images, 'horizontal')
  },

  async mergeVertical (images) {
    ensureEnabled()
    return await compositeImages(images, 'vertical')
  },

  async gifSplit (images) {
    ensureEnabled()
    const gif = await readGif(images)
    const buffers = await Promise.all(gif.frames.map(frame => frameToPng(frame, gif.width, gif.height)))
    return { type: 'images', buffers }
  },

  async gifMerge (images, text) {
    ensureEnabled()
    const normalized = normalizeImages(images, 2)
    const delayCentisecs = parseDelayCentisecs(text)
    const firstMetadata = await metadataOf(normalized[0])
    const width = firstMetadata.width || 0
    const height = firstMetadata.height || 0
    if (!width || !height) throw new Error('无法读取图片尺寸')

    const frames = await Promise.all(normalized.map(image => imageToGifFrame(image, width, height, delayCentisecs)))
    return await encodeGif(frames)
  },

  async gifReverse (images) {
    ensureEnabled()
    const gif = await readGif(images)
    const frames = GifUtil.cloneFrames(gif.frames).reverse()
    return await encodeGif(frames, gif.loops)
  },

  async gifChangeDuration (images, text) {
    ensureEnabled()
    const gif = await readGif(images)
    const delayCentisecs = parseDelayCentisecs(text)
    const frames = GifUtil.cloneFrames(gif.frames).map((frame) => {
      frame.delayCentisecs = delayCentisecs
      return frame
    })
    return await encodeGif(frames, gif.loops)
  }
}
