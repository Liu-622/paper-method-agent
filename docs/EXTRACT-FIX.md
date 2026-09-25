# 字段抽取修复：修复前 / 修复后对照（三篇真实论文）

> 自动生成：`node scripts/extract-compare.mjs`（数据来自 `docs/results/extract-before.json` 与 `extract-after.json`）
> 修复前 = `EXTRACT_SECOND_PASS=0`（关闭定向二次检索，等价于原行为）；修复后 = 默认（含二次检索）。

| 论文 | 字段 | 修复前 | 修复后 |
| --- | --- | --- | --- |
| Autoformer | dataset | missing | **found：ETT（ETTh1、ETTh2、ETTm1、ETTm2）、Electricity、Excha** |
| Autoformer | split | found：ETT按6:2:2，其他数据集按7:1:2，按时间顺序划分训练/验证/测试。 | found：ETT按6:2:2，其他数据集按7:1:2，按时间顺序划分训练/验证/测试。 |
| Autoformer | splitRange | uncertain：论文只给出划分比例（ETT 6:2:2，其他7:1:2），未给出测试集具体起止日期或时间边界 | **found/★漏抽找回：所有数据集按时间顺序以6:2:2比例划分为训练集、验证集和测试集** |
| Autoformer | sampleInterval | missing | **found/★漏抽找回：Electricity 每小时、Exchange 每天、Traffic 每小时、Weathe** |
| Autoformer | evalProtocol | missing | **missing/未报告** |
| Autoformer | baselines | found：Informer、Reformer、LogTrans、LSTNet、LSTM、TCN、N-B | found：Informer、Reformer、LogTrans、LSTNet、LSTM、TCN、N-B |
| Autoformer | metrics | found：MSE、MAE | found：MSE、MAE |
| Autoformer | horizon | found：多变量O∈{96,192,336,720}；ILI为{24,36,48,60}；单变量O∈{ | **found：多变量与单变量：O ∈ {96, 192, 336, 720}；ILI 为 {24, 36,** |
| Autoformer | preprocessing | missing | **missing/未报告** |
| FEDformer | dataset | missing | **found：ETTm2、Electricity、Exchange、Traffic、Weather、ILI** |
| FEDformer | split | found：训练:验证:测试 = 7:1:2 | **found：训练/验证/测试 = 7:1:2** |
| FEDformer | splitRange | uncertain：论文只给出7:1:2比例，未给出测试集起止日期或时间区间 | **uncertain/★漏抽找回：论文只提到按 7:1:2 的比例划分训练集、验证集和测试集，但未给出具体的时间区间或起止日期** |
| FEDformer | sampleInterval | found：ETTm1/ETTm2 15分钟；ETTh1/ETTh2 1小时；Electricity 1 | **found：ETTm1/ETTm2 15 分钟、ETTh1/ETTh2 1 小时、Electricity** |
| FEDformer | evalProtocol | missing | **missing/未报告** |
| FEDformer | baselines | found：Autoformer、Informer、LogTrans、Reformer（另在消融中对比T | **found：Autoformer、Informer、LogTrans、Reformer；消融中还对比 T** |
| FEDformer | metrics | found：MSE、MAE；另用Kolmogorov-Smirnov检验P值分析分布相似性 | **found：MSE、MAE；另用 Kolmogorov-Smirnov 检验的 P-value 评估分布** |
| FEDformer | horizon | found：O ∈ {96, 192, 336, 720}；ILI数据集为 O ∈ {24, 36, 4 | **found：O ∈ {96, 192, 336, 720}；ILI 数据集为 O ∈ {24, 36, ** |
| FEDformer | preprocessing | missing | **missing/未报告** |
| PatchTST | dataset | found：Weather、Traffic、Electricity、ILI、ETTh1、ETTh2、ET | found：Weather、Traffic、Electricity、ILI、ETTh1、ETTh2、ET |
| PatchTST | split | missing | **missing/未报告** |
| PatchTST | splitRange | missing | **missing/未报告** |
| PatchTST | sampleInterval | missing | **found/★漏抽找回：包含多种采样频率：分钟级（m）、小时级（h）、15分钟分辨率、每周（weekly）、每日（d** |
| PatchTST | evalProtocol | missing | **missing/未报告** |
| PatchTST | baselines | found：FEDformer、Autoformer、Informer、Pyraformer、LogTr | found：FEDformer、Autoformer、Informer、Pyraformer、LogTr |
| PatchTST | metrics | found：MSE、MAE。 | found：MSE、MAE。 |
| PatchTST | horizon | found：ILI数据集 T ∈ {24, 36, 48, 60}；其他数据集 T ∈ {96, 192 | **found：ILI为T∈{24,36,48,60}；其他数据集为T∈{96,192,336,720}。** |
| PatchTST | preprocessing | found：实例归一化（Instance Normalization）：对每个单变量序列x(i)做零均值 | **found：实例归一化（Instance Normalization）：对每个单变量序列做零均值单位标准** |

## 断言结果

| 断言 | 结果 | 依据 |
| --- | --- | --- |
| Autoformer 抽到数据集名称（≥6 个） | ✅ 通过 | 命中 9 个：ETTh1、ETTh2、ETTm1、ETTm2、Traffic、Electricity、Weather、ILI、Exchange |
| Autoformer 抽到「按数据集的采样频率」（≥4 个数据集有间隔） | ✅ 通过 | 有间隔的数据集 4 个：Electricity=Electricity 每小时 / Traffic=Traffic 每小时 / Weather=Weather 每10分钟 / ILI=ILI 每周 |
| FEDformer 抽到数据集名称（≥6 个） | ✅ 通过 | 命中 9 个：ETTh1、ETTh2、ETTm1、ETTm2、Traffic、Electricity、Weather、ILI、Exchange |
| FEDformer 抽到四个主要基线 | ✅ 通过 | 命中 Autoformer、Informer、LogTrans、Reformer |
| PatchTST 抽到 ETTm 15 分钟 | ✅ 通过 | perDataset=（整体）=包含多种采样频率：分钟级（m）、小时级（ / ETTh1=每 1 小时（ETTh） / ETTh2=每 1 小时（ETTh） / ETTm1=每 15 分钟（ETTm） / ETTm2=每 15 分钟（ETTm）｜整体=「包含多种采样频率：分钟级（m）、小时级（h）、 |
| PatchTST 抽到 ETTh 1 小时 | ✅ 通过 | 同上 |
| Autoformer 的 ETT 划分含 6:2:2 | ✅ 通过 | ETT按6:2:2，其他数据集按7:1:2，按时间顺序划分训练/验证/测试。 |
| FEDformer 的划分含 7:1:2 | ✅ 通过 | 训练/验证/测试 = 7:1:2 |
| PatchTST 的划分判为「信息不足」（未报告） | ✅ 通过 | status=missing checkState=not_reported value= |
| 三者划分取值不唯一 → 比较结果必须出现「存在差异」 | ✅ 通过 | 取值：6:2:2、7:1:2 + PatchTST 信息不足 |

**合计：10/10 通过。**
