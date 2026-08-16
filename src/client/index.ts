/**
 * @dsh-external/dsh-volcark-quota — client 侧
 *
 * 两处挂载：
 *  1. shell.overlay（root 级 list 插槽）：悬浮小球 + 可拖拽悬浮窗。
 *     · 收起 = 圆形小球（opencode-go FAB 风格：品牌渐变 + 红/黄/绿警告态），
 *       显示最高已用 %（两位小数），可拖动，点击展开。
 *     · 展开 = 悬浮窗（模仿 dsh-opencode-go-usage 查询面板）：
 *       stats 卡片（已用/剩余/重置）+ 每窗口 Donut 环形图 + 明细进度条。
 *  2. settings.plugin.item（设置 → 插件 → 配置区）：AK/SK/套餐类型配置卡片，
 *     模仿 DSH 自带 PluginCard 折叠卡样式（名称+描述头部、字段体、保存/丢弃底栏）。
 *
 * 数据经同源 POST /dsh-volcark-quota/snapshot 获取，60s 自动刷新，倒计时每秒跳。
 * 凭据存浏览器 localStorage，随请求发给本机 DSH 服务（host 不落盘、不上传）。
 * 设置卡片保存后 dispatch 自定义事件，悬浮窗立即刷新。
 *
 * 构建：npm run build:client（tsdown → lib/client.js，ModuleLoader.load 注册）。
 * ⚠️ 必坑：① apply 用 ctx.slots 必须 export const inject = ['slots']；
 * ② register 必须带 name 字段（= slot 名）；③ shell.overlay 是双参
 * register(options, component) 形式，component 为 React 组件。
 */
import React from 'react'
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'

type ClientContext = {
  slots: SlotsService
  effect(fn: () => unknown, label?: string): void
}

export const inject = ['slots']

const API_URL = '/dsh-volcark-quota/snapshot'
const CFG_URL = '/dsh-volcark-quota/config'
const CLEAR_URL = '/dsh-volcark-quota/clear'
const LS_PLAN = 'dsh-volcark-quota.plan'
const LS_OPEN = 'dsh-volcark-quota.open'
const LS_BALL = 'dsh-volcark-quota.ball'
const CRED_EVENT = 'dsh-volcark-quota:credentials'
const REFRESH_MS = 60000

const h = React.createElement

// ---------- 格式化（两位小数，与火山方舟控制台一致） ----------
function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return n.toFixed(2) + '%'
}
function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万'
  return String(Math.round(n))
}
function fmtClock(ts: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}
function fmtCountdown(ms: number): string {
  if (!ms || ms <= 0) return '已重置'
  const total = Math.floor(ms / 1000)
  const d = Math.floor(total / 86400)
  const hh = Math.floor((total % 86400) / 3600)
  const mm = Math.floor((total % 3600) / 60)
  const ss = total % 60
  if (d > 0) return d + '天 ' + hh + '时'
  if (hh > 0) return hh + '时 ' + mm + '分'
  return mm + '分 ' + ss + '秒'
}
function windowLabel(name: string): string {
  const map: Record<string, string> = { '5h': '5小时', weekly: '本周', monthly: '本月', daily: '今日', plan: '套餐' }
  return map[name] || name
}
function quotaColor(p: number): string {
  if (p >= 90) return 'var(--dsw-alias-state-error-primary, #ef4444)'
  if (p >= 70) return 'var(--dsw-alias-state-warn-primary, #f59e0b)'
  return 'var(--dsw-alias-state-success-primary, #22c55e)'
}
function loadPos(key: string, fallback: () => { x: number; y: number }) {
  try {
    const raw = localStorage.getItem(key)
    if (raw) {
      const p = JSON.parse(raw)
      if (typeof p.x === 'number' && typeof p.y === 'number') {
        return { x: Math.max(0, Math.min(p.x, window.innerWidth - 40)), y: Math.max(0, Math.min(p.y, window.innerHeight - 40)) }
      }
    }
  } catch { /* ignore */ }
  return fallback()
}

