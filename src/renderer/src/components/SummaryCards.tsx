import type { SummaryData, SummaryScope } from '../../../engine'
import { useSummaryScope } from '../hooks/useSummaryScope'
import { MERGED_BUY_HINT } from '../utils/annualized'
import { formatMoney, formatPercent } from '../utils/format'
import { pnlClass } from '../utils/pnl'

/** 年化收益率的已知失真（挂卡片 tooltip）：因果说明与持仓明细脚注共用 MERGED_BUY_HINT */
const ANNUALIZED_HINT = `年化收益率基于你填写的买入日期计算；${MERGED_BUY_HINT}，使年化收益率偏低。`

const SCOPE_LABEL: Record<SummaryScope, string> = {
  all: '全部基金',
  held: '在持基金'
}

/** 概览页与流水页共用的汇总卡片：两行版式 + 右上角口径分段控件。
 *  数字与着色全部取当前口径的 totals/annualized，切换不重新取数。 */
export default function SummaryCards({ summary }: { summary: SummaryData }): React.JSX.Element {
  const [scope, selectScope] = useSummaryScope()
  const { totals, annualized } = summary[scope]

  return (
    <div className="card summary-card">
      {/* 口径分段控件：始终渲染，原生 button 支持 Tab 聚焦与 Enter/Space 触发 */}
      <div className="scope-switch" role="group" aria-label="汇总统计口径">
        {(['all', 'held'] as const).map((value) => (
          <button
            key={value}
            type="button"
            className="scope-switch-btn"
            aria-pressed={scope === value}
            onClick={() => selectScope(value)}
          >
            {SCOPE_LABEL[value]}
          </button>
        ))}
      </div>

      {/* 第一行（结果）：总资产恒为正不着色，其余三张按正负着色 */}
      <div className="stat-row summary-row-primary">
        <div className="stat">
          <div className="stat-label">总资产</div>
          <div className="stat-value">{formatMoney(totals.totalAssets)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">总收益</div>
          <div className={`stat-value ${pnlClass(totals.totalReturn)}`}>
            {formatMoney(totals.totalReturn)}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">累计收益率</div>
          <div className={`stat-value ${pnlClass(totals.totalReturnRate)}`}>
            {formatPercent(totals.totalReturnRate)}
          </div>
        </div>
        <div className="stat" title={ANNUALIZED_HINT}>
          <div className="stat-label">
            年化收益率
            <span className="hint-mark">ⓘ</span>
          </div>
          <div className={`stat-value ${pnlClass(annualized)}`}>{formatPercent(annualized)}</div>
        </div>
      </div>

      {/* 第二行（分解）：把「持仓盈亏 + 已实现盈亏 = 总收益」写成看得见的等式 */}
      <div className="stat-row stat-row-parts">
        <div className="stat">
          <div className="stat-label">持仓盈亏</div>
          <div className={`stat-value ${pnlClass(totals.totalPnl)}`}>
            {formatMoney(totals.totalPnl)}
          </div>
        </div>
        <div className="stat-op">+</div>
        <div className="stat">
          <div className="stat-label">已实现盈亏</div>
          <div className={`stat-value ${pnlClass(totals.realizedIncome)}`}>
            {formatMoney(totals.realizedIncome)}
          </div>
        </div>
        <div className="stat-op">= 总收益</div>
      </div>
    </div>
  )
}
