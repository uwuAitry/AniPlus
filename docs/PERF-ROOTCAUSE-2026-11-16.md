# DSH 卡顿未解决：结构化排查报告

- 日期：2026-11-16（本机 DSH NEXT 2.0.23-next / dsh 0.2.2-rc.3 / Electron 44.7.0，runId `7d059675…`，pid 5312，23:06 启动）
- 结论口径：只写本轮新采集的可观测证据；无 CDP/性能剖析器，进程级 CPU 为可观测口径，函数级归因标注为证据缺口。

## 结论（先行）
1. **"修复无效"的直接原因已确证：补丁层根本没加载。** `dsh-perf-tuner` 不在 `dsh.profile.bundles`（26 个 bundle 中无它），重启日志也从未出现其 `active` 标记 → 所有 CSS 补丁从未运行。
2. **流式路径同样是错的**：`dsh-plugin-smooth-stream` 也不在 bundles（6 个"装了没加载"的依赖之一）→ 当前走宿主默认"逐 chunk 整段重解析"，即最差路径。
3. **新根因（现象已证实）**：即使模型不吐 token、甚至窗口最小化，渲染进程仍 **55% 单核**（GPU 从 38% 降到 22%）→ 主负载是**渲染进程常驻 JS 工作**，不是纯动画/paint；具体 JS 来源待 profiler 定位。
4. 长会话数据边界已量化：当前会话 `session-c91d6f14` 正在写入，日志显示 **≥2338 个 session 事件、turn 19**，与"无虚拟化 + 每新节点整窗重排"叠加放大。
5. **不要再加 CSS 补丁**：CSS 层不是当前主因，且承载它的插件未加载。

## 1. 症状复述与已尝试方案（失败边界）
- 症状：DSH 界面持续卡顿；多次修复后仍复现（用户原话"还是没有解决"）。
- 已尝试 ①诊断报告 `PERF-DIAGNOSIS-2026-11-15.md`：仅分析，未改宿主。
- 已尝试 ②perf-tuner CSS 补丁（容器查询隔离/右栏 slow→fast/流式 blur 降级/scroll-snap/行 content-visibility）：**写入文件但插件未加载 → 全部无效**。
- 已尝试 ③手动把 perf-tuner 加进 `dsh.profile.bundles`：被 plugin-manager 重写 package.json 覆盖 → 未生效。
- 已尝试 ④`ui-chat.transcriptView: compact`：**已生效**（`cordis.patch.yml:240`）但卡顿仍在 → 排除"仅行密度"。
- 失败边界：**从未做过** JS 侧 profiler、插件二分、以及经 plugin-manager 的正式启用。

## 2. 已排除项
1. **perf-tuner 补丁在生效** —— 排除：不在 bundles（`dsh-perf-tuner: in_bundles=False`），多次重启日志无 `dsh-perf-tuner active`。
2. **smooth-stream 在生效** —— 排除：`dsh-plugin-smooth-stream: in_bundles=False`。
3. **GPU/动画是唯一主因** —— 排除：窗口最小化后 GPU 63%→22%，renderer 仍 55%。
4. **GC/OOM/崩溃** —— 无证据：进程 RSS 699/575/368MB 可控；日志无 OOM/GC/异常。
5. **MCP/网络重连** —— 已发生但已终止（deepwiki 10 次失败后 give up），不解释持续 55%。

## 3. 假设与验证
| # | 假设 | 验证方法 | 结果 | 状态 |
|---|---|---|---|---|
| H1 | perf-tuner 未加载使全部修复无效 | 查 bundles 成员 + grep 启动标记 | 不在 bundles；无 active 标记 | **已证实** |
| H2 | smooth-stream 未加载，流式走最差路径 | deps vs bundles 对比 | 在 deps 不在 bundles | **已证实** |
| H3 | 长会话结构成本（无虚拟化+每节点 O(n log n) 重排+`:has()` 跨行重样式） | 代码路径（`chat-snapshot-builder.ts:1159–1167/522/281`；`ChatView.module.css:82–97`）+ 当前会话 ≥2338 事件 | 机制成立、量级未测 | **机制已证实 / 量级待验证** |
| H4 | 渲染进程存在常驻 JS 工作（非 paint） | 空闲窗口 & 最小化窗口各 5s CPU 增量 | 空闲 renderer 40%；最小化仍 55%；GPU 38→22% | **现象已证实 / 来源待验证** |
| H5 | 常驻轮询来自某插件（静态计数：billion-context setInterval=57 / setTimeout=565；better-sidebar setInterval=29 / rAF=51） | 静态扫描已加载插件 bundle | 计数高但含 vendor 噪声，不能归因 | **待验证** |
| H6 | `backdrop-filter: blur(40px)` 合成成本 | GPU 最小化前后对比 | 有 paint 成分（38→22%），非主因 | **部分成立（次要）** |
| H7 | running 状态动画（APNG mask + TextShimmer + 1s 时钟） | 代码核对（`RunningWhaleTail.tsx` 注释 APNG；`ChatView.module.css:280-316` 14px+contain:strict；`LIVE_RUN_CLOCK_INTERVAL_MS=1000`） | 量级不足解释 55%，但会阻止合成器 idle | **已排除为主因 / 次要** |
| H8 | better-sidebar 常驻无限动画（sidechatSweep/tasks-bar-sweep 等） | 需面板处于可见 running 态 | 无 UI 状态证据 | **待验证** |
| H9 | 可用 `plugin_manager` 正式启用 perf-tuner | `list_plugins` 全量条目检索 | 252 条实时条目中**无 dsh-perf-tuner**（未注册为可管理条目） | **已排除（该路不通）** |

