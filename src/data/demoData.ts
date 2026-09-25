import type { Evidence, Paper, PaperField, FieldKey } from '@/types'

/**
 * 演示数据（虚构）
 * ------------------------------------------------------------------
 * 以下 3 篇论文、全部原文片段、页码、实验设置均为**虚构的演示数据**，
 * 不是任何真实论文的分析结果，也不来自网络上的真实文献。
 * 它们被刻意设计成覆盖三类情况：
 *   1) 部分实验条件一致（P1 与 P2：数据集、划分、跨度、指标、协议一致）
 *   2) 预测跨度 / 指标 / 划分不同，成绩无法直接比较（P3 与 P1、P2）
 *   3) 复现关键信息缺失（P2 未固定种子、未公开代码；P3 缺预处理与学习率）
 */

export const DEMO_BADGE_TEXT = '演示数据，非真实论文分析'

/* ------------------------------------------------------------------ */
/* 原文片段                                                            */
/* ------------------------------------------------------------------ */

export const DEMO_EVIDENCE: Evidence[] = [
  /* ------------------------------ P1 ------------------------------ */
  {
    id: 'ev-p1-01',
    paperId: 'demo-p1',
    page: 1,
    section: 'Abstract',
    text: 'Existing Transformer-based forecasters struggle to capture long-term periodicity and short-term fluctuations simultaneously in long-horizon multivariate forecasting. We propose a Dual-Stream Attention Network (DSAN) that decouples the two patterns and fuses them with a learnable gate.',
    gloss: '现有 Transformer 类方法难以同时刻画长期周期性与短期波动；本文提出双流注意力网络 DSAN 把两种模式解耦后再融合。',
  },
  {
    id: 'ev-p1-02',
    paperId: 'demo-p1',
    page: 1,
    section: 'Abstract',
    text: 'DSAN reduces MSE by 11.2% on ETTm1 at horizon 96 compared with Informer, while increasing the number of parameters by less than 8%.',
    gloss: '在 ETTm1、跨度 96 下，DSAN 的 MSE 比 Informer 低 11.2%，参数量增加不到 8%。',
  },
  {
    id: 'ev-p1-03',
    paperId: 'demo-p1',
    page: 3,
    section: '3.1 Dual-Stream Design',
    text: 'The periodic stream applies dilated sparse attention with stride 4 to capture long-range dependencies, while the local stream uses sliding windows of length 24 to model short-term variation. A learned gate combines the two streams.',
    gloss: '周期流用步长 4 的膨胀稀疏注意力捕捉长程依赖；局部流用长度 24 的滑窗建模短期波动；两路用可学习门控融合。',
  },
  {
    id: 'ev-p1-04',
    paperId: 'demo-p1',
    page: 5,
    section: '4.1 Datasets',
    text: 'We evaluate DSAN on ETTm1 and Weather. Each dataset is split along the time axis into training, validation and test sets with a ratio of 7:1:2.',
    gloss: '在 ETTm1 与 Weather 上评估；沿时间轴按 7:1:2 切分训练/验证/测试。',
  },
  {
    id: 'ev-p1-05',
    paperId: 'demo-p1',
    page: 5,
    section: '4.1 Datasets',
    text: 'All variables are standardized with z-score normalization, and the statistics are computed on the training split only.',
    gloss: '所有变量做 z-score 标准化，统计量只取自训练集。',
  },
  {
    id: 'ev-p1-06',
    paperId: 'demo-p1',
    page: 5,
    section: '4.2 Experimental Setup',
    text: 'We report results for a prediction horizon of 96 steps under a single-shot protocol, where the model outputs the entire horizon at once.',
    gloss: '预测跨度为 96 步，采用单次预测协议，一次性输出整段跨度。',
  },
  {
    id: 'ev-p1-07',
    paperId: 'demo-p1',
    page: 5,
    section: '4.2 Experimental Setup',
    text: 'Models are trained with Adam (learning rate 1e-3, batch size 32) for up to 100 epochs with early stopping (patience 5).',
    gloss: '使用 Adam 训练，学习率 1e-3，批大小 32，最多 100 轮并配合早停（patience=5）。',
  },
  {
    id: 'ev-p1-08',
    paperId: 'demo-p1',
    page: 5,
    section: '4.2 Experimental Setup',
    text: 'A fixed random seed of 2021 is used for parameter initialization and data shuffling in all runs.',
    gloss: '所有实验固定随机种子 2021，用于参数初始化与数据打乱。',
  },
  {
    id: 'ev-p1-09',
    paperId: 'demo-p1',
    page: 6,
    section: '4.3 Metrics and Baselines',
    text: 'Following common practice we report MSE and MAE, and compare against Informer, Autoformer and FEDformer.',
    gloss: '报告 MSE 与 MAE，对比 Informer、Autoformer、FEDformer。',
  },
  {
    id: 'ev-p1-10',
    paperId: 'demo-p1',
    page: 6,
    section: '4.3 Metrics and Baselines',
    text: 'DSAN contains about 12.4M trainable parameters.',
    gloss: 'DSAN 约有 12.4M 可训练参数。',
  },
  {
    id: 'ev-p1-11',
    paperId: 'demo-p1',
    page: 7,
    section: '5 Results',
    text: 'Table 2 shows that DSAN lowers MSE by 11.2% and MAE by 8.6% on ETTm1 at horizon 96 compared with the strongest baseline.',
    gloss: '表 2 显示 ETTm1、跨度 96 下，DSAN 的 MSE 比最强基线低 11.2%、MAE 低 8.6%。',
  },
  {
    id: 'ev-p1-14',
    paperId: 'demo-p1',
    page: 5,
    section: '4.1 Datasets',
    text: 'ETTm1 is recorded every 15 minutes, while Weather is sampled every 10 minutes. For both datasets the test set covers 2018-01-01 to 2018-06-24, the final 20% of the series.',
    gloss: 'ETTm1 每 15 分钟采样、Weather 每 10 分钟采样；两个数据集的测试集都覆盖 2018-01-01 至 2018-06-24（序列最后 20%）。',
  },
  {
    id: 'ev-p1-12',
    paperId: 'demo-p1',
    page: 8,
    section: '6 Limitations',
    text: 'We do not verify performance beyond a prediction horizon of 336. The gating mechanism introduces one additional hyper-parameter that has to be tuned per dataset.',
    gloss: '未验证跨度超过 336 的表现；门控机制引入一个需要逐数据集调节的超参数。',
  },
  {
    id: 'ev-p1-13',
    paperId: 'demo-p1',
    page: 8,
    section: 'Reproducibility Statement',
    text: 'The implementation, together with the preprocessing scripts and the exact data split boundaries, is released at an anonymized repository.',
    gloss: '实现代码、预处理脚本与精确的划分边界均已在匿名仓库公开。',
  },

  /* ------------------------------ P2 ------------------------------ */
  {
    id: 'ev-p2-01',
    paperId: 'demo-p2',
    page: 1,
    section: 'Abstract',
    text: 'Patch-based representations have proven effective for vision transformers, but their use in time series forecasting remains underexplored. We propose PatchFormer, which splits the input series into fixed-length patches and applies sparse attention over patch tokens, reducing complexity to linear in the sequence length.',
    gloss: '把输入序列切成定长 patch，在 patch token 上做稀疏注意力，复杂度对序列长度线性。',
  },
  {
    id: 'ev-p2-02',
    paperId: 'demo-p2',
    page: 2,
    section: '3 Method',
    text: 'A patch-level reconstruction auxiliary loss is added during training to regularize the token representations. The sparse attention mask keeps only the k most relevant patch pairs, with k fixed to 4.',
    gloss: '训练时加入 patch 级重建辅助损失正则化 token 表示；稀疏掩码只保留最相关的 4 对 patch。',
  },
  {
    id: 'ev-p2-03',
    paperId: 'demo-p2',
    page: 4,
    section: '4.1 Datasets',
    text: 'Experiments are conducted on ETTm1 and Weather. Both datasets are split into training, validation and test parts with a ratio of 7:1:2.',
    gloss: '在 ETTm1 与 Weather 上实验，训练/验证/测试按 7:1:2 划分。',
  },
  {
    id: 'ev-p2-04',
    paperId: 'demo-p2',
    page: 4,
    section: '4.1 Datasets',
    text: 'Inputs are scaled with min-max normalization to [0, 1] using the statistics of the whole dataset before splitting.',
    gloss: '输入用 min-max 归一化到 [0,1]，且统计量取自切分之前的整个数据集。',
  },
  {
    id: 'ev-p2-13',
    paperId: 'demo-p2',
    page: 4,
    section: '4.1 Datasets',
    text: 'Both datasets are downsampled to a 15-minute sampling interval before patching.',
    gloss: '两个数据集在切分 patch 之前都被统一下采样到 15 分钟采样间隔。',
  },
  {
    id: 'ev-p2-05',
    paperId: 'demo-p2',
    page: 4,
    section: '4.2 Experimental Setup',
    text: 'We evaluate a prediction horizon of 96 steps under the single-shot protocol.',
    gloss: '评估跨度为 96 步，采用单次预测协议。',
  },
  {
    id: 'ev-p2-06',
    paperId: 'demo-p2',
    page: 4,
    section: '4.2 Experimental Setup',
    text: 'Training uses AdamW with a learning rate of 5e-4 and a batch size of 64 for 50 epochs without early stopping.',
    gloss: '使用 AdamW，学习率 5e-4，批大小 64，训练 50 轮，不使用早停。',
  },
  {
    id: 'ev-p2-07',
    paperId: 'demo-p2',
    page: 4,
    section: '4.2 Experimental Setup',
    text: 'We do not fix the random seed; each configuration is run three times and the mean is reported.',
    gloss: '不固定随机种子；每种配置跑三次并报告平均值。',
  },
  {
    id: 'ev-p2-08',
    paperId: 'demo-p2',
    page: 5,
    section: '4.3 Metrics and Baselines',
    text: 'We report MSE and MAE, and compare against Informer and Autoformer.',
    gloss: '报告 MSE 与 MAE，对比 Informer 与 Autoformer。',
  },
  {
    id: 'ev-p2-09',
    paperId: 'demo-p2',
    page: 5,
    section: '4.3 Metrics and Baselines',
    text: 'PatchFormer has 8.7M parameters.',
    gloss: 'PatchFormer 有 8.7M 参数。',
  },
  {
    id: 'ev-p2-10',
    paperId: 'demo-p2',
    page: 6,
    section: '5 Results',
    text: 'PatchFormer reaches competitive accuracy on ETTm1 and Weather while using about 30% fewer training FLOPs than the patch-free transformer baseline.',
    gloss: '在 ETTm1 与 Weather 上达到有竞争力的精度，训练 FLOPs 比无 patch 的 Transformer 基线少约 30%。',
  },
  {
    id: 'ev-p2-11',
    paperId: 'demo-p2',
    page: 6,
    section: '6 Limitations',
    text: 'The gains diminish on datasets with strong non-stationarity, where patch boundaries do not align with the underlying periods.',
    gloss: '在非平稳性强的数据集上收益下降，因为 patch 边界与真实周期不对齐。',
  },
  {
    id: 'ev-p2-12',
    paperId: 'demo-p2',
    page: 6,
    section: 'Reproducibility',
    text: 'We plan to release the code and the processed data after publication.',
    gloss: '计划在论文发表后公开代码与处理后的数据（当前无法获取）。',
  },

  /* ------------------------------ P3 ------------------------------ */
  {
    id: 'ev-p3-01',
    paperId: 'demo-p3',
    page: 1,
    section: 'Abstract',
    text: 'Linear forecasters are competitive on long-horizon benchmarks but degrade sharply when the prediction horizon changes. We introduce the Frequency-Enhanced Linear Predictor (FELP), which augments a linear mapping with low-frequency spectral components to enable zero-shot horizon transfer.',
    gloss: '线性预测器在跨度变化时性能急剧下降；本文提出 FELP，用低频频谱分量增强线性映射以实现零样本跨度迁移。',
  },
  {
    id: 'ev-p3-02',
    paperId: 'demo-p3',
    page: 2,
    section: '2 Method',
    text: 'FELP applies an FFT to the lookback window, keeps the lowest 8 frequency components, and concatenates their inverse transform with the linear output. Channel-independent gating allows transferring the trained model to unseen horizons without retraining.',
    gloss: '对回看窗口做 FFT，保留最低 8 个频率分量，反变换后与线性输出拼接；通道独立门控支持免重训的跨跨度迁移。',
  },
  {
    id: 'ev-p3-03',
    paperId: 'demo-p3',
    page: 3,
    section: '3.1 Data',
    text: 'We use ETTm1 and Traffic, split into training, validation and test sets with a ratio of 6:2:2.',
    gloss: '使用 ETTm1 与 Traffic，按 6:2:2 划分。',
  },
  {
    id: 'ev-p3-04',
    paperId: 'demo-p3',
    page: 3,
    section: '3.2 Settings',
    text: 'The main setting is a prediction horizon of 192 steps; the same trained model is additionally transferred to horizons 96 and 336.',
    gloss: '主设置为跨度 192；同一模型额外迁移到跨度 96 与 336。',
  },
  {
    id: 'ev-p3-05',
    paperId: 'demo-p3',
    page: 3,
    section: '3.2 Settings',
    text: 'Evaluation follows the rolling protocol, in which the input window is shifted by one step after every prediction.',
    gloss: '评估采用滚动协议，每次预测后窗口前移一步。',
  },
  {
    id: 'ev-p3-06',
    paperId: 'demo-p3',
    page: 3,
    section: '3.2 Settings',
    text: 'Inputs are rescaled; the detailed treatment is described in Appendix A.',
    gloss: '输入经过缩放，具体做法见附录 A。',
  },
  {
    id: 'ev-p3-07',
    paperId: 'demo-p3',
    page: 3,
    section: '3.2 Settings',
    text: 'Optimization uses Adam.',
    gloss: '使用 Adam 优化。',
  },
  {
    id: 'ev-p3-08',
    paperId: 'demo-p3',
    page: 3,
    section: '3.2 Settings',
    text: 'All experiments use random seed 42.',
    gloss: '所有实验使用随机种子 42。',
  },
  {
    id: 'ev-p3-09',
    paperId: 'demo-p3',
    page: 3,
    section: '3.2 Settings',
    text: 'The model is trained until convergence; we do not report a fixed number of epochs.',
    gloss: '模型训练至收敛，未给出固定训练轮数。',
  },
  {
    id: 'ev-p3-10',
    paperId: 'demo-p3',
    page: 4,
    section: '4.1 Metrics',
    text: 'We report MSE, MAE and SMAPE.',
    gloss: '报告 MSE、MAE 与 SMAPE。',
  },
  {
    id: 'ev-p3-11',
    paperId: 'demo-p3',
    page: 4,
    section: '4.2 Baselines',
    text: 'Baselines include Informer and DLinear. FELP holds fewer than 1M parameters.',
    gloss: '基线包括 Informer 与 DLinear；FELP 参数量少于 1M。',
  },
  {
    id: 'ev-p3-12',
    paperId: 'demo-p3',
    page: 4,
    section: '4.3 Results',
    text: 'At horizon 192 FELP lowers MSE by 6.4% over DLinear, but the advantage narrows to 1.2% at horizon 336.',
    gloss: '跨度 192 下 MSE 比 DLinear 低 6.4%；跨度 336 时优势缩小到 1.2%。',
  },
  {
    id: 'ev-p3-13',
    paperId: 'demo-p3',
    page: 5,
    section: '5 Limitations',
    text: 'Due to space limits we omit training details such as the preprocessing pipeline and the learning rate. Frequency gating also adds cost when the number of channels is large.',
    gloss: '受篇幅限制省略了预处理流程与学习率等训练细节；通道数很大时频域门控会带来额外开销。',
  },
  {
    id: 'ev-p3-14',
    paperId: 'demo-p3',
    page: 3,
    section: '3.1 Data',
    text: 'All series are resampled to an hourly resolution before training, so that every dataset shares the same sampling interval.',
    gloss: '训练前所有序列都重采样到 1 小时分辨率，使各数据集采样间隔一致。',
  },
]

