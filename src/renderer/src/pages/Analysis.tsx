import { useEffect, useState } from 'react'
import type { AnalysisData } from '../../../main/analysisTypes'
import AiChat from '../components/AiChat'
import { formatEffectiveHoldings, formatHhi, formatPercent } from '../utils/format'
import { ipcErrorMessage } from '../utils/ipc'

interface AnalysisProps {
  /** 页面导航（未配置 AI 时引导去设置页） */
  onNavigate?: (page: string) => void
}

/** 分析页：上半部为本地计算的持仓集中度指标（只读、不依赖 AI 配置），下半部为 AI 对话。
 *  口径见 CONTEXT.md「集中度指标」；AI 对话的联网边界见 ADR-0003。 */
export default function Analysis({ onNavigate }: AnalysisProps): React.JSX.Element {
  const [data, setData] = useState<AnalysisData | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 挂载时取数；数据变化后由离开/重新进入本页刷新
  useEffect(() => {
    window.api.analysisData().then(setData).catch((e) => setError(ipcErrorMessage(e)))
  }, [])

  const metrics = data?.metrics ?? null
  const hasValuedHoldings = metrics !== null && metrics.valuedCount > 0

  return (
    <section className="page">
      <h1>分析</h1>

      {error !== null && <div className="banner banner-error">{error}</div>}

      {data !== null && (
        <p className="muted analysis-freshness">数据新鲜度：最新净值日期 {data.latestNavDate ?? '—'}</p>
      )}

      {metrics !== null && metrics.valuedCount === 0 && (
        <p className="placeholder">
          {metrics.missingNavCount > 0
            ? `当前 ${metrics.missingNavCount} 只在持基金都缺最新净值，无法计算集中度指标。请先在「净值管理」补录净值。`
            : '当前没有在持基金，集中度指标暂无可计算的数据。'}
        </p>
      )}

      {hasValuedHoldings && (
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

      <AiChat
        hasHoldings={metrics !== null && metrics.valuedCount + metrics.missingNavCount > 0}
        onNavigateToSettings={() => onNavigate?.('settings')}
      />
    </section>
  )
}
