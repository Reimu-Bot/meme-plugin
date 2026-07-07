import { spawn } from 'node:child_process'
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
  defaultGifDelay: 80,
  ffmpegPath: ''
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

const parseMargins = (text = '') => {
  const margins = { top: 0, bottom: 0, left: 0, right: 0 }
  const cleanText = String(text).replace(/边距\s*([上下左右])?边?\s*(\d+)/g, (full, direction, amountText) => {
    const amount = Number(amountText)
    if (!Number.isInteger(amount) || amount < 0) return ' '

    if (!direction) {
      margins.top += amount
      margins.bottom += amount
      margins.left += amount
      margins.right += amount
    } else if (direction === '上') margins.top += amount
    else if (direction === '下') margins.bottom += amount
    else if (direction === '左') margins.left += amount
    else if (direction === '右') margins.right += amount
    return ' '
  })

  return { cleanText, margins }
}

const parseGrid = (text, defaults = { rows: 1, cols: 1 }) => {
  const match = String(text || '').match(/(\d{1,2})\s*[xX*×]\s*(\d{1,2})/)
  const rows = match ? Number(match[1]) : defaults.rows
  const cols = match ? Number(match[2]) : defaults.cols
  validatePositive(rows, '行数')
  validatePositive(cols, '列数')
  if (rows > 20 || cols > 20) throw new Error('行列数过大，最大支持 20x20')
  return { rows, cols }
}

const parseDelayCentisecs = (text) => {
  const rawText = String(text || '')
  const fpsMatch = rawText.match(/(\d+(?:\.\d+)?)\s*fps/i)
  if (fpsMatch) {
    const fps = Number(fpsMatch[1])
    if (!Number.isFinite(fps) || fps <= 0 || fps > 100) throw new Error('FPS 必须是 0 到 100 之间的数字')
    return Math.max(1, Math.round(100 / fps))
  }

  const secondMatch = rawText.match(/(\d+(?:\.\d+)?)\s*s/i)
  if (secondMatch) {
    const seconds = Number(secondMatch[1])
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60) throw new Error('GIF 间隔秒数必须是 0 到 60 之间的数字')
    return Math.max(1, Math.round(seconds * 100))
  }

  const decimalMatch = rawText.match(/\d+\.\d+/)
  if (decimalMatch) {
    const seconds = Number(decimalMatch[0])
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60) throw new Error('GIF 间隔秒数必须是 0 到 60 之间的数字')
    return Math.max(1, Math.round(seconds * 100))
  }

  const match = rawText.match(/\d+/)
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

const ensureGif = (image) => {
  if (!Buffer.isBuffer(image) || !image.subarray(0, 6).toString('ascii').startsWith('GIF')) {
    throw new Error('请发送或引用 GIF')
  }
}

const runFfmpegGif = (image, filter) => new Promise((resolve, reject) => {
  const command = getConfig().ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg'
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-filter_complex', filter,
    '-map', '[out]',
    '-loop', '0',
    '-f', 'gif',
    'pipe:1'
  ]
  const chunks = []
  let outputSize = 0
  let stderr = ''
  let settled = false
  let timedOut = false
  const child = spawn(command, args, { windowsHide: true })
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, 60000)

  child.stdin.on('error', () => {})
  child.stdout.on('data', (chunk) => {
    const { maxOutputBytes } = getConfig()
    outputSize += chunk.length
    if (maxOutputBytes > 0 && outputSize > maxOutputBytes) {
      child.kill()
      if (!settled) {
        settled = true
        reject(new Error(`处理后图片过大，已超过 ${Math.round(maxOutputBytes / 1024 / 1024)}MB`))
      }
      return
    }
    chunks.push(chunk)
  })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  child.on('error', (error) => {
    clearTimeout(timer)
    if (settled) return
    settled = true
    if (error.code === 'ENOENT') {
      reject(new Error('未找到 ffmpeg，请先安装 ffmpeg 或配置 imageOps.ffmpegPath/FFMPEG_PATH'))
      return
    }
    reject(error)
  })
  child.on('close', (code) => {
    clearTimeout(timer)
    if (settled) return
    settled = true
    if (timedOut) {
      reject(new Error('ffmpeg 执行超时'))
      return
    }
    if (code !== 0) {
      const detail = stderr.trim()
      reject(new Error(detail ? `ffmpeg 执行失败: ${detail}` : 'ffmpeg 执行失败'))
      return
    }
    const buffer = Buffer.concat(chunks)
    if (!buffer.length) {
      reject(new Error('ffmpeg 未生成 GIF'))
      return
    }
    resolve(ensureOutputSize(buffer))
  })
  child.stdin.end(image)
})

const gifPalette = (filter) =>
  `${filter},split[s0][s1];[s0]palettegen=stats_mode=full:reserve_transparent=on[p];[s1][p]paletteuse=new=1:dither=none[out]`

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

const trimMargins = async (image, margins) => {
  const metadata = await metadataOf(image)
  const width = metadata.width || 0
  const height = metadata.height || 0
  if (!width || !height) throw new Error('无法读取图片尺寸')

  const left = margins.left
  const top = margins.top
  const right = width - margins.right
  const bottom = height - margins.bottom
  if (left >= right || top >= bottom) throw new Error(`边距无效：${width}x${height}`)

  if (Object.values(margins).every(value => value === 0)) return image
  return await sharp(image).extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer()
}