/** 面板锚定到小球：小球在屏幕右半 → 面板贴小球左侧；左半 → 右侧；纵向夹在视口内。 */
function panelFromBall(b: { x: number; y: number }): { x: number; y: number } {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  const PW = 400 // 面板宽度（与 CSS .vq-panel 一致）
  const GAP = 10
  const M = 8
  const cx = b.x + 31 // 小球中心
  let x = cx > vw / 2 ? b.x - PW - GAP : b.x + 62 + GAP
  x = Math.max(M, Math.min(x, vw - PW - M))
  const y = Math.max(M, Math.min(b.y, vh - 320 - M))
  return { x, y }
}

// ---------- CSS（设计语言：DSH `--dsw-alias-*` token + opencode-go 面板风格） ----------
const CSS = [
  '@keyframes vq-in{from{opacity:0;transform:scale(.97) translateY(4px)}to{opacity:1;transform:none}}',
  // 悬浮小球（opencode FAB 风格的圆形版）
  '.vq-ball{position:fixed;z-index:9999;width:62px;height:62px;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;cursor:grab;user-select:none;border:1px solid var(--dsw-alias-border-l2,#e5e5e5);background:linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-brand-primary,#4f8cff) 24%,transparent),transparent),var(--dsw-alias-bg-overlay,#fff);box-shadow:0 4px 16px rgba(0,0,0,.20);transition:filter .15s ease,transform .1s ease,border-color .3s ease,background .3s ease;animation:vq-in .18s ease}',
  '.vq-ball:hover{filter:brightness(1.12)}',
  '.vq-ball:active{cursor:grabbing;transform:scale(.95)}',
  '.vq-ball,.vq-titlebar{touch-action:none}',
  '.vq-ball.vq-warn-mid{border-color:var(--dsw-alias-state-warn-primary,#f59e0b)}',
  '.vq-ball.vq-warn-hi{border-color:var(--dsw-alias-state-error-primary,#ef4444);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 16%,transparent),var(--dsw-alias-bg-overlay,#fff)}',
  '.vq-ball-num{font-size:13px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1;letter-spacing:-.01em}',
  '.vq-ball-lbl{font-size:9px;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.55));line-height:1}',
  // 悬浮窗（模仿 opencode-go UsagePanel）
  '.vq-panel{position:fixed;z-index:9999;display:flex;flex-direction:column;width:400px;min-width:300px;max-width:92vw;max-height:84vh;border:1px solid var(--dsw-alias-border-l2,#e5e5e5);border-radius:12px;background:var(--dsw-alias-bg-base,#fafafa);box-shadow:0 12px 48px rgba(0,0,0,.32);overflow:hidden;animation:vq-in .16s ease;color:var(--dsw-alias-label-primary,#1a1a1a)}',
  '.vq-titlebar{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:move;user-select:none;background:linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-brand-primary,#4f8cff) 16%,transparent),transparent),var(--dsw-alias-bg-layer-1,#fff);border-bottom:1px solid var(--dsw-alias-border-l1,#eee)}',
  '.vq-title{font-size:13px;font-weight:700;color:var(--dsw-alias-label-primary,#1a1a1a);letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.vq-badge{font-size:10px;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,#eee);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f8cff) 14%,transparent);color:var(--dsw-alias-brand-primary,#4f8cff);white-space:nowrap}',
  '.vq-spacer{flex:1}',
  '.vq-ibtn{background:none;border:none;cursor:pointer;color:var(--dsw-alias-label-secondary,#333);font-size:12px;padding:2px 6px;border-radius:6px;line-height:1}',
  '.vq-ibtn:hover{background:var(--dsw-alias-bg-layer-2,#f2f2f2);color:var(--dsw-alias-label-primary,#1a1a1a)}',
  '.vq-ibtn:disabled{opacity:.5;cursor:default}',
  '.vq-body{flex:1;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:10px;font-size:12px;color:var(--dsw-alias-label-secondary,#333)}',
  '.vq-stats{display:flex;gap:8px}',
  '.vq-stat{flex:1;display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,#eee);background:linear-gradient(160deg,color-mix(in srgb,var(--dsw-alias-brand-primary,#4f8cff) 12%,transparent),transparent 70%),var(--dsw-alias-bg-layer-1,#fff)}',
  '.vq-stat-label{font-size:10px;color:var(--dsw-alias-label-secondary,#333)}',
  '.vq-stat-value{font-size:18px;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:-.02em;color:var(--dsw-alias-label-primary,#1a1a1a)}',
  '.vq-stat-sub{font-size:10px;color:var(--dsw-alias-label-secondary,#333);opacity:.85}',
  '.vq-quota{display:flex;gap:10px;justify-content:space-around;padding:10px 8px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,#eee);background:var(--dsw-alias-bg-layer-1,#fff)}',
  '.vq-donut-wrap{display:flex;flex-direction:column;align-items:center;gap:2px}',
  '.vq-donut{width:76px;height:76px}',
  '.vq-donut-val{fill:var(--dsw-alias-label-primary,#1a1a1a);font-size:13px;font-weight:800}',
  '.vq-donut-lbl{fill:var(--dsw-alias-label-secondary,#333);font-size:9px}',
  '.vq-donut-time{font-size:9px;color:var(--dsw-alias-label-secondary,#333)}',
  '.vq-panel2{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,#eee);background:var(--dsw-alias-bg-layer-1,#fff)}',
  '.vq-ptitle{font-size:10px;font-weight:700;color:var(--dsw-alias-label-secondary,#333);text-transform:uppercase;letter-spacing:.06em}',
  '.vq-prow{display:flex;align-items:center;gap:8px}',
  '.vq-pname{width:64px;flex:none;color:var(--dsw-alias-label-primary,#1a1a1a);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.vq-pbar{flex:1;height:8px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,#f2f2f2);overflow:hidden}',
  '.vq-pbar-fill{height:100%;border-radius:4px;background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-brand-primary,#4f8cff) 40%,transparent),var(--dsw-alias-brand-primary,#4f8cff));transition:width .3s ease}',
  '.vq-pcost{width:108px;flex:none;text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#1a1a1a);font-weight:600;font-size:11px}',
  '.vq-warn{border:1px solid rgba(245,158,11,.6);background:rgba(245,158,11,.10);border-radius:10px;padding:8px 12px;font-size:12px;color:var(--dsw-alias-state-warn-primary,#b45309);line-height:1.5}',
  '.vq-err{border:1px solid rgba(239,68,68,.5);background:rgba(239,68,68,.08);border-radius:10px;padding:10px 12px;font-size:12px;color:var(--dsw-alias-state-error-primary,#ef4444);line-height:1.5;white-space:pre-wrap}',
  '.vq-loading{font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.55));padding:18px 0;text-align:center}',
  '.vq-foot{padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l1,#eee);font-size:10px;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.55));display:flex;justify-content:space-between;align-items:center;gap:8px}',
  // 设置 → 插件 配置卡片（模仿 DSH PluginCard 折叠卡）
  '.vq-card{list-style:none;border:1px solid var(--dsw-alias-border-l2,#e5e5e5);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);overflow:hidden}',
  '.vq-card-header{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:none;border:none;cursor:pointer;padding:12px 16px;font:inherit;color:inherit}',
  '.vq-card-header:hover{background:var(--dsw-alias-bg-layer-2,#f2f2f2)}',
  '.vq-card-headtext{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}',
  '.vq-card-name{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#1a1a1a)}',
  '.vq-card-desc{font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.55));line-height:1.4}',
  '.vq-card-pending{font-size:10px;font-weight:600;color:var(--dsw-alias-state-warn-primary,#b45309);border:1px solid rgba(245,158,11,.5);background:rgba(245,158,11,.08);border-radius:999px;padding:2px 8px;white-space:nowrap}',
  '.vq-card-chevron{color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.55));transition:transform .2s ease;flex:none}',
  '.vq-card-chevron-open{transform:rotate(180deg)}',
  '.vq-card-body{display:flex;flex-direction:column;gap:10px;padding:4px 16px 16px;border-top:1px solid var(--dsw-alias-border-l1,#eee)}',
  '.vq-card-field{display:flex;flex-direction:column;gap:4px}',
  '.vq-card-label{font-size:11px;color:var(--dsw-alias-label-secondary,rgba(0,0,0,.6))}',
  '.vq-card-input{border:1px solid var(--dsw-alias-border-l2,#e5e5e5);background:var(--dsw-alias-bg-layer-3,#fff);border-radius:8px;padding:7px 10px;font-size:12px;color:var(--dsw-alias-label-primary,#1a1a1a);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
  '.vq-card-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4f8cff)}',
  '.vq-card-select{border:1px solid var(--dsw-alias-border-l2,#e5e5e5);background:var(--dsw-alias-bg-layer-3,#fff);border-radius:8px;padding:6px 8px;font-size:12px;color:var(--dsw-alias-label-primary,#1a1a1a)}',
  '.vq-card-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.5));line-height:1.5}',
  '.vq-card-footer{display:flex;align-items:center;gap:10px;padding-top:4px}',
  '.vq-card-discard{background:none;border:1px solid var(--dsw-alias-border-l2,#e5e5e5);color:var(--dsw-alias-label-secondary,#333);border-radius:8px;padding:6px 14px;font-size:12px;cursor:pointer}',
  '.vq-card-discard:hover{background:var(--dsw-alias-bg-layer-2,#f2f2f2)}',
  '.vq-card-save{background:var(--dsw-alias-label-primary,#1a1a1a);border:none;color:var(--dsw-alias-bg-layer-3,#fff);border-radius:8px;padding:6px 18px;font-size:12px;font-weight:600;cursor:pointer}',
  '.vq-card-save:hover{filter:brightness(1.15)}',
  '.vq-card-saved{font-size:12px;color:var(--dsw-alias-state-success-primary,#16a34a);font-weight:600}',
].join('\n')