export const EVIDENCE_BY_ID: Record<string, Evidence> = DEMO_EVIDENCE.reduce(
  (acc, item) => {
    acc[item.id] = item
    return acc
  },
  {} as Record<string, Evidence>,
)

/* ------------------------------------------------------------------ */
/* 字段构造辅助                                                        */
/* ------------------------------------------------------------------ */

interface FieldInput {
  value: string | null
  evidence?: string[]
  note?: string
}

function makeField(
  key: FieldKey,
  input: FieldInput,
  status: PaperField['status'],
): PaperField {
  return {
    key,
    value: input.value,
    status,
    origin: 'paper',
    evidenceIds: input.evidence ?? [],
    note: input.note,
  }
}

function found(key: FieldKey, input: FieldInput): PaperField {
  return makeField(key, input, 'found')
}
function missing(key: FieldKey, input: FieldInput): PaperField {
  return makeField(key, input, 'missing')
}
function uncertain(key: FieldKey, input: FieldInput): PaperField {
  return makeField(key, input, 'uncertain')
}

function buildFields(entries: [FieldKey, PaperField][]): Partial<Record<FieldKey, PaperField>> {
  return entries.reduce(
    (acc, [key, field]) => {
      acc[key] = field
      return acc
    },
    {} as Partial<Record<FieldKey, PaperField>>,
  )
}

