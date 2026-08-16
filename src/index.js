/**
 * @dsh-external/dsh-volcark-quota — host 侧（零依赖纯 JS）
 *
 * 火山方舟 Coding Plan / Agent Plan 额度查询：
 *  - 认证：AK/SK + HMAC-SHA256 V4 签名（Volcengine OpenAPI）
 *  - 接口：GetCodingPlanUsage / GetAgentPlanAFPUsage（POST https://open.volcengineapi.com/）
 *  - 服务：webServer 路由 /dsh-volcark-quota/snapshot（client 面板消费）
 *
 * 依赖：仅 node:crypto / node:https + webServer 服务。不 import 任何
 * cordis / schemastery / @deepseek-ai/* 包，避免 profile 依赖解析问题。
 *
 * 凭据来源优先级：请求体（面板传入）> 插件 Config > 环境变量
 * （VOLC_ACCESS_KEY_ID / VOLC_ACCESS_KEY_SECRET，兼容 ARK_* 前缀）。
 */

import { createHash, createHmac } from 'node:crypto'
import https from 'node:https'

export const name = 'dsh-volcark-quota'
export const inject = ['webServer']

const VOLC_HOST = 'open.volcengineapi.com'
const VOLC_REGION = 'cn-beijing'
const VOLC_SERVICE = 'ark'
const VOLC_VERSION = '2024-01-01'
const ACTIONS = { coding: 'GetCodingPlanUsage', agent: 'GetAgentPlanAFPUsage' }

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function normQuery(params) {
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&')
}

/** 官方要求的 X-Date 格式：yyyyMMdd'T'HHmmss'Z'（例如 20260816T184401Z）。 */
function formatXDate(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
}

/** Volcengine OpenAPI V4 签名（HMAC-SHA256），与官方参考实现一致。 */
function volcengineSign(ak, sk, method, path, query, body) {
  const xDate = formatXDate(new Date()) // 例如 20260816T184401Z
  const xDateShort = xDate.slice(0, 8) // 20260816
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex')

  const rawHeaders = {
    Host: VOLC_HOST,
    'X-Date': xDate,
    'X-Content-Sha256': bodyHash,
    'Content-Type': 'application/json',
  }
  const signed = {}
  for (const [k, v] of Object.entries(rawHeaders)) {
    const lk = k.toLowerCase()
    if (lk === 'content-type' || lk === 'host' || lk.startsWith('x-')) signed[lk] = v
  }
  const shKeys = Object.keys(signed).sort()
  const signedStr = shKeys.map((k) => `${k}:${signed[k]}\n`).join('')
  const sh = shKeys.join(';')

  const canonicalRequest = [method, path, normQuery(query), signedStr, sh, bodyHash].join('\n')
  const credentialScope = `${xDateShort}/${VOLC_REGION}/${VOLC_SERVICE}/request`
  const stringToSign = [
    'HMAC-SHA256',
    xDate,
    credentialScope,
    createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n')

  const hmac = (key, data) => createHmac('sha256', key).update(data, 'utf8').digest()
  const kDate = hmac(sk, xDateShort)
  const kRegion = hmac(kDate, VOLC_REGION)
  const kService = hmac(kRegion, VOLC_SERVICE)
  const kSigning = hmac(kService, 'request')
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

  return {
    ...rawHeaders,
    Authorization: `HMAC-SHA256 Credential=${ak}/${credentialScope}, SignedHeaders=${sh}, Signature=${signature}`,
  }
}

function callVolcengine(ak, sk, action) {
  const query = { Action: action, Version: VOLC_VERSION }
  const body = '{}'
  const headers = volcengineSign(ak, sk, 'POST', '/', query, body)
  const url = `https://${VOLC_HOST}/?${normQuery(query)}`
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk.toString('utf8') })
      res.on('end', () => {
        const status = res.statusCode ?? 0
        if (status >= 200 && status < 300) {
          try {
            resolve(JSON.parse(data))
          } catch {
            reject(new Error('火山方舟返回了非 JSON 响应'))
          }
        } else {
          reject(new Error(`火山方舟 API ${status}: ${data.slice(0, 400)}`))
        }
      })
    })
    req.on('error', (err) => reject(new Error(`请求火山方舟失败: ${err.message}`)))
    req.write(body)
    req.end()
  })
}

function parseDetails(result) {
  const list = Array.isArray(result.Details) ? result.Details : []
  return list.map((item) => ({
    time: item.Time ? String(item.Time) : null,
    objectName: item.ObjectName ? String(item.ObjectName) : '',
    usage: num(item.Usage),
    unit: item.Unit ? String(item.Unit) : '',
  }))
}

