# 开源发布许可证核对

核对日期：2026-11-16。项目版本：`@arnowei/pi-remote-workspaces@0.1.0`。

## 结论与适用范围

基于当前源码、`package-lock.json`、已安装依赖的许可证文件，以及标准 npm 打包方式，**未发现阻止本项目以 MIT 开源的明显许可证冲突**。主要需要处理的是上游说明和第三方许可证的保留，已在本次修改中补齐。

这个结论适用于发布当前 GitHub 源码仓库，以及通过 `npm pack` 生成的普通扩展包。它不是对全网代码相似性、版权归属、商标、专利或所有二进制内部组件的法律鉴定，也不覆盖将 pi、pi-web 或系统工具一并打包的独立应用/镜像。

## 代码来源与参考项目

| 对象 | 本项目的使用方式 | 许可证及处理 |
| --- | --- | --- |
| 本项目原创代码、页面和图标 | 本仓库实现 | 根目录 `LICENSE` 为 MIT，`package.json` 一致声明 `MIT` |
| dsh-remote | 远程工作区交互体验参考；当前仓库未包含其源码或素材 | 上游为 MIT；保留 README 致谢与许可证链接 |
| pi 的 `examples/extensions/ssh.ts` | 工具代理和事件接入模式的实现参考 | 上游为 MIT；已在源码标明参考来源，并在 `THIRD_PARTY_NOTICES.md` 保留 `Copyright (c) 2025 Mario Zechner` 和完整许可文本 |
| pi-web | 兼容性宿主、可选联调时单独下载；不随扩展包分发 | 上游为 MIT；保留兼容性说明和链接，不声称为其官方发行版 |
| `@earendil-works/pi-coding-agent@1.5.2`、`typebox@1.3.27` | 宿主提供的 peer dependencies，同时用于开发 | 均声明 MIT；当前 npm 包不捆绑其代码，单独再分发时应保留它们及其依赖的声明 |

MIT 允许使用、修改和再分发，也允许商业使用；涉及复制或实质性改编时，应保留上游版权和许可声明。仅在 README 放一个致谢链接，不能替代需要随代码保留的声明。见 [OSI 的 MIT 原文](https://opensource.org/license/mit)。

检查 `public/` 时，未发现随仓库分发的外部字体文件、上游截图或上游图标文件。CSS 中的字体名称使用本机字体回退；本次无需额外分发字体授权文件。

## 当前运行依赖

`npm ls --omit=dev --all --json` 得到以下运行依赖树：

| 依赖 | 锁定版本 | 许可证 | 再分发时的主要声明要求 |
| --- | --- | --- | --- |
| proper-lockfile | 4.1.2 | MIT | 保留其版权和许可文本 |
| graceful-fs | 4.2.12 | BlueOak-1.0.0 | 提供该许可证文本或官方许可证链接 |
| retry | 0.12.0 | MIT | 保留其版权和许可文本 |
| signal-exit | 3.0.7 | ISC | 保留其版权和许可声明 |

`graceful-fs` 的当前锁定版本使用 **BlueOak-1.0.0，而非旧版本常见的 ISC**。它允许广泛使用和修改，并要求向接收者提供许可证文本或链接；其文本没有要求本项目整体改为相同许可证。这里判断其不构成当前 MIT 发布的明显冲突，是基于许可证条文与当前分发结构的核对结论。见 [Blue Oak 官方原文](https://blueoakcouncil.org/license/1.0.0)。

以上四个包的实际许可证文本均已从当前安装包保留到 `THIRD_PARTY_NOTICES.md`。它们通常由 npm 单独安装并携带各自许可证，保留本项目的 MIT 声明不会把这些依赖改为 MIT。

## 开发依赖与打包边界

锁文件包含 **154 个依赖包路径条目**，含不同平台的可选包；本机实际安装 **129 个包**。锁文件的许可证元数据覆盖这些条目，出现的 SPDX 标识为：

- MIT
- Apache-2.0
- BSD-3-Clause
- ISC
- BlueOak-1.0.0
- Unlicense
- 0BSD

这次元数据检查没有发现 GPL、AGPL、LGPL、MPL 等标识，也没有缺失许可证元数据的锁定条目。这是元数据层面的结果，不能据此证明每个包内部的所有嵌入代码、WASM 或原生二进制都完成了独立许可证核查。

当前 `tsc` 构建编译本项目源码，保留依赖导入，不把依赖源码合并进 `dist/`。npm `files` 白名单不包含 `node_modules`；本次也将中英文 README 和 `THIRD_PARTY_NOTICES.md` 显式加入白名单。

如果以后改成单文件 bundle、附带 `node_modules`、Docker 镜像或桌面安装包，需要重新核对**实际分发的完整内容**，保留相应依赖的 LICENSE/NOTICE 和其他必要说明。尤其不能只复制本项目的 `LICENSE` 就认为覆盖了完整宿主、开发工具或系统二进制。

## 本次已完成

- 保持根目录 MIT 许可证与 `package.json` 一致。
- 增加 `THIRD_PARTY_NOTICES.md`，保留 pi SSH 示例的上游许可，以及四个运行依赖的完整许可文本。
- 在 `src/tools.ts` 和 `src/extension.ts` 加入来源说明。
- README 增加第三方声明入口和独立扩展说明。
- npm 包显式包含英文 README、中文 README、项目 LICENSE 和第三方声明。

## 发布者仍需确认

1. **有权许可原创部分。** 当前版权行是 `Arno Wei and contributors`。它是贡献者统称，不会自动证明权属；如涉及雇主、客户、受限合同或其他人的代码，需要发布者确认相应权利。可按实际情况改为权利人名称或项目使用的署名，不应虚构署名。
2. **后续复制内容继续保留来源。** 如果未来从 dsh-remote、pi-web 或其他项目复制实现、文档、图标或截图，应按对应来源及素材许可证重新处理，不能将本次结论自动延伸到新增内容。
3. **依赖或分发格式变化后重新核对。** 本文和依赖声明是当前锁定版本的快照，不是未来版本的永久许可证保证。

## 核对来源

- [本项目许可证](../LICENSE)
- [第三方声明](../THIRD_PARTY_NOTICES.md)
- [dsh-remote LICENSE](https://github.com/flymysql/dsh-remote/blob/main/LICENSE)
- [pi LICENSE](https://github.com/earendil-works/pi/blob/main/LICENSE)
- [pi SSH 示例](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/ssh.ts)
- [pi-web LICENSE](https://github.com/agegr/pi-web/blob/main/LICENSE)
- [MIT 原文](https://opensource.org/license/mit)
- [Blue Oak Model License 1.0.0 原文](https://blueoakcouncil.org/license/1.0.0)
- 当前安装包的 `proper-lockfile/LICENSE`、`graceful-fs/LICENSE.md`、`retry/License`、`signal-exit/LICENSE.txt`。
