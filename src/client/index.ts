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
  const map: Record<string, string> = { '5h': '5小时', session: '5小时', weekly: '本周', monthly: '本月', daily: '今日', plan: '套餐' }
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
  const PW = Math.min(448, vw - 24) // 面板宽度（与 CSS .vq-panel 一致）
  const GAP = 10
  const M = 8
  const cx = b.x + 32 // 小球中心
  let x = cx > vw / 2 ? b.x - PW - GAP : b.x + 64 + GAP
  x = Math.max(M, Math.min(x, vw - PW - M))
  const y = Math.max(M, Math.min(b.y, vh - 560 - M))
  return { x, y }
}

// ---------- CSS（设计语言：克制的工作台面板 + DSH `--dsw-alias-*` token） ----------
const CSS = [
  '@keyframes vq-in{from{opacity:0;transform:scale(.96) translateY(6px)}to{opacity:1;transform:none}}',
  '@keyframes vq-pulse{0%,100%{opacity:.5;transform:scale(.94)}50%{opacity:1;transform:scale(1)}}',
  // 悬浮球：用状态环和短标签表达信息，不再像一个孤立的圆形按钮。
  '.vq-ball{position:fixed;z-index:9999;width:64px;height:64px;border-radius:20px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;cursor:grab;user-select:none;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#5b8cff) 40%,var(--dsw-alias-border-l2,#e5e5e5));background:var(--dsw-alias-bg-overlay,#fff);box-shadow:0 10px 28px rgba(0,0,0,.22),0 0 0 5px color-mix(in srgb,var(--dsw-alias-brand-primary,#5b8cff) 8%,transparent);transition:filter .15s ease,transform .15s ease,border-color .25s ease,box-shadow .25s ease;animation:vq-in .2s ease}',
  '.vq-ball::before{content:"";position:absolute;inset:5px;border-radius:15px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#5b8cff) 32%,transparent);pointer-events:none;animation:vq-pulse 2.8s ease-in-out infinite}',
  '.vq-ball:hover{filter:brightness(1.06);box-shadow:0 12px 32px rgba(0,0,0,.26),0 0 0 7px color-mix(in srgb,var(--dsw-alias-brand-primary,#5b8cff) 10%,transparent)}',
  '.vq-ball:active{cursor:grabbing;transform:scale(.96)}',
  '.vq-ball,.vq-titlebar{touch-action:none}',
  '.vq-ball.vq-warn-mid{border-color:var(--dsw-alias-state-warn-primary,#f59e0b);box-shadow:0 10px 28px rgba(0,0,0,.22),0 0 0 5px rgba(245,158,11,.12)}',
  '.vq-ball.vq-warn-mid::before{border-color:var(--dsw-alias-state-warn-primary,#f59e0b)}',
  '.vq-ball.vq-warn-hi{border-color:var(--dsw-alias-state-error-primary,#ef4444);box-shadow:0 10px 28px rgba(0,0,0,.22),0 0 0 5px rgba(239,68,68,.12)}',
  '.vq-ball.vq-warn-hi::before{border-color:var(--dsw-alias-state-error-primary,#ef4444)}',
  '.vq-ball-num{position:relative;font-size:13px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1;letter-spacing:0}',
  '.vq-ball-lbl{position:relative;font-size:9px;font-weight:600;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.55));line-height:1;letter-spacing:.04em}',
  // 悬浮窗：减少嵌套卡片，强化标题、主数值和窗口明细的层级。
  '.vq-panel{position:fixed;z-index:9999;display:flex;flex-direction:column;width:448px;min-width:300px;max-width:calc(100vw - 24px);max-height:82vh;border:1px solid var(--dsw-alias-border-l2,#e2e6ed);border-radius:16px;background:var(--dsw-alias-bg-base,#f7f8fa);box-shadow:0 20px 54px rgba(0,0,0,.28),0 4px 14px rgba(0,0,0,.12);overflow:hidden;animation:vq-in .2s ease;color:var(--dsw-alias-label-primary,#17202f)}',
  '.vq-titlebar{display:flex;align-items:center;gap:10px;padding:14px 16px 13px;cursor:move;user-select:none;background:var(--dsw-alias-bg-layer-1,#fff);border-bottom:1px solid var(--dsw-alias-border-l1,#e9edf2)}',
  '.vq-titlegroup{display:flex;flex-direction:column;gap:3px;min-width:0}',
  '.vq-eyebrow{font-size:9px;font-weight:700;line-height:1;color:var(--dsw-alias-brand-primary,#5b8cff);letter-spacing:.12em;text-transform:uppercase}',
  '.vq-title{font-size:14px;font-weight:750;color:var(--dsw-alias-label-primary,#17202f);line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.vq-badge{align-self:center;font-size:10px;font-weight:650;padding:4px 8px;border-radius:6px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#5b8cff) 28%,var(--dsw-alias-border-l1,#e9edf2));background:color-mix(in srgb,var(--dsw-alias-brand-primary,#5b8cff) 10%,transparent);color:var(--dsw-alias-brand-primary,#4f72ce);white-space:nowrap}',
  '.vq-spacer{flex:1}',
  '.vq-header-actions{display:flex;align-items:center;gap:4px;margin-left:auto}',
  '.vq-ibtn{width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;background:transparent;border:1px solid transparent;cursor:pointer;color:var(--dsw-alias-label-secondary,#5b6575);font-size:18px;padding:0;border-radius:8px;line-height:1}',
  '.vq-ibtn:hover{background:var(--dsw-alias-bg-layer-2,#f0f3f7);border-color:var(--dsw-alias-border-l1,#e3e8ef);color:var(--dsw-alias-label-primary,#17202f)}',
  '.vq-ibtn:disabled{opacity:.5;cursor:default}',
  '.vq-body{flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:16px;font-size:12px;color:var(--dsw-alias-label-secondary,#566174)}',
  '.vq-stats{display:grid;grid-template-columns:1.15fr 1fr 1fr;gap:8px}',
  '.vq-stat{min-width:0;display:flex;flex-direction:column;gap:5px;padding:11px 12px;border:1px solid var(--dsw-alias-border-l1,#e5e9ef);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff)}',
  '.vq-stat-label{font-size:10px;font-weight:600;color:var(--dsw-alias-label-secondary,#697587)}',
  '.vq-stat-value{font-size:19px;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:0;color:var(--dsw-alias-label-primary,#17202f);white-space:nowrap}',
  '.vq-stat-sub{font-size:10px;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.48));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.vq-quota{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding:0}',
  '.vq-donut-wrap{display:flex;flex-direction:column;align-items:center;gap:4px;padding:8px 4px;border:1px solid var(--dsw-alias-border-l1,#e5e9ef);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff)}',
  '.vq-donut{width:82px;height:82px}',
  '.vq-donut-val{fill:var(--dsw-alias-label-primary,#17202f);font-size:12px;font-weight:800}',
  '.vq-donut-lbl{fill:var(--dsw-alias-label-secondary,#697587);font-size:9px}',
  '.vq-donut-time{font-size:9px;color:var(--dsw-alias-label-secondary,#697587);white-space:nowrap}',
  '.vq-panel2{display:flex;flex-direction:column;gap:10px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l1,#e5e9ef)}',
  '.vq-ptitle{font-size:10px;font-weight:750;color:var(--dsw-alias-label-secondary,#697587);text-transform:uppercase;letter-spacing:.1em}',
  '.vq-prow{display:grid;grid-template-columns:62px minmax(0,1fr);grid-template-rows:16px 16px;column-gap:10px;align-items:center}',
  '.vq-pname{grid-row:1 / 3;width:auto;color:var(--dsw-alias-label-primary,#17202f);font-size:11px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.vq-pbar{grid-column:2;grid-row:1;height:7px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,#edf0f4);overflow:hidden}',
  '.vq-pbar-fill{height:100%;border-radius:4px;transition:width .3s ease}',
  '.vq-pcost{grid-column:2;grid-row:2;width:auto;text-align:left;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.5));font-weight:600;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.vq-warn{border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 45%,var(--dsw-alias-border-l1,#e5e9ef));border-left:3px solid var(--dsw-alias-state-warn-primary,#f59e0b);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 9%,transparent);border-radius:8px;padding:9px 11px;font-size:11px;color:var(--dsw-alias-state-warn-primary,#b45309);line-height:1.5}',
  '.vq-err{border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 42%,var(--dsw-alias-border-l1,#e5e9ef));border-left:3px solid var(--dsw-alias-state-error-primary,#ef4444);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 7%,transparent);border-radius:8px;padding:10px 11px;font-size:11px;color:var(--dsw-alias-state-error-primary,#ef4444);line-height:1.55;white-space:pre-wrap}',
  '.vq-loading{font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.55));padding:28px 0;text-align:center}',
  '.vq-foot{padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l1,#e5e9ef);font-size:10px;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.48));display:flex;justify-content:space-between;align-items:center;gap:8px;background:var(--dsw-alias-bg-layer-1,#fff)}',
  // 设置 → 插件 配置卡片（与 DSH 自带 PluginCard/fields 同款样式：token、open 态、徽标、输入框、按钮）
  '.vq-card{list-style:none;border:1px solid var(--dsw-alias-border-l2,#e5e5e5);background:var(--dsw-alias-bg-layer-3,#fff);border-radius:12px;transition:border-color .16s,background .16s}',
  '.vq-card:hover{border-color:var(--dsw-alias-label-dimmed,rgba(0,0,0,.35))}',
  '.vq-card.vq-card-open{background:var(--dsw-alias-bg-layer-2,#f2f2f2);border-color:var(--dsw-alias-label-dimmed,rgba(0,0,0,.35))}',
  '.vq-card-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:none;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}',
  '.vq-card-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f8cff);outline-offset:-2px}',
  '.vq-card-headtext{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}',
  '.vq-card-name{color:var(--dsw-alias-label-primary,#1a1a1a);font-size:15px;font-weight:600;line-height:1.4}',
  '.vq-card-desc{color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.55));font-size:13px;line-height:1.5}',
  '.vq-card-pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary,#333);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}',
  '.vq-card-chevron{color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.55));flex:none;transition:transform .16s}',
  '.vq-card-chevron-open{transform:rotate(180deg)}',
  '.vq-card-body{border-top:1px solid var(--dsw-alias-border-l2,#e5e5e5);margin:0 16px;padding-bottom:8px;display:flex;flex-direction:column}',
  '.vq-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}',
  '.vq-field+.vq-field{border-top:1px solid var(--dsw-alias-border-l2,#e5e5e5)}',
  '.vq-field-head{align-items:center;gap:8px;display:flex}',
  '.vq-card-label{min-width:0;color:var(--dsw-alias-label-primary,#1a1a1a);flex:1;font-size:13px;font-weight:500;line-height:1.5}',
  '.vq-card-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary,#333);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}',
  '.vq-card-badge-muted{white-space:nowrap;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.55));border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px}',
  '.vq-card-input{border:1px solid var(--dsw-alias-border-l2,#e5e5e5);background:var(--dsw-alias-bg-layer-3,#fff);height:34px;font:inherit;color:var(--dsw-alias-label-primary,#1a1a1a);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;width:100%;box-sizing:border-box}',
  '.vq-card-input:focus-visible{border-color:var(--dsw-alias-brand-primary,#4f8cff);outline:none}',
  '.vq-card-input:disabled{color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.55));cursor:default}',
  '.vq-card-select{border:1px solid var(--dsw-alias-border-l2,#e5e5e5);background:var(--dsw-alias-bg-layer-3,#fff);height:34px;font:inherit;color:var(--dsw-alias-label-primary,#1a1a1a);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;width:100%;box-sizing:border-box}',
  '.vq-card-select:focus-visible{border-color:var(--dsw-alias-brand-primary,#4f8cff);outline:none}',
  '.vq-card-hint{color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.55));margin:0;font-size:12px;line-height:1.5}',
  '.vq-card-footer{border-top:1px solid var(--dsw-alias-border-l2,#e5e5e5);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}',
  '.vq-card-discard,.vq-card-save{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}',
  '.vq-card-discard{border-color:var(--dsw-alias-border-l2,#e5e5e5);color:var(--dsw-alias-label-secondary,#333);background:none}',
  '.vq-card-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary,#1a1a1a);border-color:var(--dsw-alias-label-dimmed,rgba(0,0,0,.35))}',
  '.vq-card-save{background:var(--dsw-alias-label-primary,#1a1a1a);color:var(--dsw-alias-bg-layer-3,#fff)}',
  '.vq-card-discard:disabled,.vq-card-save:disabled{opacity:.4;cursor:default}',
  '.vq-card-discard:focus-visible,.vq-card-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f8cff);outline-offset:1px}',
  '.vq-card-saved{min-width:0;color:var(--dsw-alias-state-success-primary,#16a34a);flex:1;margin:0;font-size:12px;line-height:1.5}',
  '@media (max-width:480px){.vq-panel{max-height:86vh;border-radius:13px}.vq-titlebar{padding:12px}.vq-body{padding:12px;gap:13px}.vq-stats{grid-template-columns:1fr 1fr}.vq-stat:first-child{grid-column:1 / -1}.vq-quota{grid-template-columns:repeat(2,minmax(0,1fr))}.vq-foot{padding:9px 12px}}',
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
    const PW = Math.min(448, vw - 24)
    const GAP = 10
    const M = 8
    const cx = ball.x + 32
    // 与 panelFromBall 同一判据：展开时面板锚在小球哪一侧，收起时小球就回到面板那一侧的旁边
    const panelOnLeft = cx > vw / 2
    let nx = panelOnLeft ? win.x + PW + GAP : win.x - 64 - GAP
    nx = Math.max(M, Math.min(nx, vw - 64 - M))
    const ny = Math.max(M, Math.min(win.y, vh - 64 - M))
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
      const w = kind === 'ball' ? 64 : Math.min(448, window.innerWidth - 24)
      const hh = kind === 'ball' ? 64 : 72
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
  const ballSub = error ? '错误' : (data ? (hottest ? windowLabel(hottest.name) + '已用' : '已用') : '加载')
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
      h('div', { className: 'vq-titlegroup' },
        h('span', { className: 'vq-eyebrow' }, 'QUOTA MONITOR'),
        h('span', { className: 'vq-title' }, '火山方舟额度'),
      ),
      h('span', { className: 'vq-badge' }, data ? (data.plan === 'agent' ? 'Agent Plan' : 'Coding Plan') : '…'),
      h('span', { className: 'vq-spacer' }),
      h('div', { className: 'vq-header-actions' },
        h('button', { key: 'refresh', className: 'vq-ibtn', onClick: () => load(), title: '立即刷新', 'aria-label': '立即刷新', disabled: loading }, loading ? '…' : '↻'),
        h('button', { key: 'close', className: 'vq-ibtn', onClick: () => closeToBall(), title: '收起为小球', 'aria-label': '收起为小球' }, '×'),
      ),
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
      '额度即将耗尽：' + hot.map((w) => windowLabel(w.name) + ' ' + fmtPct(w.usedPercent)).join(' · '),
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

  return h('li', { className: 'vq-card' + (open ? ' vq-card-open' : '') },
    h('button', { type: 'button', className: 'vq-card-header', 'aria-expanded': open, onClick: () => setOpen(!open) },
      h('span', { className: 'vq-card-headtext' },
        h('span', { className: 'vq-card-name' }, '火山方舟额度'),
        h('span', { className: 'vq-card-desc' }, 'Coding Plan / Agent Plan 额度实时查看的访问密钥与套餐类型'),
      ),
      dirty ? h('span', { className: 'vq-card-pending' }, '未保存') : null,
      h('span', { className: 'vq-card-chevron' + (open ? ' vq-card-chevron-open' : '') }, h(Chevron)),
    ),
    open ? h('div', { className: 'vq-card-body' },
      h('div', { className: 'vq-field' },
        h('div', { className: 'vq-field-head' },
          h('label', { className: 'vq-card-label', htmlFor: 'vq-cfg-ak' }, 'AccessKey ID'),
          h('span', { className: akCfg.configured ? 'vq-card-badge' : 'vq-card-badge-muted' },
            akCfg.configured ? (akCfg.source ? '已配置 · ' + akCfg.source : '已配置') : '未配置'),
        ),
        h('input', { id: 'vq-cfg-ak', className: 'vq-card-input', value: ak, placeholder: 'AKLT…', disabled: !akCfg.writable, onChange: edit(setAk) }),
      ),
      h('div', { className: 'vq-field' },
        h('div', { className: 'vq-field-head' },
          h('label', { className: 'vq-card-label', htmlFor: 'vq-cfg-sk' }, 'Secret AccessKey'),
          h('span', { className: skCfg.configured ? 'vq-card-badge' : 'vq-card-badge-muted' },
            skCfg.configured ? (skCfg.source ? '已配置 · ' + skCfg.source : '已配置') : '未配置'),
        ),
        h('input', { id: 'vq-cfg-sk', className: 'vq-card-input', type: 'password', value: sk, placeholder: '留空并保存 = 清除该项', disabled: !skCfg.writable, onChange: edit(setSk) }),
        h('p', { className: 'vq-card-hint' }, '存于 DSH 凭据库（~/.dsh/.credentials.yaml），浏览器不保存密钥。'),
      ),
      h('div', { className: 'vq-field' },
        h('div', { className: 'vq-field-head' },
          h('label', { className: 'vq-card-label', htmlFor: 'vq-cfg-plan' }, '套餐类型'),
        ),
        h('select', { id: 'vq-cfg-plan', className: 'vq-card-select', value: plan, onChange: edit(setPlan) },
          h('option', { value: 'auto' }, '自动探测（coding → agent）'),
          h('option', { value: 'coding' }, 'Coding Plan'),
          h('option', { value: 'agent' }, 'Agent Plan'),
        ),
        h('p', { className: 'vq-card-hint' },
          !anyWritable ? '当前凭据来自只读来源（环境变量），请到环境变量处修改。' : '解析优先级：请求体 > 凭据库/环境变量 > 历史别名。',
        ),
      ),
      err ? h('div', { className: 'vq-err' }, err) : null,
      h('div', { className: 'vq-card-footer' },
        saved ? h('span', { className: 'vq-card-saved' }, '已保存，悬浮球已刷新 ✓') : null,
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

  // 设置 → 插件 → 配置卡片（rc7：keyed 插槽，key = host 注册的设置命名空间）
  ctx.effect(() => ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register(
      { name: 'settings.plugin.item', key: 'dsh-volcark-quota' },
      ConfigCard,
    ),
  ), 'dsh-volcark-quota: config card')
}
