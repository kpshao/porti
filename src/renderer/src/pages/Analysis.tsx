import { useEffect, useState } from 'react'
import type { AnalysisData } from '../../../main/analysisTypes'
import { formatEffectiveHoldings, formatHhi, formatPercent } from '../utils/format'
import { ipcErrorMessage } from '../utils/ipc'

/** 分析页（指标区）：本地计算的持仓集中度指标，只读、不依赖 AI 配置。
 *  口径：权重只按「可估值在持基金」（份额 > 0 且有最新净值）的市值计算，
 *  已清仓与缺净值基金不参与；参照只显示等权基准 1/N，不设阈值或颜色判断。 */
export default function Analysis(): React.JSX.Element {
  const [data, setData] = useState<AnalysisData | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 切页即重挂载，进入本页自动取最新数据（与概览/收益统计页同模式）
  useEffect(() => {
    window.api.analysisData().then(setData).catch((e) => setError(ipcErrorMessage(e)))
  }, [])

  const metrics = data?.metrics ?? null
  const hasValued = metrics !== null && metrics.valuedCount > 0

  return (
    <section className="page">
      <h1>分析</h1>

      {error !== null && <div className="banner banner-error">{error}</div>}

      {metrics !== null && !hasValued && (
        <p className="placeholder">
          {metrics.missingNavCount > 0
            ? `当前 ${metrics.missingNavCount} 只在持基金都缺最新净值，无法计算集中度指标。请先在「净值管理」补录净值。`
            : '当前没有在持基金，集中度指标暂无可计算的数据。'}
        </p>
      )}

      {hasValued && (
        <div className="card">
          <h2>集中度指标</h2>
          <div className="stat-row">
            <div className="stat">
              <div className="stat-label">前三大占比</div>
              <div className="stat-value">{formatPercent(metrics.top3Weight)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">最大单只占比</div>
              <div className="stat-value">{formatPercent(metrics.maxWeight)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">HHI</div>
              <div className="stat-value">{formatHhi(metrics.hhi)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">有效持仓数</div>
              <div className="stat-value">{formatEffectiveHoldings(metrics.effectiveHoldings)}</div>
            </div>
          </div>
          <p className="muted equal-weight-baseline">
            等权基准 1/N = {formatPercent(1 / metrics.valuedCount)}（N = {metrics.valuedCount} 只可估值在持基金）
          </p>
          {metrics.missingNavCount > 0 && (
            <div className="banner banner-info analysis-missing-nav">
              有 {metrics.missingNavCount} 只在持基金缺最新净值，未计入集中度指标；请到「净值管理」补录。
            </div>
          )}
          <p className="muted">
            权重 w_i = 基金市值 ÷ Σ可估值在持基金市值；HHI = Σw_i²；有效持仓数 = 1 ÷
            HHI。已清仓基金不参与，缺净值的在持基金不计入。
          </p>
        </div>
      )}
    </section>
  )
}
