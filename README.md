# @dsh-external/dsh-volcark-quota

DeepSeek Harness (DSH) 插件：**火山方舟 Coding Plan / Agent Plan 额度实时查看**。
悬浮小球（收起）→ 点击展开可拖拽悬浮窗，实时展示套餐各窗口（5 小时 / 本周 /
本月）的已用百分比（**两位小数**，与火山方舟控制台一致）、剩余量、重置倒计时；
额度 ≥70% 变黄、≥90% 变红并告警。60 秒自动刷新。
<img width="1376" height="764" alt="演示" src="https://github.com/user-attachments/assets/d54693dc-8f04-4d82-bbb5-20921e3e84fa" />


## 功能

- **直连官方 API**：AK/SK + HMAC-SHA256 V4 签名，调 `open.volcengineapi.com`
  的 `GetCodingPlanUsage` / `GetAgentPlanAFPUsage`，无需第三方服务。
- **悬浮小球**：收起时是圆形小球（opencode-go FAB 风格：品牌渐变 + 红/黄/绿警告态，
  显示最高已用 %，可拖动），点击展开悬浮窗。
- **可拖拽悬浮窗**：查询界面模仿 `dsh-opencode-go-usage` 面板 ——
  stats 卡片（已用/剩余/最近重置）+ 每窗口 **Donut 环形图** + 窗口明细进度条，
  重置倒计时每秒跳动，标题栏可拖动。
- **两位小数**：已用百分比保留两位小数，与火山方舟控制台一致。
- **自动刷新**：每 60s 拉取一次；凭据在「设置 → 插件」保存后即时刷新。
- **安全存储**：AK/SK 走 DSH 官方凭据服务（`ctx.credentials`，与 DSH 自身存 API key
  同一机制）——环境变量优先、`~/.dsh/.credentials.yaml` 落盘兜底；**浏览器不保存密钥**，
  host 只向 UI 报告「已配置/来源/可写」，从不回传密钥值。

## 安装（公共安装方式）

在目标 DSH profile 中用官方命令从 GitHub 源安装（bundle 插件，`dsh.bundle.patch`
会把插件行注入 host 组合，重启 web 服务后生效）：

```sh
dsh plugin add github:ZnonEn/dsh-volcark-quota
# 或指定分支 / 版本
dsh plugin add github:ZnonEn/dsh-volcark-quota#v0.0.1
```

### 开发者模式（从源码构建）

```sh
npm install --legacy-peer-deps
bash scripts/build.sh          # host 复制到 lib/，client 用 tsdown 打包
```

构建产物 `lib/` 已提交到仓库，git 安装开箱即用，无需本地构建。

## 配置 AK/SK（二选一）

### 方式 A：设置 → 插件（推荐）

打开 DSH 的 **设置 → 插件**，在「火山方舟额度」卡片中填入：

- **AccessKey ID**：火山方舟控制台 → API 访问密钥 → Access Key ID（形如 `AKLT…`）
- **Secret AccessKey**：对应的 Secret Access Key
- **套餐类型**：`auto`（先试 Coding Plan，失败自动试 Agent Plan）/ `coding` / `agent`

点「保存」即写入 **DSH 凭据库**（`~/.dsh/.credentials.yaml`，与 DSH 自身存 API key
同一机制）并即时生效。卡片只显示「已配置/来源/可写」状态，**不显示、不返回密钥值**；
「清除凭据」按钮一键删除。

### 方式 B：环境变量（优先级更高，全进程生效）

启动 DSH 前设置（与凭据库引用同名，会自动遮蔽文件层）：

```sh
export VOLC_ARK_ACCESS_KEY_ID=AKLTxxxx
export VOLC_ARK_ACCESS_KEY_SECRET=xxxxxxxx
```

兼容旧别名：`VOLC_ACCESS_KEY_ID` / `VOLC_ACCESS_KEY_SECRET`、`VOLC_ACCESS_KEY` /
`VOLC_SECRET_KEY`、`ARK_ACCESS_KEY_ID` / `ARK_ACCESS_KEY_SECRET`。

凭据解析优先级：请求体显式覆盖（高级用法）> 凭据库/环境变量 > 历史环境变量别名。

## 取数原理

- 请求：`POST https://open.volcengineapi.com/?Action=GetCodingPlanUsage&Version=2024-01-01`
  （Agent Plan 用 `Action=GetAgentPlanAFPUsage`），body `{}`。
- 签名：`HMAC-SHA256` V4，region `cn-beijing`，service `ark`；
  `X-Date` 官方格式 `yyyyMMdd'T'HHmmss'Z'`。
- 解析：Agent Plan 走 `Result.AFPFiveHour/AFPWeekly/AFPMonthly`
  （`Quota` / `Used` / `ResetTime`）；Coding Plan 走 `Result.QuotaUsage[]`
  （`Level` / `Percent` / `ResetTimestamp`，秒转毫秒）。

## Host API

- `GET /dsh-volcark-quota/config`：凭据状态（`configured/source/writable`），**不含值**
- `POST /dsh-volcark-quota/config`：body `{ak, sk}`，写入凭据库（空串 = 清除该项）
- `POST /dsh-volcark-quota/clear`：清除 AK/SK
- `POST /dsh-volcark-quota/snapshot`（body `{planType}` 可选），返回：

```json
{
  "ok": true,
  "plan": "coding",
  "windows": [{ "name": "5h", "usedPercent": 42.5, "remainingPercent": 57.5, "resetAt": 1789… }],
  "details": [],
  "updatedAt": 1789…
}
```

## 文件结构

```
src/index.js         host：零依赖（node:crypto/https）+ webServer 路由
src/client/index.ts  client：shell.overlay 悬浮小球/悬浮窗 + settings.plugin.item 配置卡片（tsdown → lib/client.js）
cordis.patch.yml     bundle patch（host 组合插入）
scripts/build.sh     构建：复制 host + tsdown 打包 client
```

## 常见问题

| 现象 | 处理 |
|---|---|
| 悬浮球/面板报「未配置火山方舟 AK/SK」 | 设置 → 插件 →「火山方舟额度」卡片填写，或设环境变量 |
| 返回 `401 InvalidAccessKey` | AK 无效/被禁用，去火山方舟控制台核对 |
| 返回 `InvalidTimestamp` | 本机时钟与真实时间偏差过大（签名 15 分钟窗口） |
| 面板显示「暂无额度数据」 | 该账号未订阅 Coding/Agent Plan，或套餐类型选错 |
| 悬浮球/配置卡片不出现 | 检查 bundle 是否在 `dsh.profile.bundles`，或 web 服务日志 `hmr/config-update-failed` |

## 参考与致谢

查询界面视觉与组件结构参考了以下 MIT 协议的社区插件，完整版权声明见
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)：

- [Xenia0922/dsh-opencode-go-usage](https://github.com/Xenia0922/dsh-opencode-go-usage)（MIT）
- [margrop/coding-plan-dashboard](https://github.com/margrop/coding-plan-dashboard)（MIT）
- [jiekesu967/dsh-plugin-opencode-usage](https://github.com/jiekesu967/dsh-plugin-opencode-usage)（MIT）

本插件自身以 BSD-3-Clause 授权（见 [LICENSE](./LICENSE)）。

---

> 🛠 本项目使用 DeepSeek V4 Flash与chatgpt 5.6，以 vibe coding方式制作：
> 需求确认、UI 样式与验收由人工完成，代码由 AI 全程生成。
