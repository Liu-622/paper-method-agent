/**
 * 内置公开文献清单：时间序列预测（长时/短时）领域
 * ------------------------------------------------------------------
 * 用途：让「方法分类 / 技术演进 / 研究方向」在用户还没有上传大量 PDF 时，
 * 也能基于**真实、来源可查**的论文元信息演示完整流程。
 *
 * 说明：
 *  - 这里只保存**元信息**（标题/作者/年份/会议/arXiv），来源是公开的 arXiv/会议记录，
 *    不是虚构论文，也不随包附送正文 PDF；正文与字段需要用户上传对应 PDF 后再补齐。
 *  - method/family/mechanisms/task 是**内置的公开常识性归类**（这些是广为引用的经典方法），
 *    来源类型标记为「工具推断」，界面上与「原文明示」「人工确认」分开显示，不冒充论文原句。
 *  - 年份来自发表记录；若某篇只有预印本，会单独标注口径。
 */
export interface CatalogEntry {
  id: string
  title: string
  authors: string
  year: number
  venue: string
  arxiv: string
  method: string
  family: string[]
  mechanisms: string[]
  task: string
}

export const TS_CATALOG: CatalogEntry[] = [
  { id: 'cat-nbeats', title: 'N-BEATS: Neural basis expansion analysis for interpretable time series forecasting', authors: 'Oreshkin et al.', year: 2020, venue: 'ICLR 2020', arxiv: '1905.10437', method: 'N-BEATS', family: ['MLP'], mechanisms: ['序列分解', '残差连接'], task: '单变量/多变量 短时+长时预测' },
  { id: 'cat-informer', title: 'Informer: Beyond Efficient Transformer for Long Sequence Time-series Forecasting', authors: 'Zhou et al.', year: 2021, venue: 'AAAI 2021', arxiv: '2012.07436', method: 'Informer', family: ['Transformer'], mechanisms: ['注意力', '稀疏注意力'], task: '长时多变量预测' },
  { id: 'cat-autoformer', title: 'Autoformer: Decomposition Transformers with Auto-Correlation for Long-Term Series Forecasting', authors: 'Wu et al.', year: 2021, venue: 'NeurIPS 2021', arxiv: '2106.13008', method: 'Autoformer', family: ['Transformer'], mechanisms: ['序列分解', '自相关'], task: '长时多变量预测' },
  { id: 'cat-scinet', title: 'SCINet: Time Series Modeling and Forecasting with Sample Convolution and Interaction', authors: 'Liu et al.', year: 2022, venue: 'NeurIPS 2022', arxiv: '2106.09305', method: 'SCINet', family: ['CNN'], mechanisms: ['卷积', '多尺度'], task: '长时多变量预测' },
  { id: 'cat-fedformer', title: 'FEDformer: Frequency Enhanced Decomposed Transformer for Long-term Series Forecasting', authors: 'Zhou et al.', year: 2022, venue: 'ICML 2022', arxiv: '2201.12740', method: 'FEDformer', family: ['Transformer'], mechanisms: ['频域处理', '序列分解'], task: '长时多变量预测' },
  { id: 'cat-etsformer', title: 'ETSformer: Exponential Smoothing Transformers for Time-series Forecasting', authors: 'Woo et al.', year: 2022, venue: 'arXiv 预印本', arxiv: '2202.01381', method: 'ETSformer', family: ['Transformer'], mechanisms: ['注意力', '序列分解'], task: '长时多变量预测' },
  { id: 'cat-dlinear', title: 'Are Transformers Effective for Time Series Forecasting?', authors: 'Zeng et al.', year: 2023, venue: 'AAAI 2023', arxiv: '2205.13504', method: 'DLinear / NLinear', family: ['Linear'], mechanisms: ['序列分解', '归一化去漂移'], task: '长时多变量预测' },
  { id: 'cat-timesnet', title: 'TimesNet: Temporal 2D-Variation Modeling for General Time Series Analysis', authors: 'Wu et al.', year: 2023, venue: 'ICLR 2023', arxiv: '2210.02186', method: 'TimesNet', family: ['CNN'], mechanisms: ['频域处理', '卷积'], task: '长时多变量预测' },
  { id: 'cat-crossformer', title: 'Crossformer: Transformer Utilizing Cross-Dimension Dependency for Multivariate Time Series Forecasting', authors: 'Zhang & Yan', year: 2023, venue: 'ICLR 2023', arxiv: '2211.14729', method: 'Crossformer', family: ['Transformer'], mechanisms: ['注意力', '跨维依赖'], task: '长时多变量预测' },
  { id: 'cat-patchtst', title: 'A Time Series is Worth 64 Words: Long-term Forecasting with Transformers', authors: 'Nie et al.', year: 2023, venue: 'ICLR 2023', arxiv: '2211.14730', method: 'PatchTST', family: ['Transformer'], mechanisms: ['Patch 表示', '通道独立'], task: '长时多变量预测' },
  { id: 'cat-micn', title: 'MICN: Multi-scale Local and Global Context Modeling for Long-term Series Forecasting', authors: 'Wang et al.', year: 2023, venue: 'ICLR 2023 (oral)', arxiv: 'openreview:zt53IDUR1U', method: 'MICN', family: ['CNN'], mechanisms: ['卷积', '多尺度'], task: '长时多变量预测' },
  { id: 'cat-itransformer', title: 'iTransformer: Inverted Transformers Are Effective for Time Series Forecasting', authors: 'Liu et al.', year: 2024, venue: 'ICLR 2024', arxiv: '2310.06625', method: 'iTransformer', family: ['Transformer'], mechanisms: ['注意力', '变量维度建模'], task: '长时多变量预测' },
]

/** 归一化词表（分类用；不表示穷尽，缺失/未知走「待分类」） */
export const FAMILY_VOCAB = ['Linear', 'Transformer', 'CNN', 'RNN', 'MLP', '混合架构']
export const MECHANISM_VOCAB = ['序列分解', '频域处理', 'Patch 表示', '通道独立', '注意力', '卷积', '多尺度', '残差连接', '归一化去漂移', '自相关']
export const TASK_VOCAB = ['长时预测', '短时预测', '单变量', '多变量']