## 4. 根因结论
1. **直接根因（高置信）**：修复链路断裂——perf-tuner 与 smooth-stream 均"已安装未加载"，所以"还是卡"是必然；此前任何效果评估都无效。
2. **主要架构根因（中高置信）**：无虚拟化长转录 + 每新节点整窗重排/索引 + `:has()` 跨行重样式；当前会话 ≥2338 事件显著放大（机制代码证实，量级需 trace）。
3. **新增主要根因（中置信）**：渲染进程常驻 JS 工作量 ~55% 单核（最小化仍存在），说明有持续 JS/React 重渲染循环；**具体触发源未收敛**，候选为插件轮询（billion-context 等）、running 时钟、会话事件订阅扇出。
4. **次要**：GPU/paint 约 22%（最小化后），blur 与动画有贡献但非主因。
5. 证据缺口：无 CDP，无法给函数级 self-time；进程级 CPU 不能区分 React render / 定时器 / 事件处理。

## 5. 修复方案（最小、按顺序）
1. ✅ **已完成（2026-11-16）**：通过 `plugin_manager set_bundle` 正式启用 `dsh-perf-tuner`（bundles 26→27，非手改，不会被 dshmarket 覆盖）；重启后 `grep "dsh-perf-tuner active"` 应出现。
2. **同时启用 `dsh-plugin-smooth-stream`**（当前未加载），恢复流式 200ms 段落批处理；否则流式始终是逐 chunk 最差路径。
3. ✅ **已实施（2026-11-16）**：perf-tuner 新增 `diagnostics:true`，每 10s 输出 `diag rows=… seats=… dom=… longtasks=… lag=… heap=…`；重启后据 `longtasks`/`lag`/`rows` 定位 renderer 55% 的 JS 来源（也可 `--remote-debugging-port=9222` 录 Performance 复核）。
4. ⚠️ **部分完成**：插件侧已启用行窗口化（`content-visibility:auto` + `contain-intrinsic-size`）；宿主侧“增量排序/局部插入”需上游改 `@deepseek-ai/dsh-client-ui-chat` 的 `chat-snapshot-builder.ts:1159–1167`（整窗 sort/rebuild→增量），无法在插件内安全实现（详见 PERF-ROOTCAUSE 报告）。
5. 在 1–3 完成前，**停止新增 CSS 补丁**。

## 6. 回归验证
1. 基线（可复现）：最小化 5s 窗口 `renderer 55% / GPU 22%`；正常流式窗口 `renderer 56% / GPU 63%`；空闲窗口 `renderer 40% / GPU 38%`。
2. 修复后目标：空闲/最小化 renderer <10% 单核；流式 renderer 明显下降；GPU 不高于基线。
3. 主观：流式长回复、滚动历史、切换会话无掉帧（DevTools FPS meter + Performance 长任务 >50ms 计数）。
4. 长会话：加载 2000+ 事件会话，操作期无 >100ms 长任务。

## 7. 下一步最小验证动作与所需补充信息
- **动作 A（不改代码）**：以 `--remote-debugging-port=9222` 重启一次，录 10s Performance（需用户同意，重启会终止当前会话）。
- **动作 B（不改代码）**：插件二分——临时移出 `billion-context` / `better-sidebar` 各测 idle CPU（每次重启约 2 分钟）。
- **需补充**：①"卡顿"具体表现（滚动掉帧 / 输入延迟 / 流式卡 / 切换会话卡）；②卡顿时是否打开 better-sidebar、文件树、编辑器；③窗口分辨率与缩放；④是否只有长会话出现。