// ---------- 类型 ----------
type WindowT = { name: string; quota: number | null; used: number | null; usedPercent: number; remainingPercent: number; resetAt: number | null }
type SnapshotT = { ok: boolean; plan: string; windows: WindowT[]; updatedAt: number }

// ---------- Donut 环形图（模仿 opencode-go） ----------
function Donut(props: { percent: number; label: string; resetsAt: number | null; now: number }): React.ReactElement {
  const p = Math.max(0, Math.min(100, props.percent || 0))
  const r = 28
  const c = 2 * Math.PI * r
  const resetIn = props.resetsAt ? props.resetsAt - props.now : null
  return h('div', { className: 'vq-donut-wrap' },
    h('svg', { className: 'vq-donut', viewBox: '0 0 76 76' },
      h('circle', { cx: 38, cy: 38, r, fill: 'none', stroke: 'var(--dsw-alias-bg-layer-2,#f2f2f2)', strokeWidth: 9 }),
      h('circle', { cx: 38, cy: 38, r, fill: 'none', stroke: quotaColor(p), strokeWidth: 9, strokeLinecap: 'round', strokeDasharray: (p / 100) * c + ' ' + c, transform: 'rotate(-90 38 38)', style: { transition: 'stroke-dasharray .5s ease' } }),
      h('text', { x: 38, y: 34, textAnchor: 'middle', className: 'vq-donut-val' }, fmtPct(p)),
      h('text', { x: 38, y: 48, textAnchor: 'middle', className: 'vq-donut-lbl' }, props.label),
    ),
    h('span', { className: 'vq-donut-time' }, resetIn != null ? fmtCountdown(resetIn) + ' 后重置' : '重置时间未知'),
  )
}

