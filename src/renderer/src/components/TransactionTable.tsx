import { useMemo } from 'react'
import type { Fund, OperationType, TransactionRow } from '../../../engine'
import { OPERATION_TYPES, realizedPerSale } from '../../../engine'
import { formatMoney, formatNav, formatShares } from '../utils/format'
import { pnlClass } from '../utils/pnl'

export interface TxFilter {
  fundCode: string // 'all' 或基金代码
  type: 'all' | OperationType
  from: string // 起（含），空为不限
  to: string // 止（含），空为不限
}

export interface TxSort {
  key: 'date' | 'amount'
  dir: 'asc' | 'desc'
}

const TYPE_CLASS: Record<OperationType, string> = {
  买入: 'tag-buy',
  卖出: 'tag-sell',
  分红现金: 'tag-cash',
  分红再投入: 'tag-reinvest'
}

interface TransactionTableProps {
  rows: TransactionRow[]
  funds: Fund[]
  filter: TxFilter
  onFilterChange: (filter: TxFilter) => void
  sort: TxSort
  onSortChange: (sort: TxSort) => void
  onEdit: (row: TransactionRow) => void
  onDelete: (row: TransactionRow) => void
}

export default function TransactionTable({
  rows,
  funds,
  filter,
  onFilterChange,
  sort,
  onSortChange,
  onEdit,
  onDelete
}: TransactionTableProps): React.JSX.Element {
  const fundNames = useMemo(() => new Map(funds.map((f) => [f.code, f.name])), [funds])
  // 按笔已实现收益：对全部流水计算（成本推进依赖历史，不能在筛选后的子集上算）
  const realizedBySale = useMemo(() => realizedPerSale(rows), [rows])

  const visible = useMemo(() => {
    const filtered = rows.filter(
      (t) =>
        (filter.fundCode === 'all' || t.fundCode === filter.fundCode) &&
        (filter.type === 'all' || t.type === filter.type) &&
        (filter.from === '' || t.date >= filter.from) &&
        (filter.to === '' || t.date <= filter.to)
    )
    const dir = sort.dir === 'asc' ? 1 : -1
    return filtered.sort((a, b) => {
      const primary =
        sort.key === 'date'
          ? a.date === b.date
            ? 0
            : a.date < b.date
              ? -1
              : 1
          : a.amount - b.amount
      return primary * dir !== 0 ? primary * dir : (a.id - b.id) * dir
    })
  }, [rows, filter, sort])

  const toggleSort = (key: TxSort['key']): void => {
    onSortChange(sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' })
  }

  const sortArrow = (key: TxSort['key']): string => (sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '')

  const resetFilter = (): void => onFilterChange({ fundCode: 'all', type: 'all', from: '', to: '' })

  return (
    <div>
      <div className="filter-bar">
        <select
          value={filter.fundCode}
          onChange={(e) => onFilterChange({ ...filter, fundCode: e.target.value })}
        >
          <option value="all">全部基金</option>
          {funds.map((f) => (
            <option key={f.code} value={f.code}>
              {f.code} {f.name}
            </option>
          ))}
        </select>
        <select
          value={filter.type}
          onChange={(e) => onFilterChange({ ...filter, type: e.target.value as TxFilter['type'] })}
        >
          <option value="all">全部类型</option>
          {OPERATION_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={filter.from}
          title="起始日期"
          onChange={(e) => onFilterChange({ ...filter, from: e.target.value })}
        />
        <span className="muted">至</span>
        <input
          type="date"
          value={filter.to}
          title="截止日期"
          onChange={(e) => onFilterChange({ ...filter, to: e.target.value })}
        />
        <button className="btn btn-small" onClick={resetFilter}>
          清除筛选
        </button>
        <span className="muted filter-count">共 {visible.length} 笔</span>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th className="sortable" onClick={() => toggleSort('date')}>
              日期{sortArrow('date')}
            </th>
            <th>操作类型</th>
            <th>基金</th>
            <th className="sortable" onClick={() => toggleSort('amount')}>
              金额（元）{sortArrow('amount')}
            </th>
            <th>本笔已实现</th>
            <th>份额</th>
            <th>净值</th>
            <th>手续费</th>
            <th>备注</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 && (
            <tr>
              <td colSpan={10} className="muted">
                无匹配流水
              </td>
            </tr>
          )}
          {visible.map((t) => {
            // 仅卖出行有值；非卖出行留空
            const realized = t.type === '卖出' ? realizedBySale.get(t.id) : undefined
            return (
              <tr key={t.id}>
                <td>{t.date}</td>
                <td>
                  <span className={`tag ${TYPE_CLASS[t.type]}`}>{t.type}</span>
                </td>
                <td>
                  {t.fundCode} {fundNames.get(t.fundCode) ?? ''}
                </td>
                <td>{formatMoney(t.amount)}</td>
                <td className={pnlClass(realized)}>
                  {realized === undefined ? '' : formatMoney(realized)}
                </td>
                <td>{t.shares === null ? '—' : formatShares(t.shares)}</td>
                <td>{formatNav(t.nav)}</td>
                <td>{formatMoney(t.fee)}</td>
                <td className="muted">{t.note ?? ''}</td>
                <td>
                  <button className="btn btn-small" onClick={() => onEdit(t)}>
                    编辑
                  </button>{' '}
                  <button className="btn btn-small btn-danger" onClick={() => onDelete(t)}>
                    删除
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
