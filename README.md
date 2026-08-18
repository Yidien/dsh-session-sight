# dsh-session-sight

DeepSeek Harness（DSH）会话「看清再动手」外挂插件。

侧栏底部两个入口，删/归档会话**前先看清内容**，删得干净、归档不毁数据。

- **零依赖**：host 端不 import 任何 `@deepseek-ai/*` 包，只用 Node 内置 + 官方公开 service；
- **不 patch 官方**：外挂式挂载，dsh 升级不受影响；
- **看清再动手**：活跃/归档会话都能只读预览内容（Markdown 渲染）；
- **删除走系统回收站**：彻底删除进 Windows 回收站，还能捞回来；
- **归档不毁数据**：走官方 `archiveSession`，日志与位置保留，可随时取消归档。

## 功能

侧栏底部两个入口：

| 入口 | 列表 | 每行动作 |
|---|---|---|
| 🗑 删除会话 | 活跃会话（含「当前」标记） | 预览 / 归档 / 彻底删除 |
| 📦 归档列表 | 已归档会话 | 预览 / 取消归档 / 彻底删除 |

预览面板只读展示最近 20 条「你 / 助手」消息，支持 GFM Markdown（标题、列表、表格、代码块、引用等）。

## 命令

插件同时提供 9 个斜杠命令：

| 命令 | 作用 |
|---|---|
| `/delete-session <id\|标题>` | 移入临时回收站（可恢复） |
| `/restore-session <id\|标题>` | 从临时回收站恢复 |
| `/recycle-session <id\|标题>` | 彻底删除（进系统回收站） |
| `/trash` | 查看临时回收站 |
| `/empty-trash confirm` | 清空临时回收站（自动扫残留） |
| `/clean-orphans` | 清理 projcache 残留孤儿 |
| `/archive-session <id\|标题>` | 归档（隐藏、不毁数据） |
| `/archived` | 列出归档会话 |
| `/unarchive <id\|标题>` | 取消归档，回原位置 |

## 设计要点

- **归档 ≠ 删除**：归档用官方 `archiveSession`（只加隐藏标记），日志和 `sessionIds` 席位都不动；
- **彻底删除**：目录移入系统回收站，同时清 `projcache` + `workspace` 账目 + 归档集合；
- **预览**：日志是「拼接 zstd 帧 + JSONL」，用 Node 内置 `zlib.zstdDecompressSync` 逐帧解压（零依赖），只读、只取最近 20 条；
- **方案 B 索引重建**：删除后调 `workspaceRegistry.replaceHeaderIndex` + `indexLiveSessions`，清掉已删 id 的「撞车残留」，免重启。

## 安装

### 从 npm（推荐）

```bash
dsh plugin --profile web add dsh-session-sight
```

### 本地挂载

1. 把本目录软链/复制到 profile 的 `node_modules/dsh-session-sight`；
2. 在 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 加 `"dsh-session-sight"`；
3. 重启 dsh + 浏览器强刷新。

## 兼容性

- 需要 Node 22+（`zlib.zstdDecompressSync` 从 Node 22 起可用，Node 24 已验证）；
- 仅 Web 端有 UI（`platform: web`）；命令在所有端可用。

## License

MIT
