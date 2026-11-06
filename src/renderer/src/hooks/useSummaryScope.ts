import { useCallback, useState } from 'react'
import type { SummaryScope } from '../../../engine'

/** 两页共用的口径持久化键（单一事实来源；切页重新挂载即读到最新值） */
const STORAGE_KEY = 'porti.summaryScope'

const DEFAULT_SCOPE: SummaryScope = 'held'

function isSummaryScope(value: string | null): value is SummaryScope {
  return value === 'all' || value === 'held'
}

function readScope(): SummaryScope {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return isSummaryScope(stored) ? stored : DEFAULT_SCOPE
  } catch {
    // localStorage 不可用（隐私模式等）：按缺省口径工作
    return DEFAULT_SCOPE
  }
}

/** 汇总卡片口径选择：初始化时读、切换时写。
 *  概览页与流水页一次只挂载一个页面，切页重新挂载即读到最新值，实现两页联动。 */
export function useSummaryScope(): [SummaryScope, (scope: SummaryScope) => void] {
  const [scope, setScope] = useState<SummaryScope>(readScope)
  const selectScope = useCallback((next: SummaryScope): void => {
    setScope(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // 写入失败仅本次会话生效，不阻塞界面
    }
  }, [])
  return [scope, selectScope]
}
