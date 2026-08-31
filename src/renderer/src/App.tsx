import { useState } from 'react'
import Overview from './pages/Overview'
import Transactions from './pages/Transactions'
import NavHistory from './pages/NavHistory'
import Stats from './pages/Stats'
import Settings from './pages/Settings'

const PAGES = [
  { key: 'overview', label: '概览', component: Overview },
  { key: 'transactions', label: '交易流水', component: Transactions },
  { key: 'nav', label: '净值管理', component: NavHistory },
  { key: 'stats', label: '收益统计', component: Stats },
  { key: 'settings', label: '设置', component: Settings }
] as const

export default function App(): React.JSX.Element {
  const [active, setActive] = useState<string>('overview')
  const ActivePage = PAGES.find((p) => p.key === active)!.component

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="app-title">Porti</div>
        <nav>
          {PAGES.map((p) => (
            <button
              key={p.key}
              className={active === p.key ? 'nav-item active' : 'nav-item'}
              onClick={() => setActive(p.key)}
            >
              {p.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="content">
        <ActivePage />
      </main>
    </div>
  )
}
