# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.4.0] - 2026-08-31

### 新增

- **多语言支持（i18n）**：web 面板、host 运行时提示、VS Code 桥扩展全面支持 简体中文 / English / Português (Brasil) / Español，新增 `language` 设置项（`auto` = 跟随浏览器语言）。感谢 @WalissonRodrigo 的贡献（PR #1）
- README 重组为四语言版本（英文为默认），新增多语言 banner

### 修复

- 修复 i18n 中 host 消息参数未被替换的问题（`{cwd}` 等占位符原样显示）

## [0.3.5] - 2026-08-31

### 新增

- **一键安装 code-server 向导**：未安装 code-server 时，「编辑器」标签页和设置卡片会出现「⬇ 一键安装 code-server」按钮，弹窗实时显示下载地址、安装路径、进度百分比（curl `--progress-bar` 解析）和启动/扩展握手进度，装完自动启动编辑器
- 安装过程中可随时**取消安装**（安装脚本新增 TERM trap，取消时 curl 子进程一并终止、临时目录自动清理，不留孤儿进程）
- 安装向导最后一步不再死等扩展握手：code-server 启动后直接引导用户点击「编辑器」标签页，弹窗进入可关闭的完成状态，扩展连上后自动打勾

### 变更

- **编辑器运行数据迁出工作区目录**：user-data / 配置 / 日志从 `<工作区>/.dsh-editor` 改为全局 `~/.dsh-editor/workspaces/<哈希>-<工作区名>/` 按工作区隔离存放（与 VS Code 用户级数据目录同一范式），工作区目录不再出现多余文件夹。已有旧版数据的工作区自动沿用旧位置，数据不丢

## [0.3.4] - 2026-08-29

### 新增

- npm 自动发布 workflow（GitHub Release 触发）
- 插件市场展示截图
- `peerDependencies` 声明

### 修复

- 修复桌面模式重连风暴导致强制打开过期 diff 的问题
