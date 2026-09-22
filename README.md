<p align="center"><img src="assets/notechain-icon.png" width="128" alt="Notechain"></p>

# Notechain · 链迹笔记

本地优先的 Markdown 笔记与资产关联工具，使用 Tauri 2、Rust、React 和 TypeScript。

- 笔记模式：打开本地文件夹，支持笔记本、分类和嵌套目录，直接保存 Markdown。
- 资产模式：按案件组织资产、发现与笔记，用可编辑的架构图展示关系。
- 编辑：局部 Markdown 源码编辑、关联预览、阅读位置恢复、图片与 PDF。
- 收集：通过 Chrome / Edge 扩展把网页选区送入中转站，再插入笔记。
- 自动化：独立 `ledger` CLI 与 `notechain-graph` skill，支持批量修改和预览。

## 下载

在 [Releases](https://github.com/Lyi-Fan/Notechain/releases) 下载对应版本。
Mac 支持 Apple Silicon，最低 macOS 14；Windows 提供 x64 安装包，使用 WebView2。
测试版没有正式代码签名，Mac 版本也未公证。

新安装从空白资料库开始。程序不会自动扫描旧应用目录或迁移笔记。
Markdown 文件保存在用户主动打开的目录中，笔记本索引保存在应用资料库的 `.fan` 中。

## 浏览器收集

从 Release 下载浏览器扩展 ZIP，解压后在 Chrome / Edge 扩展管理页开启开发者模式，
选择“加载已解压的扩展程序”。打开 Notechain，点击顶栏的地球图标开启配对，
在扩展中完成配对。浏览器桥接只监听本机，默认端口为 `4281`。

Mac 中的 Atoll 连接是可选功能，需要另行安装支持该桥接的 Atoll 修改版；本仓库和
安装包不包含 Atoll 应用。Windows 使用软件内的中转站和浏览器扩展。

## CLI 与 AI

程序运行时，使用安装目录内的 `ledger` / `ledger.exe`。

```powershell
$ledger = Join-Path $env:LOCALAPPDATA 'Notechain\ledger.exe'
& $ledger graph cases
& $ledger graph get CASE_ID --output graph.json
& $ledger graph apply CASE_ID --file patch.json --preview
```

Mac：`/Applications/Notechain.app/Contents/MacOS/ledger`。
`--file` 支持 UTF-8、UTF-8 BOM 和带 BOM 的 UTF-16。输出为可直接解析的 JSON，
退出码 0 表示成功，1 表示失败。PowerShell 5.1 请优先使用文件输入，避免管道编码损失。
参数、批量修改约束和重试规则见 [skill](skills/notechain-graph/SKILL.md)。
当前 CLI 面向资产架构图，不代表全部编辑器操作都已开放为命令。

## 开发

需要 Node.js 24 LTS 与 Rust stable。Mac 还需要 Xcode 命令行工具；Windows 需要
Visual Studio Build Tools 的 C++ 桌面开发组件、Windows SDK 和 WebView2。

```text
npm ci
npm run mac:dev
npm run mac:build
```

Windows PowerShell 使用 `npm.cmd run windows:dev` 或 `npm.cmd run windows:build`。
构建产物分别位于 `src-tauri/target/release/bundle/macos` 和 `bundle/nsis`。

```text
npm run test:unit
npm run test:extension
npm run test:native
cargo build --locked --manifest-path src-tauri/Cargo.toml --bin ledger
npm run test:cli
npm run release:audit
```

`qa` 构建可运行真实 WebView 的回归测试。测试在临时目录生成输入，输出写入被忽略的
`.qa` 目录。仓库只保留源码、测试代码、构建配置、图标和所需许可证，不包含资料库、
笔记、附件、演示数据集、测试结果、构建缓存或本机工具链。

## 数据目录

Mac：`~/Library/Application Support/io.github.lyi-fan.notechain`。
Windows：`%APPDATA%\io.github.lyi-fan.notechain`。
`ASSET_LEDGER_DEV_DATA` 可指定隔离的开发资料库；此兼容变量不会自动启用测试模式。
旧的链接协议和存储键仍保留，避免破坏文档内的引用。

第三方许可说明保留在 `src-tauri/licenses`、`public/THIRD_PARTY_NOTICES.txt`
及扩展字体、图标对应目录中。