const imageToRaw = async (image, options = {}) => {
  const { data, info } = await sharp(image, { animated: false })
    .resize(options.resize)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

const rawToGifFrame = ({ data, width, height }, delayCentisecs, mode = 1) => {
  const buffer = Buffer.from(data)
  if (mode === 2) {
    for (let index = 0; index < buffer.length; index += 4) {
      buffer[index + 3] = buffer[index + 3] < 128 ? 0 : 255
    }
  }

  return new GifFrame(width, height, buffer, {
    delayCentisecs,
    disposalMethod: GifFrame.DisposeToBackgroundColor
  })
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

const encodeGif = async (frames, loops = 0, colorScope = Gif.LocalColorsOnly) => {
  ensureGifFrameCount(frames)
  GifUtil.quantizeWu(frames, 256)
  const gif = await new GifCodec().encodeGif(frames, { loops, colorScope })
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
  const raw = await imageToRaw(image, {
    resize: {
      width,
      height,
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 0 }
    }
  })
  return rawToGifFrame(raw, delayCentisecs)
}

const imageToCenteredGifFrame = async (image, width, height, delayCentisecs) => {
  const input = await sharp(image, { animated: false }).ensureAlpha().toBuffer()
  const metadata = await metadataOf(input)
  if (!metadata.width || !metadata.height) throw new Error('无法读取图片尺寸')

  const scale = Math.min(width / metadata.width, height / metadata.height)
  const resizedWidth = Math.max(1, Math.round(metadata.width * scale))
  const resizedHeight = Math.max(1, Math.round(metadata.height * scale))
  const resized = await sharp(input)
    .resize(resizedWidth, resizedHeight, { fit: 'fill' })
    .png()
    .toBuffer()

  const raw = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 0 }
    }
  }).composite([
    {
      input: resized,
      left: Math.floor((width - resizedWidth) / 2),
      top: Math.floor((height - resizedHeight) / 2)
    }
  ]).ensureAlpha().raw().toBuffer({ resolveWithObject: true })

  return rawToGifFrame({ data: raw.data, width: raw.info.width, height: raw.info.height }, delayCentisecs)
}

const cropGridBuffers = async (image, text) => {
  const { cleanText, margins } = parseMargins(text)
  const { rows, cols } = parseGrid(cleanText)
  const trimmed = await trimMargins(image, margins)
  const metadata = await metadataOf(trimmed)
  const width = metadata.width || 0
  const height = metadata.height || 0
  const cellWidth = Math.floor(width / cols)
  const cellHeight = Math.floor(height / rows)
  if (cellWidth < 1 || cellHeight < 1) throw new Error(`图片太小：${width}x${height}`)

  const buffers = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      buffers.push(ensureOutputSize(await sharp(trimmed)
        .extract({
          left: col * cellWidth,
          top: row * cellHeight,
          width: cellWidth,
          height: cellHeight
        })
        .png()
        .toBuffer()))
    }
  }
  return { buffers, rows, cols }
}

const spriteGif = async (images, text, mode = 1) => {
  const [image] = normalizeImages(images)
  const { cleanText, margins } = parseMargins(text)
  const { rows, cols } = parseGrid(cleanText, { rows: 6, cols: 6 })
  const delayCentisecs = parseDelayCentisecs(cleanText)
  const trimmed = await trimMargins(image, margins)
  const metadata = await metadataOf(trimmed)
  const width = metadata.width || 0
  const height = metadata.height || 0
  const cellWidth = Math.floor(width / cols)
  const cellHeight = Math.floor(height / rows)
  if (cellWidth < 2 || cellHeight < 2) throw new Error(`单格太小：${cellWidth}x${cellHeight}`)

  const frames = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const buffer = await sharp(trimmed)
        .extract({
          left: col * cellWidth,
          top: row * cellHeight,
          width: cellWidth,
          height: cellHeight
        })
        .png()
        .toBuffer()
      frames.push(rawToGifFrame(await imageToRaw(buffer), delayCentisecs, mode))
    }
  }

  return await encodeGif(frames, 0, mode === 2 ? Gif.GlobalColorsPreferred : Gif.LocalColorsOnly)
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

  async cropGrid (images, text) {
    ensureEnabled()
    const [image] = normalizeImages(images)
    const result = await cropGridBuffers(image, text)
    return { type: 'images', buffers: result.buffers, label: `裁剪 ${result.rows}x${result.cols}` }
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
    return { type: 'images', buffers, label: 'GIF拆帧' }
  },

  async gifMerge (images, text) {
    ensureEnabled()
    const normalized = normalizeImages(images, 2)
    const delayCentisecs = parseDelayCentisecs(text)
    const metadataList = await Promise.all(normalized.map(metadataOf))
    const width = Math.max(...metadataList.map(metadata => metadata.width || 0))
    const height = Math.max(...metadataList.map(metadata => metadata.height || 0))
    if (!width || !height) throw new Error('无法读取图片尺寸')

    const frames = await Promise.all(normalized.map(image => imageToCenteredGifFrame(image, width, height, delayCentisecs)))
    return await encodeGif(frames)
  },

  async spriteGif (images, text) {
    ensureEnabled()
    return await spriteGif(images, text, 1)
  },

  async spriteGifMode1 (images, text) {
    ensureEnabled()
    return await spriteGif(images, text, 1)
  },

  async spriteGifMode2 (images, text) {
    ensureEnabled()
    return await spriteGif(images, text, 2)
  },

  async gifReverse (images) {
    ensureEnabled()
    const [image] = normalizeImages(images)
    ensureGif(image)
    return await runFfmpegGif(image, gifPalette('reverse'))
  },

  async gifRebound (images) {
    ensureEnabled()
    const [image] = normalizeImages(images)
    ensureGif(image)
    return await runFfmpegGif(image, gifPalette('[0:v]split[main][back];[back]reverse[reversed];[main][reversed]concat=n=2:v=1:a=0'))
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