/* ------------------------------------------------------------------ */
/* 3 篇演示论文                                                        */
/* ------------------------------------------------------------------ */

const P1: Paper = {
  id: 'demo-p1',
  source: 'demo',
  shortLabel: 'P1',
  fileName: 'DSAN-DualStream-Attention-2023.pdf',
  fileSize: 3_842_100,
  fileLastModified: null,
  title: 'Dual-Stream Attention Network for Long-Horizon Multivariate Time Series Forecasting',
  authors: 'L. Chen, Y. Zhang, R. Kumar',
  year: 2023,
  venue: 'DemoConf 2023（虚构）',
  status: 'parsed',
  uploadedAt: '2026-09-16T10:00:00.000Z',
  parseMessage: '演示数据，已完成字段抽取（虚构内容）',
  fields: buildFields([
    [
      'researchProblem',
      found('researchProblem', {
        value:
          '在长预测跨度下，多元时间序列的长期周期性与短期波动相互干扰，Transformer 类模型的误差随跨度快速累积。论文研究如何在不显著增加计算量的前提下同时建模这两种模式。',
        evidence: ['ev-p1-01'],
      }),
    ],
    [
      'method',
      found('method', {
        value:
          '双流注意力网络 DSAN：一条「周期流」用步长 4 的膨胀稀疏注意力捕捉长程周期依赖，一条「局部流」用长度 24 的滑窗注意力建模短期波动，两路输出经可学习门控加权融合。',
        evidence: ['ev-p1-03', 'ev-p1-01'],
      }),
    ],
    [
      'dataset',
      found('dataset', {
        value: 'ETTm1、Weather',
        evidence: ['ev-p1-04'],
      }),
    ],
    [
      'split',
      found('split', {
        value: '训练 / 验证 / 测试 = 7 : 1 : 2（沿时间轴切分）',
        evidence: ['ev-p1-04'],
      }),
    ],
    [
      'splitRange',
      found('splitRange', {
        value: '测试集为各序列最后 20%（ETTm1 与 Weather 均覆盖 2018-01-01 至 2018-06-24）',
        evidence: ['ev-p1-14'],
      }),
    ],
    [
      'sampleInterval',
      found('sampleInterval', {
        value: 'ETTm1 为 15 分钟；Weather 为 10 分钟',
        evidence: ['ev-p1-14'],
      }),
    ],
    [
      'horizon',
      found('horizon', {
        value: '96 步',
        evidence: ['ev-p1-06'],
      }),
    ],
    [
      'metrics',
      found('metrics', {
        value: 'MSE、MAE',
        evidence: ['ev-p1-09'],
      }),
    ],
    [
      'baselines',
      found('baselines', {
        value: 'Informer、Autoformer、FEDformer',
        evidence: ['ev-p1-09'],
      }),
    ],
    [
      'evalProtocol',
      found('evalProtocol', {
        value: '单次预测（single-shot），一次性输出整段 96 步',
        evidence: ['ev-p1-06'],
      }),
    ],
    [
      'preprocessing',
      found('preprocessing', {
        value: 'z-score 标准化，统计量仅取自训练集',
        evidence: ['ev-p1-05'],
      }),
    ],
    [
      'learningRate',
      found('learningRate', {
        value: '1e-3',
        evidence: ['ev-p1-07'],
      }),
    ],
    [
      'optimizer',
      found('optimizer', {
        value: 'Adam',
        evidence: ['ev-p1-07'],
      }),
    ],
    [
      'randomSeed',
      found('randomSeed', {
        value: '固定为 2021',
        evidence: ['ev-p1-08'],
      }),
    ],
    [
      'epochs',
      found('epochs', {
        value: '最多 100 轮，早停 patience = 5',
        evidence: ['ev-p1-07'],
      }),
    ],
    [
      'batchSize',
      found('batchSize', {
        value: '32',
        evidence: ['ev-p1-07'],
      }),
    ],
    [
      'params',
      found('params', {
        value: '约 12.4M',
        evidence: ['ev-p1-10'],
      }),
    ],
    [
      'codeAvailability',
      found('codeAvailability', {
        value: '已公开（匿名仓库，含预处理脚本与划分边界）',
        evidence: ['ev-p1-13'],
      }),
    ],
    [
      'conclusion',
      found('conclusion', {
        value:
          '在 ETTm1、跨度 96 下，MSE 比最强基线低 11.2%、MAE 低 8.6%，参数量仅增加不到 8%。',
        evidence: ['ev-p1-11', 'ev-p1-02'],
      }),
    ],
    [
      'limitations',
      found('limitations', {
        value:
          '未验证跨度超过 336 的表现；门控机制引入一个需要逐数据集调节的额外超参数。',
        evidence: ['ev-p1-12'],
      }),
    ],
  ]),
}

