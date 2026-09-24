# 验证证据归档

这里存放 **2026-09-23 Windows 真机验证**（分支 `fix/windows-paths`）用到的复现脚本。
报告本体在 [`../windows-verification-report.md`](../windows-verification-report.md)，部署与判定手册在
[`../windows-verification.md`](../windows-verification.md)。

## probes/

| 脚本 | 可移植性 | 作用 |
|---|---|---|
| [`probes/sse-loop-repro.mjs`](probes/sse-loop-repro.mjs) | ✅ **任何平台直接跑** | 缺陷 A 的最小复现器：纯 `node:http`，忠实复刻 `connectSSE()` / `scheduleReconnect()` 的簿记逻辑。`SCENARIO 2`（连续调用两次）复现 2.5s 自维持循环；退出码 0 = 复现成功 |
| [`probes/dedup-key-collision.mjs`](probes/dedup-key-collision.mjs) | ✅ **任何平台直接跑** | 缺陷 B 的复算证明：`editKeyOf` 的 `i += 97` 抽样哈希对 <97 字符串退化成首字符码，同长同首字符必然碰撞；并演示 win32 / posix 路径同样碰撞 |
| [`probes/sse-lifetime.mjs`](probes/sse-lifetime.mjs) | ⚠️ 需 Windows 现场 | 旁路客户端对照实验：作为第二个 SSE 客户端挂上端点计时，证明**服务端**不会主动断开（即循环来自客户端）。读 `%USERPROFILE%\.dsh-editor\bridge.json` 拿 token |
| [`probes/win-path-probe.mjs`](probes/win-path-probe.mjs) | ⚠️ 仅 Windows | 真机路径语义探针（53/53）：用**默认** `process.platform` 调**真实** `paths.js`，再拿**真实 NTFS** 交叉验证大小写不敏感假设 —— 覆盖 `test/windows-sim.mjs` 只能注入模拟、覆盖不到的生产分支 |

### 移植到你的机器

两个 Windows 现场脚本里写死了验证机器的绝对路径，跑之前改这两处：

```js
// probes/win-path-probe.mjs:17-18  → 改成你自己的 checkout
const SRC      = '<repo>/vscode-ext/dsh-bridge/paths.js';
const SRC_HOST = '<repo>/lib/host.js';
```

```js
// probes/sse-lifetime.mjs:12  → 非 Windows 平台改成对应位置
//   %USERPROFILE%\.dsh-editor\bridge.json   (扩展连上 DSH 后才会生成)
```

两个平台无关的脚本无需改动：

```bash
node docs/evidence/probes/sse-loop-repro.mjs        # ~22s；打印 RECONNECT LOOP
node docs/evidence/probes/dedup-key-collision.mjs   # 瞬时；打印 COLLIDE
```

> 这两个脚本是「缺陷 A/B 存在」的证明，**不是** CI 回归测试。
> 修复缺陷 A/B 的分支（`fix/sse-reconnect-and-dedup`）会把它们升级成 `test/` 下的正式回归用例，
> 走 `test/windows-sim.mjs` 那套 `vscode` 桩 + 真实 HTTP 服务端。

## 尚未归档的原始日志

以下两份**仍在验证机器上**，是报告里框级日志与人眼确认的原始出处，公开引用前建议先取回：

| 文件（验证机器路径） | 内容 |
|---|---|
| `C:\tmp\dsh-bridge-debug.log` | 扩展侧逐帧追踪（`dbg()`），#5 / #6 的帧级证据 |
| `C:\Users\apple\.dsh-editor\bridge-ext.log` | 扩展侧日志，**UTF-8**（用 ANSI 读会乱码），缺陷 A 的 2.5s 循环出处 |

取回后放本目录，并在报告 §10 的表格里把「未归档」改成实际文件名。