// ---------- 悬浮小球 + 悬浮窗 ----------
function QuotaFloater(): React.ReactElement {
  const [data, setData] = React.useState<SnapshotT | null>(null)
  const [error, setError] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [open, setOpen] = React.useState(() => localStorage.getItem(LS_OPEN) === '1')
  const [ball, setBall] = React.useState(() => loadPos(LS_BALL, () => ({ x: (typeof window !== 'undefined' ? window.innerWidth : 1200) - 78, y: (typeof window !== 'undefined' ? window.innerHeight : 800) - 146 })))
  const [win, setWin] = React.useState(() => ({ x: (typeof window !== 'undefined' ? window.innerWidth : 1200) - 420, y: 80 }))
  const [now, setNow] = React.useState(Date.now())
  const dragRef = React.useRef<{ startX: number; startY: number; origX: number; origY: number; moved: boolean; latestX?: number; latestY?: number; pointerId: number; target: HTMLElement } | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      // AK/SK 不经过浏览器：由 host 从 DSH 凭据库（ctx.credentials）解析
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planType: localStorage.getItem(LS_PLAN) || 'auto' }),
      })
      const json = await res.json()
      if (!json.ok) throw new Error(json.error || '额度查询失败')
      setData(json)
      setError('')
    } catch (e) {
      setError(String((e as Error).message || e))
    } finally {
      setLoading(false)
    }
  }, [])

  // 首次加载 + 60s 自动刷新 + 凭据事件即时刷新
  React.useEffect(() => {
    load()
    const t = setInterval(load, REFRESH_MS)
    const onCred = () => load()
    window.addEventListener(CRED_EVENT, onCred)
    return () => {
      clearInterval(t)
      window.removeEventListener(CRED_EVENT, onCred)
    }
  }, [load])

  // 倒计时每秒刷新
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const toggleOpen = (next: boolean) => {
    setOpen(next)
    localStorage.setItem(LS_OPEN, next ? '1' : '0')
  }

  /** 从小球展开：面板锚定在小球所在位置（右半屏贴左、左半屏贴右、夹在视口内）。 */
  const openFromBall = () => {
    setWin(panelFromBall(ball))
    toggleOpen(true)
  }

  /** 收起回小球：小球出现在面板收起位置（按展开时的小球侧判定，放回面板旁边）。 */
  const closeToBall = () => {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1200
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800
    const PW = 400
    const GAP = 10
    const M = 8
    const cx = ball.x + 31
    // 与 panelFromBall 同一判据：展开时面板锚在小球哪一侧，收起时小球就回到面板那一侧的旁边
    const panelOnLeft = cx > vw / 2
    let nx = panelOnLeft ? win.x + PW + GAP : win.x - 62 - GAP
    nx = Math.max(M, Math.min(nx, vw - 62 - M))
    const ny = Math.max(M, Math.min(win.y, vh - 62 - M))
    const nb = { x: nx, y: ny }
    setBall(nb)
    localStorage.setItem(LS_BALL, JSON.stringify(nb))
    toggleOpen(false)
  }

  // 拖动通用逻辑（Pointer Events：鼠标 / 触摸 / 笔统一；setPointerCapture 保证不丢指针）
  const startDrag = (e: React.PointerEvent, kind: 'ball' | 'win') => {
    if (e.pointerType === 'mouse' && e.button !== 0) return // 仅左键
    // 按下目标是交互控件（按钮/链接/输入等）时不启动拖动，
    // 否则 setPointerCapture 会把后续 click 吞掉，导致标题栏内按钮失效
    const t = e.target as HTMLElement | null
    if (t && t.closest && t.closest('button, a, input, select, textarea')) return
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const orig = kind === 'ball' ? ball : win
    const target = e.currentTarget as HTMLElement
    try { target.setPointerCapture(e.pointerId) } catch { /* ignore */ }
    dragRef.current = { startX, startY, origX: orig.x, origY: orig.y, moved: false, pointerId: e.pointerId, target }
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d || d.pointerId !== ev.pointerId) return
      const dx = ev.clientX - d.startX
      const dy = ev.clientY - d.startY
      if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true
      const w = kind === 'ball' ? 62 : 400
      const hh = kind === 'ball' ? 62 : 60
      const x = Math.min(Math.max(0, d.origX + dx), window.innerWidth - w)
      const y = Math.min(Math.max(0, d.origY + dy), window.innerHeight - hh)
      d.latestX = x
      d.latestY = y
      if (kind === 'ball') setBall({ x, y })
      else setWin({ x, y })
    }
    const end = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d || d.pointerId !== ev.pointerId) return
      dragRef.current = null
      try { d.target.releasePointerCapture(d.pointerId) } catch { /* ignore */ }
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      const final = { x: d.latestX ?? d.origX, y: d.latestY ?? d.origY }
      if (kind === 'ball') {
        if (!d.moved) openFromBall()
        else localStorage.setItem(LS_BALL, JSON.stringify(final))
      }
      // 面板位置不持久化：每次从小球展开都会重新锚定到小球
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  const windows = data?.windows ?? []
  const maxUsed = windows.length ? Math.max(...windows.map((w) => w.usedPercent)) : 0
  const hottest = windows.length ? windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a), windows[0]) : null
  const nearestReset = windows.length
    ? windows.reduce<number | null>((acc, w) => {
        const t = w.resetAt ?? Infinity
        return acc === null ? t : Math.min(acc, t)
      }, null)
    : null
  const hot = windows.filter((w) => w.usedPercent >= 90)
  const ballVal = error ? '!' : (data ? fmtPct(maxUsed) : '…')
  const ballSub = error ? '错误' : (data ? '已用' : '加载')
  const ballLevel = error || maxUsed >= 90 ? 'vq-warn-hi' : maxUsed >= 70 ? 'vq-warn-mid' : ''

  // ── 收起：悬浮小球 ──
  if (!open) {
    return h('div', {
      className: 'vq-ball ' + ballLevel,
      style: { left: ball.x, top: ball.y },
      onPointerDown: (e: React.PointerEvent) => startDrag(e, 'ball'),
      title: '火山方舟额度 · 点击展开（' + (error || (data ? '已用 ' + fmtPct(maxUsed) : '加载中')) + '）',
    },
      h('span', { className: 'vq-ball-num', style: { color: quotaColor(error ? 100 : maxUsed) } }, ballVal),
      h('span', { className: 'vq-ball-lbl' }, ballSub),
    )
  }

  // ── 展开：悬浮窗（opencode-go 风格） ──
  const children: React.ReactNode[] = []

  children.push(
    h('div', { key: 'titlebar', className: 'vq-titlebar', onPointerDown: (e: React.PointerEvent) => startDrag(e, 'win') },
      h('span', { className: 'vq-title' }, '火山方舟 · 额度'),
      h('span', { className: 'vq-badge' }, data ? (data.plan === 'agent' ? 'Agent Plan' : 'Coding Plan') : '…'),
      h('span', { className: 'vq-spacer' }),
      h('button', { key: 'refresh', className: 'vq-ibtn', onClick: () => load(), title: '立即刷新', disabled: loading }, '刷新'),
      h('button', { key: 'close', className: 'vq-ibtn', onClick: () => closeToBall(), title: '收起为小球' }, '收起'),
    ),
  )

  const body: React.ReactNode[] = []

  if (loading && !data) body.push(h('div', { key: 'loading', className: 'vq-loading' }, '加载中…'))
  if (error) {
    body.push(h('div', { key: 'err', className: 'vq-err' },
      error + '\n\n提示：AK/SK 请在「设置 → 插件」页的「火山方舟额度」卡片里填写（存于 DSH 凭据库，浏览器不保存密钥）。',
    ))
  }
  if (hot.length > 0) {
    body.push(h('div', { key: 'warn', className: 'vq-warn' },
      '⚠️ 额度即将耗尽：' + hot.map((w) => windowLabel(w.name) + ' ' + fmtPct(w.usedPercent)).join(' · '),
    ))
  }

  if (data && data.windows.length > 0) {
    // stats 卡片行
    body.push(
      h('div', { key: 'stats', className: 'vq-stats' },
        h('div', { className: 'vq-stat' },
          h('span', { className: 'vq-stat-label' }, '已用（最高）'),
          h('span', { className: 'vq-stat-value', style: { color: quotaColor(maxUsed) } }, fmtPct(maxUsed)),
          h('span', { className: 'vq-stat-sub' }, hottest ? windowLabel(hottest.name) : ''),
        ),
        h('div', { className: 'vq-stat' },
          h('span', { className: 'vq-stat-label' }, '剩余'),
          h('span', { className: 'vq-stat-value' }, fmtPct(hottest ? hottest.remainingPercent : null)),
          h('span', { className: 'vq-stat-sub' }, hottest ? '占' + windowLabel(hottest.name) : ''),
        ),
        h('div', { className: 'vq-stat' },
          h('span', { className: 'vq-stat-label' }, '最近重置'),
          h('span', { className: 'vq-stat-value', style: { fontSize: 14 } }, nearestReset != null && nearestReset !== Infinity ? fmtCountdown(nearestReset - now) : '—'),
          h('span', { className: 'vq-stat-sub' }, '自动刷新 60s'),
        ),
      ),
    )

    // Donut 环形图行（每窗口一个）
    body.push(
      h('div', { key: 'donuts', className: 'vq-quota' },
        data.windows.map((w) =>
          h(Donut, { key: w.name, percent: w.usedPercent, label: windowLabel(w.name), resetsAt: w.resetAt, now }),
        ),
      ),
    )

    // 窗口明细进度条
    body.push(
      h('div', { key: 'detail', className: 'vq-panel2' },
        h('span', { className: 'vq-ptitle' }, '窗口明细'),
        data.windows.map((w) => {
          const color = quotaColor(w.usedPercent)
          const resetIn = w.resetAt ? w.resetAt - now : null
          return h('div', { key: w.name, className: 'vq-prow' },
            h('span', { className: 'vq-pname' }, windowLabel(w.name)),
            h('div', { className: 'vq-pbar' },
              h('div', { className: 'vq-pbar-fill', style: { width: Math.max(2, Math.min(100, w.usedPercent)) + '%', background: color } }),
            ),
            h('span', { className: 'vq-pcost' },
              fmtPct(w.usedPercent) + ' · ' + (w.used !== null ? fmtNum(w.used) + '/' + (w.quota ? fmtNum(w.quota) : '?') : '') + (resetIn != null ? ' · ' + fmtCountdown(resetIn) : ''),
            ),
          )
        }),
      ),
    )
  } else if (data && !error) {
    body.push(h('div', { key: 'empty', className: 'vq-loading' }, '暂无额度数据（可能未订阅 Coding/Agent Plan）'))
  }

  children.push(h('div', { key: 'body', className: 'vq-body' }, body))

  children.push(
    h('div', { key: 'foot', className: 'vq-foot' },
      h('span', null, '更新 ' + (data ? fmtClock(data.updatedAt) : '—') + ' · 每 60s'),
    ),
  )

  return h('div', { className: 'vq-panel', style: { left: win.x, top: win.y } }, children)
}