const P2: Paper = {
  id: 'demo-p2',
  source: 'demo',
  shortLabel: 'P2',
  fileName: 'PatchFormer-Patchwise-Sparse-2024.pdf',
  fileSize: 4_215_600,
  fileLastModified: null,
  title: 'PatchFormer: Patch-wise Sparse Transformer for Efficient Forecasting',
  authors: 'M. Alvarez, S. Ito',
  year: 2024,
  venue: 'DemoConf 2024（虚构）',
  status: 'parsed',
  uploadedAt: '2026-09-16T10:00:00.000Z',
  parseMessage: '演示数据，已完成字段抽取（虚构内容）',
  fields: buildFields([
    [
      'researchProblem',
      found('researchProblem', {
        value:
          '逐点注意力在长序列上计算开销大，而 patch 表示在时间序列预测中的有效性尚未被充分研究。论文研究如何用 patch 表示降低预测模型的复杂度。',
        evidence: ['ev-p2-01'],
      }),
    ],
    [
      'method',
      found('method', {
        value:
          'PatchFormer：把输入序列切成定长 patch，在 patch token 上做稀疏注意力（只保留最相关的 4 对 patch），复杂度对序列长度线性；训练时额外加入 patch 级重建辅助损失。',
        evidence: ['ev-p2-01', 'ev-p2-02'],
      }),
    ],
    [
      'dataset',
      found('dataset', {
        value: 'ETTm1、Weather',
        evidence: ['ev-p2-03'],
      }),
    ],
    [
      'split',
      found('split', {
        value: '训练 / 验证 / 测试 = 7 : 1 : 2',
        evidence: ['ev-p2-03'],
      }),
    ],
    [
      'splitRange',
      missing('splitRange', {
        value: null,
        note: '论文只给出了划分比例，没有说明测试集覆盖的起止时间。比例相同并不代表用的是同一段测试数据，这一项需要向作者确认或按数据集版本自行核对。',
      }),
    ],
    [
      'sampleInterval',
      found('sampleInterval', {
        value: 'ETTm1 与 Weather 均下采样到 15 分钟',
        evidence: ['ev-p2-13'],
      }),
    ],
    [
      'horizon',
      found('horizon', {
        value: '96 步',
        evidence: ['ev-p2-05'],
      }),
    ],
    [
      'metrics',
      found('metrics', {
        value: 'MSE、MAE',
        evidence: ['ev-p2-08'],
      }),
    ],
    [
      'baselines',
      found('baselines', {
        value: 'Informer、Autoformer',
        evidence: ['ev-p2-08'],
      }),
    ],
    [
      'evalProtocol',
      found('evalProtocol', {
        value: '单次预测（single-shot）',
        evidence: ['ev-p2-05'],
      }),
    ],
    [
      'preprocessing',
      found('preprocessing', {
        value: 'min-max 归一化到 [0, 1]，统计量取自切分之前的整个数据集',
        evidence: ['ev-p2-04'],
        note: '统计量包含测试段数据，与 P1「仅用训练集统计量」的做法不同，会影响误差数值。',
      }),
    ],
    [
      'learningRate',
      found('learningRate', {
        value: '5e-4',
        evidence: ['ev-p2-06'],
      }),
    ],
    [
      'optimizer',
      found('optimizer', {
        value: 'AdamW',
        evidence: ['ev-p2-06'],
      }),
    ],
    [
      'randomSeed',
      uncertain('randomSeed', {
        value: '论文明确说明不固定随机种子，改用三次运行的平均值',
        evidence: ['ev-p2-07'],
        note: '论文给出了做法，但没有可用种子值；复现时会有随机波动，需要报告多次运行的均值与方差。',
      }),
    ],
    [
      'epochs',
      found('epochs', {
        value: '50 轮，不使用早停',
        evidence: ['ev-p2-06'],
      }),
    ],
    [
      'batchSize',
      found('batchSize', {
        value: '64',
        evidence: ['ev-p2-06'],
      }),
    ],
    [
      'params',
      found('params', {
        value: '8.7M',
        evidence: ['ev-p2-09'],
      }),
    ],
    [
      'codeAvailability',
      missing('codeAvailability', {
        value: null,
        evidence: ['ev-p2-12'],
        note: '论文只说明「计划发表后公开」，当前没有可获取的代码或数据，需要自行实现。',
      }),
    ],
    [
      'conclusion',
      found('conclusion', {
        value:
          '在 ETTm1、Weather 上精度与强基线相当，同时训练 FLOPs 比无 patch 的 Transformer 少约 30%。',
        evidence: ['ev-p2-10'],
      }),
    ],
    [
      'limitations',
      found('limitations', {
        value: '在非平稳性强的数据集上收益下降，patch 边界与真实周期不对齐。',
        evidence: ['ev-p2-11'],
      }),
    ],
  ]),
}