/** 兼容 Agent Plan（AFP）与 Coding Plan（QuotaUsage）两种响应结构。 */
function parseVolcengine(payload) {
  const root = (payload && typeof payload === 'object') ? payload : {}
  const result = (root.Result && typeof root.Result === 'object') ? root.Result : root

  // Agent Plan（AFP）：Result.AFPFiveHour / AFPWeekly / AFPMonthly
  const afpKeys = [
    ['5h', 'AFPFiveHour'],
    ['weekly', 'AFPWeekly'],
    ['monthly', 'AFPMonthly'],
  ]
  const afpWindows = []
  for (const [windowName, key] of afpKeys) {
    const item = result[key]
    if (!item || typeof item !== 'object') continue
    const quota = num(item.Quota)
    const used = num(item.Used)
    const usedPercent = quota && quota > 0 ? ((used ?? 0) / quota) * 100 : 0
    const resetAt = num(item.ResetTime)
    afpWindows.push({
      name: windowName,
      quota,
      used,
      usedPercent,
      remainingPercent: quota && quota > 0 ? Math.max(0, 100 - usedPercent) : 100,
      resetAt: resetAt && resetAt > 0 ? resetAt : null,
    })
  }
  if (afpWindows.length > 0) {
    return { plan: 'agent', windows: afpWindows, details: parseDetails(result) }
  }

  // Coding Plan：Result.QuotaUsage[]（Level / Percent / ResetTimestamp，秒）
  const quotaUsage = Array.isArray(result.QuotaUsage) ? result.QuotaUsage : []
  if (quotaUsage.length > 0) {
    const windows = quotaUsage.map((item) => {
      const usedPercent = num(item.Percent) ?? 0
      const resetSec = num(item.ResetTimestamp)
      return {
        name: String(item.Level ?? 'plan').toLowerCase(),
        quota: null,
        used: null,
        usedPercent,
        remainingPercent: Math.max(0, 100 - usedPercent),
        resetAt: resetSec && resetSec > 0 ? resetSec * 1000 : null,
      }
    })
    return { plan: 'coding', windows, details: parseDetails(result) }
  }

  throw new Error('无法识别的额度响应结构，请检查 AK/SK 权限与套餐订阅')
}

function resolveCredentials(config, akFromReq, skFromReq) {
  const env = process.env
  const ak = (akFromReq || config.accessKeyId || env.VOLC_ACCESS_KEY_ID || env.VOLC_ACCESS_KEY || env.ARK_ACCESS_KEY_ID || '').trim()
  const sk = (skFromReq || config.secretAccessKey || env.VOLC_ACCESS_KEY_SECRET || env.VOLC_SECRET_KEY || env.ARK_ACCESS_KEY_SECRET || '').trim()
  return { ak, sk }
}

async function fetchQuota(ak, sk, planType) {
  if (!ak || !sk) {
    throw new Error('未配置火山方舟 AK/SK：请在「设置 → 插件」页的「火山方舟额度」卡片中填写，或设置环境变量 VOLC_ACCESS_KEY_ID / VOLC_ACCESS_KEY_SECRET')
  }
  const types = planType === 'agent' ? ['agent'] : planType === 'coding' ? ['coding'] : ['coding', 'agent']
  let lastError = null
  for (const t of types) {
    try {
      const raw = await callVolcengine(ak, sk, ACTIONS[t] ?? ACTIONS.coding)
      const parsed = parseVolcengine(raw)
      return { ok: true, plan: t, ...parsed, updatedAt: Date.now() }
    } catch (e) {
      lastError = e
    }
  }
  throw lastError ?? new Error('额度查询失败')
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk.toString('utf8') })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

export function apply(ctx, config = {}) {
  // HTTP 路由：client 面板消费（POST JSON 或 GET query）
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-volcark-quota/snapshot',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://dsh.local')
        let ak = url.searchParams.get('ak') ?? undefined
        let sk = url.searchParams.get('sk') ?? undefined
        let planType = url.searchParams.get('planType') ?? config.planType ?? 'auto'
        if ((req.method || 'GET').toUpperCase() === 'POST') {
          const body = await readBody(req)
          if (body) {
            const parsed = JSON.parse(body)
            if (parsed.ak) ak = parsed.ak
            if (parsed.sk) sk = parsed.sk
            if (parsed.planType) planType = parsed.planType
          }
        }
        const cred = resolveCredentials(config, ak, sk)
        const snapshot = await fetchQuota(cred.ak, cred.sk, planType)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(snapshot))
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
      }
    },
  }), 'dsh-volcark-quota: snapshot route')
}
