# 完整 IDE 体验计划附件

2026-09-30。本目录是规划产物，不是已启用的 DSH 配置；不随 VSIX 分发。

- [完整实施计划](../../PLAN-FULL-IDE-EXPERIENCE.md)：F01–F28、P0–P6、worker 文件所有权和 G01–G28。
- [Profile/插件契约](../../PLAN-VSCODE-PROFILE-PLUGIN-CONTRACTS.md)：设置总开关、插件子开关、DSH UI 插件、generation、服务接口和迁移。
- [架构 PNG](architecture.png) / [Mermaid 源码](architecture.mmd)。
- [Recipe 设计示例](vscode-profile.recipe.example.json)：schemaVersion=0，明确 design-only-not-executable；不能直接交给 DSH loader。

## 本次文档验证

已检查：28 个功能逐项关联 28 个验收门槛；9 个插件设置默认值与契约一致；模块依赖无环、capability 提供者唯一；JSON 示例可解析；正文无尾随空格；新增及关联文档的本地链接有效。

Mermaid 11.16.0 使用隔离的本地 Chrome 验证并输出 PNG，已目视检查可读性。沙箱内浏览器启动两次超时，改用已获自动批准的本地隔离渲染后成功；没有将图源发送到外部渲染服务。

git diff --check 通过。额外运行 scripts/check-package-contents.js 时，VSIX 清单检查已越过禁止规划文件入包的检查，但随后被**原工作区已有未提交的 runtime-integration 文件**阻断，首先报 contracts/runtime-v1.json 为未跟踪文件。没有为通过此门禁提交、回退或清理用户代码；不能将这次完整打包门禁记为 PASS。

本次没有修改产品代码、扩展版本、用户 settings、真实 profile 或已安装插件，也没有重跑产品完整测试。功能仍处于总计划标注的基线状态；后续实现必须另行取得对应验收证据。