// ---------- 设置 → 插件 配置卡片（模仿 DSH PluginCard 折叠卡） ----------
function Chevron(): React.ReactElement {
  return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    h('path', { d: 'M4 6l4 4 4-4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
  )
}

type CfgState = { configured: boolean; source?: string; writable: boolean }

function ConfigCard(): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const [ak, setAk] = React.useState('')
  const [sk, setSk] = React.useState('')
  const [plan, setPlan] = React.useState(() => localStorage.getItem(LS_PLAN) || 'auto')
  const [akCfg, setAkCfg] = React.useState<CfgState>({ configured: false, writable: true })
  const [skCfg, setSkCfg] = React.useState<CfgState>({ configured: false, writable: true })
  const [dirty, setDirty] = React.useState(false)
  const [saved, setSaved] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState('')

  const refreshStatus = React.useCallback(async () => {
    try {
      const res = await fetch(CFG_URL)
      const j = await res.json()
      if (j.ok) {
        setAkCfg({ configured: !!j.ak.configured, source: j.ak.source, writable: !!j.ak.writable })
        setSkCfg({ configured: !!j.sk.configured, source: j.sk.source, writable: !!j.sk.writable })
      }
    } catch { /* host 未就绪时忽略 */ }
  }, [])

  React.useEffect(() => {
    refreshStatus()
  }, [refreshStatus])

  const edit = (setter: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setter(e.target.value)
    setDirty(true)
    setSaved(false)
    setErr('')
  }

  const save = async () => {
    setBusy(true)
    setErr('')
    try {
      const res = await fetch(CFG_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ak, sk }),
      })
      const j = await res.json()
      if (!j.ok) throw new Error(j.error || '保存失败')
      localStorage.setItem(LS_PLAN, plan)
      setAk('')
      setSk('')
      setDirty(false)
      setSaved(true)
      await refreshStatus()
      window.dispatchEvent(new CustomEvent(CRED_EVENT))
      setTimeout(() => setSaved(false), 1600)
    } catch (e2) {
      setErr(String((e2 as Error).message || e2))
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    setBusy(true)
    setErr('')
    try {
      const res = await fetch(CLEAR_URL, { method: 'POST' })
      const j = await res.json()
      if (!j.ok) throw new Error(j.error || '清除失败')
      setAk('')
      setSk('')
      setDirty(false)
      await refreshStatus()
      window.dispatchEvent(new CustomEvent(CRED_EVENT))
    } catch (e2) {
      setErr(String((e2 as Error).message || e2))
    } finally {
      setBusy(false)
    }
  }

  const anyWritable = akCfg.writable || skCfg.writable

  return h('li', { className: 'vq-card' },
    h('button', { type: 'button', className: 'vq-card-header', 'aria-expanded': open, onClick: () => setOpen(!open) },
      h('span', { className: 'vq-card-headtext' },
        h('span', { className: 'vq-card-name' }, '火山方舟额度'),
        h('span', { className: 'vq-card-desc' }, 'Coding Plan / Agent Plan 额度实时查看的访问密钥与套餐类型'),
      ),
      dirty ? h('span', { className: 'vq-card-pending' }, '未保存') : null,
      h('span', { className: 'vq-card-chevron' + (open ? ' vq-card-chevron-open' : '') }, h(Chevron)),
    ),
    open ? h('div', { className: 'vq-card-body' },
      h('div', { className: 'vq-card-field' },
        h('label', { className: 'vq-card-label', htmlFor: 'vq-cfg-ak' }, 'AccessKey ID' + (akCfg.configured ? '（已配置' + (akCfg.source ? ' · ' + akCfg.source : '') + '）' : '（未配置）')),
        h('input', { id: 'vq-cfg-ak', className: 'vq-card-input', value: ak, placeholder: 'AKLT…', disabled: !akCfg.writable, onChange: edit(setAk) }),
      ),
      h('div', { className: 'vq-card-field' },
        h('label', { className: 'vq-card-label', htmlFor: 'vq-cfg-sk' }, 'Secret AccessKey' + (skCfg.configured ? '（已配置' + (skCfg.source ? ' · ' + skCfg.source : '') + '）' : '（未配置）')),
        h('input', { id: 'vq-cfg-sk', className: 'vq-card-input', type: 'password', value: sk, placeholder: '留空并保存 = 清除该项', disabled: !skCfg.writable, onChange: edit(setSk) }),
      ),
      h('div', { className: 'vq-card-field' },
        h('label', { className: 'vq-card-label', htmlFor: 'vq-cfg-plan' }, '套餐类型'),
        h('select', { id: 'vq-cfg-plan', className: 'vq-card-select', value: plan, onChange: edit(setPlan) },
          h('option', { value: 'auto' }, '自动探测（coding → agent）'),
          h('option', { value: 'coding' }, 'Coding Plan'),
          h('option', { value: 'agent' }, 'Agent Plan'),
        ),
      ),
      h('div', { className: 'vq-card-hint' },
        '密钥存于 DSH 凭据库（~/.dsh/.credentials.yaml，环境变量优先），浏览器不保存密钥、host 只报状态不返回值。' +
        (!anyWritable ? ' 当前凭据来自只读来源（环境变量），请在环境变量处修改。' : ''),
      ),
      err ? h('div', { className: 'vq-err' }, err) : null,
      h('div', { className: 'vq-card-footer' },
        saved ? h('span', { className: 'vq-card-saved' }, '已保存，悬浮球已刷新 ✓') : null,
        h('span', { className: 'vq-spacer' }),
        anyWritable ? h('button', { type: 'button', className: 'vq-card-discard', onClick: clear, disabled: busy }, '清除凭据') : null,
        h('button', { type: 'button', className: 'vq-card-save', onClick: save, disabled: busy || !dirty }, busy ? '保存中…' : '保存'),
      ),
    ) : null,
  )
}

export function apply(ctx: ClientContext): void {
  // 注入 CSS（幂等）
  if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-volcark-quota"]') === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-volcark-quota'
    tag.dataset.pluginCss = 'dsh-volcark-quota'
    tag.textContent = CSS
    document.head.appendChild(tag)
  }

  // 悬浮小球 + 悬浮窗
  ctx.effect(() => ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'dsh-volcark-quota-overlay', order: 60 },
      QuotaFloater,
    ),
  ), 'dsh-volcark-quota: overlay floater')

  // 设置 → 插件 → 配置卡片
  ctx.effect(() => ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register(
      { name: 'settings.plugin.item', id: 'dsh-volcark-quota', order: 90 },
      ConfigCard,
    ),
  ), 'dsh-volcark-quota: config card')
}
