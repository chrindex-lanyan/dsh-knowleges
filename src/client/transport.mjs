/** Raw, authenticated DSH Connection Fetch routes, not RPC envelope channels. */
export const KNOWLEDGE_ROUTE = 'api/knowledge-library'
const SQLITE_HEADER = 'SQLite format 3\0'

export class KnowledgeRequestError extends Error {
  constructor(code, message, status) {
    super(message)
    this.name = 'KnowledgeRequestError'
    this.code = code
    this.status = status
  }
}

function failure(response, envelope) {
  const error = envelope?.ok === false ? envelope.error : undefined
  if (typeof error?.code === 'string' && typeof error?.message === 'string') {
    return new KnowledgeRequestError(error.code, error.message, response.status)
  }
  if (response.status === 401 || response.status === 403) {
    return new KnowledgeRequestError('ACCESS_DENIED', '没有资料库权限，请在已登录的本机 DSH 所有者界面重试。', response.status)
  }
  if (response.status === 404) {
    return new KnowledgeRequestError('ROUTE_UNAVAILABLE', '资料库服务不可用，请确认 DSH 插件已启用。', response.status)
  }
  if (!response.ok) {
    return new KnowledgeRequestError('HTTP_ERROR', '资料库请求失败（HTTP ' + response.status + '）。', response.status)
  }
  return new KnowledgeRequestError('INVALID_RESPONSE', '资料库服务返回了无法识别的响应。', response.status)
}

async function readJson(response) {
  try { return await response.json() } catch { return undefined }
}

function pageFetch(path, options) {
  // ConnectionHandle.rpc.call adds an envelope; exact routes instead use the
  // official transport hook or the same document-relative browser transport.
  const transport = globalThis.__DSH_TRANSPORT__
  return typeof transport?.fetch === 'function'
    ? transport.fetch(path, options)
    : globalThis.fetch(path, { ...options, mode: 'same-origin' })
}

export function createKnowledgeApi(send = pageFetch) {
  const sessionModeListeners = new Set()
  async function post(path, body, signal) {
    signal?.throwIfAborted()
    try {
      const response = await send(path, {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
      signal?.throwIfAborted()
      return response
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error
      throw new KnowledgeRequestError('NETWORK_ERROR', '无法连接资料库服务，请检查 DSH 连接后重试。')
    }
  }

  async function rpc(op, parameters = {}, signal) {
    const response = await post(KNOWLEDGE_ROUTE, { ...parameters, op }, signal)
    const envelope = await readJson(response)
    signal?.throwIfAborted()
    if (!response.ok || envelope?.ok !== true) throw failure(response, envelope)
    return envelope.value
  }

  return {
    rpc,
    async setSessionTools(enabled, confirmed, signal) {
      if (typeof enabled !== 'boolean' || (enabled && confirmed !== true)) {
        throw new KnowledgeRequestError('TRIAL_CONFIRMATION_REQUIRED', '请确认当前资料库实例仅包含测试数据。')
      }
      const result = await rpc('setSessionTools', { enabled, ...(enabled && { confirmTrial: true }) }, signal)
      if (result?.mode !== (enabled ? 'trial' : 'preview')) {
        throw new KnowledgeRequestError('INVALID_RESPONSE', '无法确认会话工具状态，请刷新库列表。')
      }
      for (const listener of sessionModeListeners) listener(result.mode)
      return result
    },
    subscribeSessionMode(listener) {
      sessionModeListeners.add(listener)
      return () => { sessionModeListeners.delete(listener) }
    },
    async exportDatabase(ticket, signal) {
      const response = await post(KNOWLEDGE_ROUTE + '/export', { ticket }, signal)
      if (!response.ok || /^application\/(?:[^;]+\+)?json\b/i.test(response.headers.get('content-type') ?? '')) {
        throw failure(response, await readJson(response))
      }
      const blob = await response.blob()
      const signature = new TextDecoder().decode(await blob.slice(0, SQLITE_HEADER.length).arrayBuffer())
      signal?.throwIfAborted()
      if (signature !== SQLITE_HEADER) throw new KnowledgeRequestError('INVALID_EXPORT', '收到的文件不是有效的 SQLite 数据库，未下载。', response.status)
      return blob
    },
  }
}

export function sqliteFileName(value) {
  const leaf = (typeof value === 'string' ? value.split(/[\\/]/).at(-1) : '')
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069:*?"<>|]/g, '_')
    .trim().replace(/^\.+|[ .]+$/g, '')
  const stem = leaf.replace(/\.sqlite$/i, '').slice(0, 120)
  return (stem || 'knowledge-library') + '.sqlite'
}

export function downloadSQLite(blob, fileName) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = sqliteFileName(fileName)
  anchor.hidden = true
  try {
    document.body.append(anchor)
    anchor.click()
  } finally {
    anchor.remove()
    // The download is dispatched by the browser, which may resolve the URL
    // after the click handler has finished.
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }
}
