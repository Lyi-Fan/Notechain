const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MANAGED_IMAGE = /^\/attachments\/([a-f0-9]{64})\.(png|jpg|gif|webp)$/
const MIME_BY_EXTENSION: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

function imageError(message: string): never { throw new Error(message) }

function inspectImage(bytes: Uint8Array): { ext: keyof typeof MIME_BY_EXTENSION; mime: string } {
  if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) imageError('单张图片不能超过 20 MB')
  let ext: keyof typeof MIME_BY_EXTENSION | undefined
  if (bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) && String.fromCharCode(...bytes.slice(12, 16)) === 'IHDR') ext = 'png'
  else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ext = 'jpg'
  else if (bytes.length >= 10 && (String.fromCharCode(...bytes.slice(0, 6)) === 'GIF87a' || String.fromCharCode(...bytes.slice(0, 6)) === 'GIF89a')) ext = 'gif'
  else if (bytes.length >= 16 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') ext = 'webp'
  if (!ext) imageError('仅支持 PNG、JPEG、GIF 和 WebP 图片')
  return { ext, mime: MIME_BY_EXTENSION[ext] }
}

function attachmentSource(hash: string, ext: string) { return `/attachments/${hash}.${ext}` }

async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) imageError('当前浏览器无法安全保存图片')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
}

function openImageDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('Local image storage is unavailable in this browser')); return }
    const request = indexedDB.open('asset-ledger-images-v1', 1)
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('images')) request.result.createObjectStore('images') }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Unable to open local image storage'))
  })
}

async function putImage(hash: string, blob: Blob): Promise<void> {
  const database = await openImageDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('images', 'readwrite')
      transaction.objectStore('images').put(blob, hash)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('Unable to store image'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Unable to store image'))
    })
  } finally { database.close() }
}

async function getImage(hash: string): Promise<Blob | undefined> {
  const database = await openImageDatabase()
  try {
    return await new Promise<Blob | undefined>((resolve, reject) => {
      const request = database.transaction('images', 'readonly').objectStore('images').get(hash)
      request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : undefined)
      request.onerror = () => reject(request.error ?? new Error('Unable to read image'))
    })
  } finally { database.close() }
}

function safeName(name: string, ext: string) {
  const basename = name.split(/[\\/]/).pop()?.replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').trim()
  return (basename || `image.${ext}`).slice(0, 180)
}

export async function storeImage(file: File): Promise<{ src: string; name: string }> {
  if (!(file instanceof File)) imageError('请选择图片文件')
  if (file.size > MAX_IMAGE_BYTES) imageError('单张图片不能超过 20 MB')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const image = inspectImage(bytes)
  const nativeStore = window.assetLedgerDesktop?.importImage
  if (nativeStore) return nativeStore({ bytes, name: safeName(file.name, image.ext) })
  const hash = await sha256(bytes)
  await putImage(hash, new Blob([bytes], { type: image.mime }))
  return { src: attachmentSource(hash, image.ext), name: safeName(file.name, image.ext) }
}

export async function resolveImage(src: string): Promise<{ url: string; revoke?: () => void }> {
  if (/^https?:\/\//i.test(src)) return { url: src }
  const match = MANAGED_IMAGE.exec(src)
  if (!match) imageError('图片来源不受支持，请重新导入图片')
  if (window.assetLedgerDesktop?.imageUrl) return { url: window.assetLedgerDesktop.imageUrl(src) }
  if (window.assetLedgerDesktop?.readImage) return { url: src }
  const blob = await getImage(match[1])
  if (!blob) imageError('此设备未保存这张图片')
  const url = URL.createObjectURL(blob)
  return { url, revoke: () => URL.revokeObjectURL(url) }
}

export { MAX_IMAGE_BYTES }