const P3: Paper = {
  id: 'demo-p3',
  source: 'demo',
  shortLabel: 'P3',
  fileName: 'FELP-Frequency-Linear-ZeroShot-2024.pdf',
  fileSize: 2_987_400,
  fileLastModified: null,
  title: 'Frequency-Enhanced Linear Predictor for Zero-Shot Horizon Transfer',
  authors: 'J. Novak, H. Wang',
  year: 2024,
  venue: 'DemoWorkshop 2024（虚构，短文）',
  status: 'parsed',
  uploadedAt: '2026-09-16T10:00:00.000Z',
  parseMessage: '演示数据，已完成字段抽取（虚构内容）',
  fields: buildFields([
    [
      'researchProblem',
      found('researchProblem', {
        value:
          '线性预测器在固定跨度上表现不错，但跨度变化时性能急剧下降，缺乏跨跨度泛化能力。论文研究频域先验能否支撑零样本跨度迁移。',
        evidence: ['ev-p3-01'],
      }),
    ],
    [
      'method',
      found('method', {
        value:
          '频域增强线性预测器 FELP：对回看窗口做 FFT，保留最低 8 个频率分量，反变换后与线性映射输出拼接，再用通道独立门控实现免重训的跨度迁移。',
        evidence: ['ev-p3-02', 'ev-p3-01'],
      }),
    ],
    [
      'dataset',
      found('dataset', {
        value: 'ETTm1、Traffic',
        evidence: ['ev-p3-03'],
      }),
    ],
    [
      'split',
      found('split', {
        value: '训练 / 验证 / 测试 = 6 : 2 : 2',
        evidence: ['ev-p3-03'],
        note: '训练集比例低于 P1 / P2 的 7:1:2，测试段更长。',
      }),
    ],
    [
      'splitRange',
      missing('splitRange', {
        value: null,
        note: '短文没有给出测试集的起止时间，只说明按 6:2:2 划分。',
      }),
    ],
    [
      'sampleInterval',
      found('sampleInterval', {
        value: '1 小时（所有序列重采样到小时级）',
        evidence: ['ev-p3-14'],
      }),
    ],
    [
      'horizon',
      found('horizon', {
        value: '主设置 192 步；同一模型额外迁移到 96 与 336 步',
        evidence: ['ev-p3-04'],
      }),
    ],
    [
      'metrics',
      found('metrics', {
        value: 'MSE、MAE、SMAPE',
        evidence: ['ev-p3-10'],
      }),
    ],
    [
      'baselines',
      found('baselines', {
        value: 'Informer、DLinear',
        evidence: ['ev-p3-11'],
      }),
    ],
    [
      'evalProtocol',
      found('evalProtocol', {
        value: '滚动预测（rolling），每次预测后窗口前移一步',
        evidence: ['ev-p3-05'],
      }),
    ],
    [
      'preprocessing',
      uncertain('preprocessing', {
        value: '正文只说明「输入经过缩放」，具体方式指向附录 A',
        evidence: ['ev-p3-06'],
        note: '本次上传的文件中不包含附录 A，无法确认是 z-score 还是 min-max，也无法确认统计量来源。',
      }),
    ],
    [
      'learningRate',
      missing('learningRate', {
        value: null,
        note: '正文、实验设置与局限部分均未给出学习率。',
      }),
    ],
    [
      'optimizer',
      found('optimizer', {
        value: 'Adam',
        evidence: ['ev-p3-07'],
      }),
    ],
    [
      'randomSeed',
      found('randomSeed', {
        value: '固定为 42',
        evidence: ['ev-p3-08'],
      }),
    ],
    [
      'epochs',
      missing('epochs', {
        value: null,
        evidence: ['ev-p3-09'],
        note: '论文说明「训练至收敛」，但没有给出轮数或早停准则，无法判断训练是否充分。',
      }),
    ],
    [
      'batchSize',
      missing('batchSize', {
        value: null,
        note: '未给出批大小。',
      }),
    ],
    [
      'params',
      found('params', {
        value: '少于 1M',
        evidence: ['ev-p3-11'],
      }),
    ],
    [
      'codeAvailability',
      missing('codeAvailability', {
        value: null,
        note: '论文中没有代码或数据公开说明，也没有找到任何仓库链接。',
      }),
    ],
    [
      'conclusion',
      found('conclusion', {
        value:
          '跨度 192 下 MSE 比 DLinear 低 6.4%，参数量少于 1M；但跨度 336 时优势缩小到 1.2%。',
        evidence: ['ev-p3-12'],
      }),
    ],
    [
      'limitations',
      found('limitations', {
        value:
          '受篇幅限制省略了预处理与学习率等训练细节；通道数很大时频域门控带来额外开销。',
        evidence: ['ev-p3-13'],
      }),
    ],
  ]),
}

export const DEMO_PAPERS: Paper[] = [P1, P2, P3]

/** 深拷贝演示论文，避免 store 中的编辑污染原始数据 */
export function cloneDemoPapers(): Paper[] {
  return JSON.parse(JSON.stringify(DEMO_PAPERS)) as Paper[]
}

export function cloneDemoEvidence(): Evidence[] {
  return JSON.parse(JSON.stringify(DEMO_EVIDENCE)) as Evidence[]
}
