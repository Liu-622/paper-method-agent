# 数据来源（实验室用）

## ETTm2.csv —— 真实公开数据

- **数据集**：ETT（Electricity Transformer Temperature）small 版中的 **ETTm2**
- **官方仓库**：<https://github.com/zhouhaoyi/ETDataset>（`ETT-small/ETTm2.csv`）
- **本次获取地址**：<https://raw.githubusercontent.com/zhouhaoyi/ETDataset/main/ETT-small/ETTm2.csv>
- **本地文件**：`data/ETTm2.csv`（9,677,236 字节，69,680 行数据 + 1 行表头）
- **时间范围**：2016-07-01 00:00 → 2018-06-26 19:45，**采样间隔 15 分钟**
- **列**：`date, HUFL, HULL, MUFL, MULL, LUFL, LULL, OT`
- **本实验室使用的子集**：只使用 **`OT` 单变量**（油温，论文里常见的预测目标），
  按时间顺序划分训练/验证/测试（沿用原数据集的划分长度：34560 / 11520 / 11520），
  不跨数据集、不做随机打乱。
- 该数据集正是 Autoformer / FEDformer / PatchTST 论文使用的公开数据之一。
  **但本实验室的两条曲线不用于评价这些论文的方法**（见下方说明）。

## 与论文的关系（必须读）

实验室提供的是两个**轻量教学方法**：

| 方法 | 说明 |
| --- | --- |
| `seasonal_naive` 季节性朴素预测 | 直接把「上一个季节同一时刻」的值当作预测 |
| `ridge` 岭回归自回归 | 用历史窗口的滞后值做特征的线性模型（闭式解） |

它们**不是** Autoformer / FEDformer / PatchTST 的实现，也不是它们的复现。
因此实验室里得到的任何结果：

- 可以用来理解「比较条件怎么影响结论」；
- **不能**用来判断这些论文的方法优劣；
- **不能**当作对该论文结论的验证或反证。

界面与导出记录中都会带上 `methodScope: teaching` 这一标注。

## 合成数据（可选分支）

当 `data/ETTm2.csv` 不存在时，服务端会改用**代码生成的合成序列**继续跑通流程，
并在数据来源、页面顶部、导出文件里**显著标注「合成数据」**，且
`dataSource.kind = 'synthetic'`。合成数据的结果不会与真实数据的结果混在同一张地图里。
