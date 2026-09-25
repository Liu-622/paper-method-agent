# 第三方来源与权利说明

本文件为来源说明，不为第三方材料新增许可证。

- 官方实现：cure-lab/LTSF-Linear，固定提交 `0c113668a3b88c4c4ee586b8c5ec3e539c4de5a6`。原始 LICENSE、子目录许可证与本地兼容补丁均保留在 third_party/。来源：https://github.com/cure-lab/LTSF-Linear
- ETTm2 数据：来源 https://github.com/zhouhaoyi/ETDataset ，具体路径与用途见 data/SOURCES.md。遵守原始来源的使用条款。
- PDF.js、React 等 npm 依赖：版本锁定见 package-lock.json，安装后遵守各包原许可证。
- 内置论文元信息、引文与正文缓存：用于科研演示，来源标识见 src/data/ 与 public/catalog-pages.json；其版权属于原作者，不适用团队源码的许可声明。PDF 原文件未纳入本次源码发布包。
- lab-models/ 与 lab-cases/：本项目实验产生的权重、配置及固定案例，不是原作者发布权重，也不是用户私有运行历史。

团队尚未指定自有源码的开源许可证，因此本次打包不自动添加 MIT / Apache 等项目级许可。若计划长期公开复用，请另行确认自有代码与各第三方资产的授权范围。
