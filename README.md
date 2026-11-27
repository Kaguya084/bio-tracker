# 智能健康助手 · 网页端

> *Codename: **K · Project Labyrinth***

[![Version](https://img.shields.io/badge/version-v0.2.0--beta-blue.svg)]()
[![Status](https://img.shields.io/badge/status-beta-orange.svg)]()
[![Tech](https://img.shields.io/badge/Tech-VanillaJS%20%2B%20CloudBase-yellow.svg)]()
[![License](https://img.shields.io/badge/license-MIT-green.svg)]()

> 不做数据看板，做数字健康的行动闭环。把散落的记录，变成 AI 的洞察，最终送进会响的日历。

将「健康记录（饮食/睡眠/运动/步数/心情）」「AI 行为分析」「跨设备同步」「日程落地（.ics 导出）」串成一条链路。拒绝制造焦虑，只提供可执行的反馈。

> ⚠️ **当前状态：v0.2 Beta**
> 已完成单文件 → 模块化拆分；云同步与服务端 AI 代理为**代码就绪、待部署配置**状态（见下方「部署前必读」）。未配置时全部功能以纯本地 / 离线 Mock 正常运行。

## 核心特性

- 🧩 **模块化架构**：核心层（util / bus / store / sync）+ AI 守卫 + 日程桥接 + 业务模块，`index.html` 仅作骨架与入口。
- 🤖 **AI 双轨引擎**：部署云函数后由服务端代理 DeepSeek（密钥不进前端）；未部署或网络异常时自动降级到离线规则引擎（Mock）。演示永不翻车。
- 🛡️ **三条防幻觉硬规则**：
  - **缺失 ≠ 0**：没记录的日子不按 0 计算，不进均值，不判未达标。
  - **异常值排除**：超范围输入（如 400 分钟运动）不参与统计。
  - **数据不足不作因果**：有效记录 < 3 天时，只描述现象，禁止“因为…所以…”的瞎编。
- ☁️ **本地优先 + 可选云同步**：默认纯本地；用一个 6 位配对码关联 iPhone 与电脑。**心情日记永不上传**；冲突按字段级 last-write-wins 合并。
- 📅 **跨应用数据流转**：AI 行动建议可转码为 JSON，粘贴到独立部署的日程站导出 iPhone 原生日历。
- 🔒 **密钥不落浏览器**：API Key 只存服务端环境变量；导出的备份文件不含任何密钥。

## 目录结构

```
bio-tracker/
  index.html                  # 骨架 + UI + 启动区
  Time_Table.html             # 日程站离线备份（公网不可达时兜底）
  manifest.webmanifest / icon.svg / sw.js   # PWA
  js/core/{util,bus,store,sync}.js          # 工具 / 事件总线 / 存储 / 同步
  js/ai/guard.js              # 防幻觉统计与 Mock
  js/schedule/bridge.js       # 行动建议 → 日程 JSON
  cloudfunctions/bio-api/     # 云函数：AI 代理 + 配对码同步
  cloudbase/migrations/       # PG 建表迁移（版本化）
  index.legacy.html           # v1 单文件快照，一键回退
```

## 使用流程

1. **记录生活**：首页记步数/喝水，各 Tab 记饮食、睡眠、运动、心情。
2. **AI 洞察**：「运动」页生成解释；基于统计算法给出带数据边界的分析。
3. **行为闭环**：生成本周行动建议 → 提交执行反馈 → 自动降级调整。
4. **日程落地**：复制日程 JSON → 「日程」Tab（外部站点）→ 粘贴到「解析并预览」→ 导出 `.ics` → 导入 iPhone 日历。
5. **可选同步**：「设置 → 跨设备同步」填同一配对码，两端分别点上传/拉取。

## 跨设备同步说明

- 配对码为 6 位字符串（排除易混淆字符），无账号、无注册。安全性较弱，适合个人场景。
- 云端存 `health_sync` 表，按 `(配对码, 桶, 记录键)` 唯一定位；删除用 tombstone 标记。
- 同步桶：water / sleep / diet / ex / steps / foods / sportProfile / sportPlans / sportFeedbacks。**journal（心情日记）不在同步列表**。
- 关闭同步后即回到纯本地，云端数据不影响本机。

## 数据与安全

- 未开启同步时，本页只发三类请求：天气（Open-Meteo）、地理编码（Nominatim）、AI（仅在部署后走自己的云函数）。
- 所有健康数据默认保存在浏览器 `localStorage`；清除缓存或更换域名会丢失，请定期「备份数据」。
- 备份 JSON 已剔除 `apiKey` 字段；前端代码不再保存密钥。
- 日程站为**独立域名**，其数据在 `kaguya084.github.io` 下，与本页物理隔离、互不读取。

## 部署前必读（剩余待办）

云同步与在线 AI 的代码已就绪，但要真正启用还需 K 完成三项配置：

1. **创建 CloudBase API Key**（当前环境 `listApiKeys` 为空）→ 拿到 `publishableKey` 与服务端 `API Key`。
2. **部署云函数** `bio-api`：设环境变量 `DEEPSEEK_API_KEY`，部署后在 `index.html` 顶部填 `window.AI_ENDPOINT` 与 `window.SYNC_ENDPOINT`。
3. **确认云函数访问 PG 的 SDK 写法**：当前代码用 `@cloudbase/node-sdk` 的 `app.database()`（文档兼容层）；若 SHARED PG 不支持，需改为 `app.rdb()` 或 HTTP API。

> 以上未完成时，页面**照常可用**（纯本地 + 离线 Mock），只是没有跨设备同步与真实 AI。数据库表 `health_sync` / `sync_pairs` 已建好并通过迁移校验。

## 已知限制

- 行动建议目前只输出运动项，睡眠与饮水暂不生成行动。
- 单用户配对码方案，无账号找回机制；换设备需重新配对并手动拉取。
- iOS Safari 的 Web Notification 不可靠，提醒降级为页内提示 + 声音；实时计步需用户手势授权且仅前台可用。
- 统计周期为自然周（7 天切分），跨周部分按不完整周列出。

## 许可证

MIT © 2026 Kaguya084。完整条款见 [`LICENSE`](LICENSE)。

> 本项目由 AI 辅助生成，经人工审阅与调整。代码按「原样」提供，不附带任何明示或暗示的担保。健康建议仅作参考，不替代专业医疗诊断。
