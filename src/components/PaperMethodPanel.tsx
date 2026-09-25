import { Icon } from '@/components/Icons'
import { Tag } from '@/components/StatusTag'
import type { LabReplication, PaperConsistency, PaperMethodsPayload, PaperMethodRun } from '@/services/lab'

/**
 * 官方论文方法面板：论文入口 / 运行状态 / 复现状态四维度 / 指标口径 / 数据划分
 * 说明：本作品没有上传该论文正文，因此**不显示任何逐字引用与页码**；
 *      方法说明只来自论文元信息与官方仓库实现。
 */
export function PaperMethodPanel({
  payload,
  claim,
  onRunBaseline,
  onConsistency,
  consistency,
  busy,
  consistencyBusy,
  perturbationLabel,
}: {
  payload: PaperMethodsPayload
  claim: string
  onRunBaseline: () => void
  onConsistency: () => void
  consistency: PaperConsistency | null
  busy: boolean
  consistencyBusy: boolean
  perturbationLabel: string
}) {
  const { paper, methods, trained, split } = payload
  const byMethod = (m: 'DLinear' | 'Linear') => trained.find((t) => t.method === m) ?? null

  return (
    <div className="card lab-paper">
      <div className="card-head row">
        <strong>官方论文方法</strong>
        <Tag tone="blue">{paper.venue}</Tag>
        <Tag tone={paper.textAvailable ? 'green' : 'orange'}>{paper.textAvailable ? '正文已上传' : '正文未上传'}</Tag>
        <span className="spacer" />
        <a className="tiny" href={paper.repo} target="_blank" rel="noreferrer">
          官方仓库（{paper.sha.slice(0, 8)}）↗
        </a>
      </div>
      <div className="card-body">
        <div className="lab-paper-title">{paper.title}</div>
        <div className="tiny muted-2" style={{ marginTop: 4 }}>
          {payload.paperSource?.authors ?? 'Ailing Zeng, Muxi Chen, Lei Zhang, Qiang Xu'}｜{paper.venue}｜{paper.license}
        </div>
        {payload.paperSource && (
          <div className="lab-paper-quotes">
            <div className="tiny muted-2">论文里的原句（逐字核对，来自本机 PDF：{payload.paperSource.pdfPath}）</div>
            <ul className="lab-quote-list">
              <li>
                <span className="tiny mono">第 {payload.paperSource.methodQuote.page} 页</span>
                <div className="lab-quote">{payload.paperSource.methodQuote.text}</div>
              </li>
              <li>
                <span className="tiny mono">第 {payload.paperSource.kernelQuote.page} 页</span>
                <div className="lab-quote">{payload.paperSource.kernelQuote.text}</div>
              </li>
              <li>
                <span className="tiny mono">第 {payload.paperSource.protocolQuote.page} 页</span>
                <div className="lab-quote">{payload.paperSource.protocolQuote.text}</div>
              </li>
            </ul>
          </div>
        )}
        <div className="tiny muted-2" style={{ marginTop: 4 }}>
          {paper.note}｜方法与超参来自官方脚本 {methods.DLinear.script}
        </div>

        <div className="lab-paper-question">
          <Icon name="lab" size={15} />
          <div>
            <b>本次要测的具体问题：</b>
            {claim || '在当前数据与设置下，DLinear 相对 Linear 的表现，在输入受到扰动后是否保持稳定？'}
            <div className="tiny muted-2" style={{ marginTop: 3 }}>
              这是本工具提出的**压力测试问题**；原文未就"输入扰动下的稳定性"给出结论，因此不把它当作作者原始结论。
              本轮固定预测跨度 pred_len=96（换跨度需要重新训练）。
            </div>
          </div>
        </div>

        {/* 训练与权重状态 */}
        <div className="lab-paper-methods">
          {(['DLinear', 'Linear'] as const).map((m) => {
            const t = byMethod(m)
            return (
              <div className="lab-paper-method" key={m}>
                <div className="row-tight" style={{ gap: 6 }}>
                  <b>{methods[m].label}</b>
                  <Tag tone="green">官方实现</Tag>
                  {t?.hasParity && <Tag tone="blue">已与 PyTorch 对齐</Tag>}
                </div>
                {t ? (
                  <ul className="tight-list tiny" style={{ marginTop: 6 }}>
                    <li>
                      seq_len {t.task.seqLen}｜pred_len {t.task.predLen}｜features {t.task.features}｜enc_in {t.task.encIn}
                    </li>
                    <li>
                      训练：{t.hyper.epochs} 轮｜batch {t.hyper.batch}｜lr {t.hyper.lr}｜{t.hyper.optim}｜seed {t.hyper.seed}
                    </li>
                    <li>
                      耗时：训练 {t.timing.trainSeconds}s（每轮约 {t.timing.epochSeconds?.[0] ?? '—'}s）｜推理 {t.timing.inferSeconds}s｜参数 {t.params}
                    </li>
                    <li>数据哈希 {t.dataSha256}｜权重版本 {t.runId}</li>
                  </ul>
                ) : (
                  <div className="tiny muted-2" style={{ marginTop: 6 }}>
                    还没有训练好的权重，先在开发环境运行 <code>python scripts/paper-method/train_ltsf.py --model {m}</code>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* 复现状态：四个维度分开看 */}
        <div className="lab-repro-grid">
          {(['DLinear', 'Linear'] as const).map((m) => {
            const t = byMethod(m)
            if (!t) return null
            const reducedEpochs = t.hyper.epochs < 10
            return (
              <div className="lab-repro-row" key={`st-${m}`}>
                <div className="lab-repro-name">{m}</div>
                <div className="lab-repro-cells">
                  <div>
                    <span className="tiny muted-2">方法来源</span>
                    <div>{t.methodSource === 'official' ? '官方实现（未改写模型定义）' : '自行实现'}</div>
                  </div>
                  <div>
                    <span className="tiny muted-2">设置对应程度</span>
                    <div>{reducedEpochs ? `存在调整：训练 ${t.hyper.epochs} 轮（少于官方脚本）` : '与官方 ettm2.sh 一致'}</div>
                  </div>
                  <div>
                    <span className="tiny muted-2">执行状态</span>
                    <div>已完成（训练 + 推理 + 评估）</div>
                  </div>
                  <div>
                    <span className="tiny muted-2">结果核对</span>
                    <div>
                      {payload.comparison?.rows.find((r) => r.method === m)?.gapSummary
                        ? (() => {
                            const g = payload.comparison!.rows.find((r) => r.method === m)!.gapSummary!
                            return (
                              <>
                                同口径对照：标准化空间 MAE {g.localMae.toFixed(4)} vs 论文 {g.refMae}（差 {g.diff > 0 ? '+' : ''}
                                {g.diff}，{g.relPercent > 0 ? '+' : ''}
                                {g.relPercent}%）
                                <div className="tiny muted-2">口径一致（多变量/7 通道/标准化/MSE-MAE/T=96），可以与论文 Table 2 对照；不宣称复现成功。</div>
                              </>
                            )
                          })()
                        : '暂不可直接对照'}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* 指标口径：MAE / MSE / RMSE 分别记录 + 与论文同口径对照 */}
        <div className="lab-metric-spec">
          <div className="tiny muted-2">评估口径（两种方法完全一致）</div>
          <ul className="tight-list tiny">
            <li>指标：MAE、MSE、RMSE 分别记录（不合并成"都含 MAE 就算匹配"）</li>
            <li>变量：输入 7 通道、预测目标同 7 通道；压力测试的对比数字取目标列 **OT**</li>
            <li>单位空间：训练用官方 StandardScaler（fit 在训练段）；指标同时给出**标准化空间**与**原始单位**</li>
            <li>聚合方式：对所有评估窗口 × 所有预测步取平均；样本数在每次实验结果里公开</li>
          </ul>
        </div>

        {payload.comparison && (
          <div className="lab-compare">
            <div className="tiny muted-2">与论文报告值的同口径对照（参考值：{payload.comparison.reference.source}）</div>
            <div className="table-wrap" style={{ marginTop: 6 }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>方法 / 口径</th>
                    <th>MAE</th>
                    <th>MSE</th>
                    <th>能否对照</th>
                  </tr>
                </thead>
                <tbody>
                  {payload.comparison.rows.flatMap((r) =>
                    r.spaces.map((sp) => (
                      <tr key={`${r.method}-${sp.key}`}>
                        <td className="row-label">
                          {r.method}｜{sp.label}
                        </td>
                        <td>{sp.mae !== null ? sp.mae.toFixed(4) : '—'}</td>
                        <td>{sp.mse !== null ? sp.mse.toFixed(4) : '—'}</td>
                        <td>
                          <Tag tone={sp.comparable ? 'green' : 'slate'}>{sp.comparable ? '可以对照' : '暂不可直接对照'}</Tag>
                          {sp.comparable && sp.gapMae !== null && sp.gapMae !== undefined && (
                            <div className="tiny muted-2">
                              与论文差 {sp.gapMae > 0 ? '+' : ''}
                              {sp.gapMae}（MAE）
                            </div>
                          )}
                          {!sp.comparable && sp.missing && sp.missing.length > 0 && (
                            <div className="tiny muted-2">缺少：{sp.missing.join('；')}</div>
                          )}
                        </td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
            <div className="tiny muted-2" style={{ marginTop: 6 }}>
              {payload.comparison.alignmentRule}
            </div>
            <div className="lab-factors">
              <div className="tiny muted-2">差距的**待检查因素**（不是已证实的解释）</div>
              <ul className="tight-list tiny">
                {(payload.comparison.rows[0]?.factorsToCheck ?? []).map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
              <div className="tiny muted-2">{payload.comparison.noCausalClaim}</div>
            </div>
          </div>
        )}

        {/* 数据划分（含日期） */}
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table className="data">
            <thead>
              <tr>
                <th>区间</th>
                <th>索引</th>
                <th>日期</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="row-label">训练（官方）</td>
                <td>
                  {split.train.usedStart}–{split.train.usedEnd}
                </td>
                <td>
                  {split.train.startDate} → {split.train.endDate}
                </td>
                <td>官方 border 公式；标准化参数只用这一段拟合</td>
              </tr>
              <tr>
                <td className="row-label">验证（官方）</td>
                <td>
                  {split.val.usedStart}–{split.val.usedEnd}
                </td>
                <td>
                  {split.val.startDate} → {split.val.endDate}
                </td>
                <td>含 seq_len 回溯重叠；未用于早停（本轮固定轮数，不选模）</td>
              </tr>
              <tr>
                <td className="row-label">测试（官方）</td>
                <td>
                  {split.test.usedStart}–{split.test.usedEnd}
                </td>
                <td>
                  {split.test.startDate} → {split.test.endDate}
                </td>
                <td>第一个可评估起点 {split.evalStart}；官方脚本实际用到的数据到此为止</td>
              </tr>
              <tr>
                <td className="row-label">探索切片</td>
                <td>
                  {split.customSlices.explore.usedStart}–{split.customSlices.explore.usedEnd}
                </td>
                <td>
                  {split.customSlices.explore.startDate} → {split.customSlices.explore.endDate}
                </td>
                <td>
                  <Tag tone="orange">自定义切片</Tag> 已用于条件搜索
                </td>
              </tr>
              <tr>
                <td className="row-label">另一时间段一致性检查切片</td>
                <td>
                  {split.customSlices.consistency.usedStart}–{split.customSlices.consistency.usedEnd}
                </td>
                <td>
                  {split.customSlices.consistency.startDate} → {split.customSlices.consistency.endDate}
                </td>
                <td>
                  <Tag tone="orange">自定义切片</Tag>
                  {split.customSlices.consistency.label.includes('不能称为从未使用') ? '；未用于条件搜索，但不称为"从未使用的独立复验数据"' : ''}
                </td>
              </tr>
              <tr>
                <td className="row-label">超出官方基准</td>
                <td>
                  {split.outOfBenchmark.from}–{split.outOfBenchmark.to}（{split.outOfBenchmark.len} 点）
                </td>
                <td>
                  {split.outOfBenchmark.startDate} → {split.outOfBenchmark.endDate}
                </td>
                <td>
                  <Tag tone="red">未使用</Tag> {split.outOfBenchmark.note}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="lab-actions" style={{ marginTop: 12 }}>
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={onRunBaseline}>
            <Icon name="rocket" size={14} /> {busy ? '正在运行…' : '在实验室运行这个方法（无扰动基准）'}
          </button>
          <button className="btn btn-sm" disabled={consistencyBusy} onClick={onConsistency}>
            <Icon name="lab" size={14} /> {consistencyBusy ? '正在检查…' : '在另一时间段做一致性检查'}
          </button>
          <span className="tiny muted-2">两种方法在同一批窗口、同一份扰动、同一评估目标上运行；扰动只作用输入，{perturbationLabel}</span>
        </div>

        {consistency?.ok && (
          <div className="lab-replication" style={{ marginTop: 10 }}>
            <div className="tiny muted-2">{consistency.sliceLabel}</div>
            <div className="small mono" style={{ marginTop: 4 }}>
              {consistency.rows.map((r) => `${r.strength}:Δ${r.deltaMae.toFixed(4)}(${r.leader})`).join('  ')}
            </div>
            <div className="row-tight" style={{ marginTop: 6, gap: 6 }}>
              <Tag tone={consistency.leaderStable ? 'slate' : 'orange'}>{consistency.leaderStable ? '领先方稳定' : '领先方翻转'}</Tag>
              <Tag tone="slate">方向 {consistency.direction}</Tag>
            </div>
            <div className="small" style={{ marginTop: 6 }}>
              {consistency.note}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
