import { useEffect, useState } from 'react'
import {
  LayoutDashboard,
  ArrowLeftRight,
  Users,
  ChartNoAxesCombined,
  Megaphone,
  Settings,
  Bell,
  Search,
  Menu,
  X,
  Wallet,
  CreditCard,
  Banknote,
  ArrowUpRight,
  MoreHorizontal,
  Download,
  Plus,
  MapPin,
  Clock3,
  CircleCheck,
  CircleAlert,
  ChevronRight,
  ShieldCheck,
} from 'lucide-react'
import { auth } from './firebase'
import './App.css'

const navigation = [
  { label: 'Overview', icon: LayoutDashboard },
  { label: 'Transactions', icon: ArrowLeftRight },
  { label: 'Officers', icon: Users },
  { label: 'Reports', icon: ChartNoAxesCombined },
  { label: 'Broadcasts', icon: Megaphone },
  { label: 'Settings', icon: Settings },
]


function App() {
  const [activePage, setActivePage] = useState('Overview')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [globalSearch, setGlobalSearch] = useState('')

  const selectPage = (page) => {
    setActivePage(page)
    setSidebarOpen(false)
  }

  return (
    <div className="app-shell">
      {sidebarOpen && (
        <button
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
        <div className="brand">
          <div className="brand-mark">B</div>
          <div className="brand-copy">
            <strong>Bungoma Pay</strong>
            <span>Revenue Management</span>
          </div>
          <button
            className="icon-button sidebar-close"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close menu"
          >
            <X size={19} />
          </button>
        </div>

        <div className="workspace-label">WORKSPACE</div>

        <nav className="main-nav" aria-label="Main navigation">
          {navigation.map(({ label, icon: Icon }) => (
            <button
              key={label}
              className={`nav-item ${activePage === label ? 'nav-active' : ''}`}
              onClick={() => selectPage(label)}
            >
              <Icon size={19} strokeWidth={1.8} />
              <span>{label}</span>
              {label === 'Broadcasts' && <span className="nav-dot" />}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="security-card">
            <div className="security-icon"><ShieldCheck size={19} /></div>
            <strong>Secure workspace</strong>
            <p>Authorized access for revenue management.</p>
          </div>

          <button className="profile-button" type="button" onClick={() => selectPage('Settings')}>
            <div className="avatar admin-avatar">A</div>
            <div className="profile-info">
              <strong>Administrator</strong>
              <span>System admin</span>
            </div>
            <MoreHorizontal size={19} className="profile-more" />
          </button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="icon-button mobile-menu"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open navigation"
            >
              <Menu size={21} />
            </button>
            <div className="breadcrumb">
              <span>Workspace</span>
              <ChevronRight size={15} />
              <strong>{activePage}</strong>
            </div>
          </div>

          <div className="topbar-actions">
            <div className="search-box">
              <Search size={17} />
              <input
                type="search"
                placeholder="Search transactions..."
                aria-label="Search transactions"
                value={globalSearch}
                onChange={(event) => setGlobalSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') selectPage('Transactions')
                }}
              />
              <kbd>⌘ K</kbd>
            </div>
            <button className="icon-button notification-button" type="button" onClick={() => selectPage('Broadcasts')} aria-label="Open broadcasts" title="Open broadcasts">
              <Bell size={19} />
              <span />
            </button>
            <div className="topbar-divider" />
            <div className="topbar-user">
              <div className="avatar admin-avatar">A</div>
              <div>
                <strong>Admin</strong>
                <span>Administrator</span>
              </div>
            </div>
          </div>
        </header>

        <div className="page-content">
          {activePage === 'Overview' ? (
            <Dashboard onNavigate={selectPage} />
          ) : activePage === 'Transactions' ? (
            <TransactionsPage key={globalSearch} initialSearch={globalSearch} />
          ) : activePage === 'Reports' ? (
            <ReportsPage />
          ) : activePage === 'Broadcasts' ? (
            <BroadcastsPage />
          ) : activePage === 'Settings' ? (
            <SettingsPage />
          ) : activePage === 'Officers' ? (
            <OfficersPage />
          ) : (
            <SectionPlaceholder page={activePage} />
          )}

          <footer className="page-footer">
            <span>© 2026 Bungoma Pay</span>
            <span>Revenue Management Platform</span>
          </footer>
        </div>
      </main>
    </div>
  )
}

function formatKES(value) {
  return `KES ${Number(value || 0).toLocaleString('en-KE', {
    maximumFractionDigits: 2,
  })}`
}

function formatTransactionTime(createdAt) {
  if (!createdAt) return '—'

  const seconds = createdAt._seconds ?? createdAt.seconds
  const date = seconds
    ? new Date(seconds * 1000)
    : new Date(createdAt)

  if (Number.isNaN(date.getTime())) return '—'

  return date.toLocaleString('en-KE', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function PaymentStatusAudit({ summary, loading = false, error = false }) {
  const statuses = [
    { key: 'PAID', label: 'Paid', amountLabel: 'Collected amount' },
    { key: 'PENDING', label: 'Pending', amountLabel: 'Attempted amount' },
    { key: 'FAILED', label: 'Failed', amountLabel: 'Attempted amount' },
    { key: 'OTHER', label: 'Other statuses', amountLabel: 'Recorded amount' },
  ]

  return (
    <section className="panel payment-audit-panel">
      <div className="panel-heading">
        <div>
          <h2>Payment status audit</h2>
          <p>Transaction outcomes and payment attempt values</p>
        </div>
      </div>
      {loading ? (
        <div className="stream-empty">Loading payment status summary...</div>
      ) : error ? (
        <div className="stream-empty">Payment status summary unavailable.</div>
      ) : (
        <div className="payment-audit-grid">
          {statuses.map(({ key, label, amountLabel }) => {
            const item = summary?.[key] || {}
            return (
              <div className={`payment-audit-item audit-${key.toLowerCase()}`} key={key}>
                <span className="payment-audit-label">{label}</span>
                <strong>{Number(item.transactions || 0).toLocaleString('en-KE')}</strong>
                <span className="payment-audit-amount">{amountLabel}</span>
                <strong className="payment-audit-total">
                  {formatKES(item.attemptedAmount)}
                </strong>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function Dashboard({ onNavigate }) {
  const [stats, setStats] = useState(null)
  const [transactions, setTransactions] = useState([])
  const [dataLoading, setDataLoading] = useState(true)
  const [dataError, setDataError] = useState('')
  const [revenueTrend, setRevenueTrend] = useState([])
  const [trendLoading, setTrendLoading] = useState(true)
  const [trendError, setTrendError] = useState('')
  const [officerActivity, setOfficerActivity] = useState([])
  const [officerActivityLoading, setOfficerActivityLoading] = useState(true)
  const [officerActivityError, setOfficerActivityError] = useState('')
  function exportDashboardTransactions() {
    if (!transactions.length) return

    const columns = [
      'Receipt', 'Officer', 'Revenue stream', 'Ward',
      'Payment method', 'Amount', 'Status', 'Date',
    ]

    const rows = transactions.map((item) => [
      item.receipt,
      item.officerUsername,
      item.revenueType,
      item.wardName || item.ward,
      item.paymentMethod,
      item.amount,
      item.status,
      formatTransactionTime(item.createdAt),
    ])

    const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`
    const csv = [columns, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `bungoma-pay-transactions-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  const totalRevenue = Number(stats?.totalRevenue) || 0
  const mpesaTotal = Number(stats?.mpesaTotal) || 0
  const cashTotal = Number(stats?.cashTotal) || 0

  const revenueEntries = Object.entries(stats?.revenueBreakdown || {})
    .sort((a, b) => Number(b[1]?.total || 0) - Number(a[1]?.total || 0))


  const channelTotal = mpesaTotal + cashTotal

  const mpesaPercent = channelTotal > 0
    ? Math.round((mpesaTotal / channelTotal) * 100)
    : 0

  const cashPercent = channelTotal > 0 ? 100 - mpesaPercent : 0

  const channelChartBackground = totalRevenue > 0
    ? `conic-gradient(#2878e8 0 ${mpesaPercent}%, #9b82e9 ${mpesaPercent}% 100%)`
    : 'conic-gradient(#e5e7eb 0 100%)'

  const trendTotal = revenueTrend.reduce(
    (sum, day) => sum + (Number(day.total) || 0), 0
  )
  const trendMax = Math.max(...revenueTrend.map(day => Number(day.total) || 0), 0)
  const trendMagnitude = trendMax > 0 ? 10 ** Math.floor(Math.log10(trendMax)) : 1
  const chartScaleMax = trendMax > 0
    ? Math.ceil(trendMax / trendMagnitude) * trendMagnitude : 1
  const chartTicks = [chartScaleMax, chartScaleMax * 2 / 3, chartScaleMax / 3, 0]
  const chartPoints = revenueTrend.map((day, index) => ({
    x: revenueTrend.length > 1 ? index / (revenueTrend.length - 1) * 700 : 350,
    y: 190 - (Number(day.total || 0) / chartScaleMax) * 160,
  }))
  const chartLinePath = chartPoints
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`)
    .join(' ')
  const chartAreaPath = chartLinePath ? `${chartLinePath} L700 210 L0 210 Z` : ''
  const formatCompactKES = value => {
    const amount = Number(value) || 0
    if (amount >= 1000000) return `${(amount / 1000000).toFixed(1)}m`
    if (amount >= 1000) return `${(amount / 1000).toFixed(1)}k`
    return `${Math.round(amount)}`
  }

  useEffect(() => {
    let active = true

    async function loadDashboard() {
      try {
        const user = auth.currentUser
        if (!user) throw new Error('Your session is unavailable. Please sign in again.')

        const token = await user.getIdToken()
        const headers = { Authorization: `Bearer ${token}` }

        const [statsResponse, transactionsResponse] = await Promise.all([
          fetch('/api/admin/stats', { headers }),
          fetch('/api/transactions', { headers }),
        ])

        const [statsResult, transactionsResult] = await Promise.all([
          statsResponse.json(),
          transactionsResponse.json(),
        ])

        if (!statsResponse.ok || !statsResult.success) {
          throw new Error(statsResult.message || 'Could not load revenue statistics.')
        }

        if (!transactionsResponse.ok || !Array.isArray(transactionsResult)) {
          throw new Error(transactionsResult.message || 'Could not load transactions.')
        }

        if (active) {
          setStats(statsResult)
          setTransactions(transactionsResult)
          setDataError('')
        }
      } catch (error) {
        if (active) setDataError(error.message || 'Unable to load dashboard data.')
      } finally {
        if (active) setDataLoading(false)
      }
    }

    loadDashboard()
    return () => { active = false }
  }, [])


  useEffect(() => {
    let active = true

    async function loadRevenueTrend() {
      try {
        const user = auth.currentUser
        if (!user) throw new Error('Your session is unavailable.')

        const token = await user.getIdToken()
        const response = await fetch('/api/admin/revenue-trend', {
          headers: { Authorization: `Bearer ${token}` },
        })
        const result = await response.json()

        if (!response.ok || !result.success || !Array.isArray(result.days)) {
          throw new Error(result.message || 'Could not load the seven-day revenue trend.')
        }

        if (active) {
          setRevenueTrend(result.days)
          setTrendError('')
        }
      } catch (error) {
        if (active) setTrendError(error.message || 'Unable to load revenue trend.')
      } finally {
        if (active) setTrendLoading(false)
      }
    }

    loadRevenueTrend()
    return () => { active = false }
  }, [])

  useEffect(() => {
    let active = true

    async function loadOfficerActivity() {
      try {
        const user = auth.currentUser
        if (!user) throw new Error('Your session is unavailable.')

        const token = await user.getIdToken()
        const response = await fetch('/api/admin/officer-activity', {
          headers: { Authorization: `Bearer ${token}` },
        })
        const result = await response.json()

        if (!response.ok || !result.success || !Array.isArray(result.officers)) {
          throw new Error(result.message || "Could not load today's officer activity.")
        }

        if (active) {
          setOfficerActivity(result.officers)
          setOfficerActivityError('')
        }
      } catch (error) {
        if (active) {
          setOfficerActivityError(error.message || 'Unable to load officer activity.')
        }
      } finally {
        if (active) setOfficerActivityLoading(false)
      }
    }

    loadOfficerActivity()
    return () => { active = false }
  }, [])

  return (
    <>
      <section className="page-heading">
        <div>
          <div className="eyebrow"><span className="live-dot" /> ADMIN WORKSPACE</div>
          <h1>Overview</h1>
          <p>Monitor revenue collection and field operations.</p>
        </div>
        <div className="heading-actions">
          <button
            className="button button-secondary"
            onClick={exportDashboardTransactions}
            disabled={dataLoading || dataError || transactions.length === 0}
            title={transactions.length ? 'Download loaded transactions as CSV' : 'No transactions available to export'}
          >
            <Download size={16} /> Export
          </button>
          <button className="button button-primary" onClick={() => onNavigate('Officers')}>
            <Plus size={17} /> Add officer
          </button>
        </div>
      </section>

      <div className="prototype-notice" role="status">
        {dataLoading ? (
          <span>Loading live revenue data...</span>
        ) : dataError ? (
          <><CircleAlert size={17} /><span><strong>Dashboard data unavailable:</strong> {dataError}</span></>
        ) : (
          <><CircleCheck size={17} /><span><strong>Live data:</strong> Paid transaction totals from the Bungoma Pay backend.</span></>
        )}
      </div>

      <section className="stats-grid">
        <StatCard
          label="Total revenue"
          value={dataLoading ? "Loading..." : dataError ? "Unavailable" : formatKES(stats?.totalRevenue)}
          change="All time"
          description="Backend total"
          icon={Wallet}
          tone="blue"
          positive
        />
        <StatCard
          label="Transactions"
          value={dataLoading ? "Loading..." : dataError ? "Unavailable" : Number(stats?.totalTransactions || 0).toLocaleString("en-KE")}
          change="Paid only"
          description="Backend total"
          icon={ArrowLeftRight}
          tone="purple"
          positive
        />
        <StatCard
          label="M-PESA collections"
          value={dataLoading ? "Loading..." : dataError ? "Unavailable" : formatKES(stats?.mpesaTotal)}
          change="M-PESA"
          description="Backend total"
          icon={CreditCard}
          tone="green"
          positive
        />
        <StatCard
          label="Cash collections"
          value={dataLoading ? "Loading..." : dataError ? "Unavailable" : formatKES(stats?.cashTotal)}
          change="Cash"
          description="Backend total"
          icon={Banknote}
          tone="orange"
        />
      </section>

      <section className="dashboard-grid">
        <div className="panel revenue-panel">
          <div className="panel-heading">
            <div>
              <h2>Revenue overview</h2>
              <p>Collection performance over time</p>
            </div>
            <span className="select-button" aria-label="Revenue chart period: last 7 days">Last 7 days</span>
          </div>

          <div className="chart-summary">
            <div>
              <span>Collected in the last 7 days</span>
              <strong>{trendLoading ? 'Loading...' : trendError ? 'Unavailable' : formatKES(trendTotal)}</strong>
            </div>
            <div className="chart-growth">{trendLoading ? 'Loading' : trendError ? 'Unavailable' : 'Paid collections'}</div>
          </div>

          {trendLoading ? (
            <div className="chart-empty" role="status">Loading seven-day revenue...</div>
          ) : trendError ? (
            <div className="chart-empty" role="status">Unable to load the revenue trend.</div>
          ) : trendTotal <= 0 ? (
            <div className="chart-empty" role="status">
              No paid collections in the last 7 days
            </div>
          ) : (
            <div className="chart">
            <div className="chart-y-labels">
              {chartTicks.map((tick, index) => <span key={index}>{formatCompactKES(tick)}</span>)}
            </div>
            <div className="chart-plot">
              <div className="chart-grid-lines">
                <i /><i /><i /><i />
              </div>
              <svg viewBox="0 0 700 210" preserveAspectRatio="none" role="img" aria-label="Seven-day paid revenue trend">
                <defs>
                  <linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="#2684e8" stopOpacity=".22" />
                    <stop offset="100%" stopColor="#2684e8" stopOpacity="0" />
                  </linearGradient>
                </defs>
                {chartAreaPath && <path d={chartAreaPath} fill="url(#chartFill)" />}
                {chartLinePath && <path d={chartLinePath} fill="none" stroke="#2684e8" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />}
                {chartPoints.length > 0 && (
                  <circle
                    cx={chartPoints[chartPoints.length - 1].x}
                    cy={chartPoints[chartPoints.length - 1].y}
                    r="5" fill="#fff" stroke="#2684e8" strokeWidth="3"
                  />
                )}
              </svg>
              <div className="chart-x-labels">
                {revenueTrend.map((day, index) => <span key={day.date || index}>{day.label}</span>)}
              </div>
            </div>
          </div>
          )}
          <div className="chart-legend"><span /> Daily paid collections <span className="legend-note">{trendLoading ? 'Loading data' : trendError ? 'Trend unavailable' : 'Last 7 days'}</span></div>
        </div>

        <div className="panel collection-panel">
          <div className="panel-heading">
            <div>
              <h2>Collection channels</h2>
              <p>Revenue by payment method</p>
            </div>
            <span className="icon-button" aria-hidden="true"><MoreHorizontal size={20} /></span>
          </div>

          <div className="donut-wrap">
            <div className="donut-chart" style={{ background: channelChartBackground }}>
              <div className="donut-center">
                <strong>
                  {dataLoading ? 'Loading...' : dataError ? 'Unavailable' : formatKES(totalRevenue)}
                </strong>
                <span>Total KES</span>
              </div>
            </div>
          </div>

          <div className="channel-list">
            <div>
              <span className="channel-name"><i className="channel-blue" /> M-PESA</span>
              <strong>{dataLoading ? '...' : dataError ? '—' : `${mpesaPercent}%`}</strong>
            </div>
            <div>
              <span className="channel-name"><i className="channel-purple" /> Cash</span>
              <strong>{dataLoading ? '...' : dataError ? '—' : `${cashPercent}%`}</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="panel stream-breakdown-panel">
        <div className="panel-heading">
          <div>
            <h2>Revenue streams</h2>
            <p>Paid collections by stream and specific charge</p>
          </div>
          <span className="stream-paid-label">PAID ONLY</span>
        </div>
        {dataLoading ? (
          <div className="stream-empty">Loading revenue breakdown...</div>
        ) : dataError ? (
          <div className="stream-empty">Revenue breakdown unavailable.</div>
        ) : revenueEntries.length === 0 ? (
          <div className="stream-empty">No paid revenue has been classified yet.</div>
        ) : (
          <div className="stream-list">
            {revenueEntries.map(([stream, details]) => (
              <div className="stream-item" key={stream}>
                <div className="stream-main">
                  <div>
                    <strong>{stream}</strong>
                    <span>{Number(details.transactions || 0).toLocaleString('en-KE')} paid transactions</span>
                  </div>
                  <strong className="stream-total">{formatKES(details.total)}</strong>
                </div>
                <div className="stream-subtypes">
                  {Object.entries(details.subTypes || {})
                    .sort((a, b) => Number(b[1]?.total || 0) - Number(a[1]?.total || 0))
                    .map(([subType, values]) => (
                      <div className="stream-subtype" key={subType}>
                        <span>{subType}</span>
                        <span>{Number(values.transactions || 0).toLocaleString('en-KE')} · {formatKES(values.total)}</span>
                      </div>
                    ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <PaymentStatusAudit
        summary={stats?.statusSummary}
        loading={dataLoading}
        error={Boolean(dataError)}
      />

      <section className="panel transactions-panel">
        <div className="panel-heading transactions-heading">
          <div>
            <h2>Recent transactions</h2>
            <p>Latest revenue collection activity</p>
          </div>
          <button className="text-button" onClick={() => onNavigate("Transactions")}>View all <ArrowUpRight size={15} /></button>
        </div>

        <div className="table-scroll">
          <table className="transactions-table">
            <thead>
              <tr>
                <th>Receipt number</th>
                <th>Officer</th>
                <th>Revenue stream</th>
                <th>Payment</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((transaction) => {
                const paid = String(transaction.status || '').toUpperCase() === 'PAID'
                const method = String(transaction.paymentMethod || 'Unknown').toUpperCase()

                return (
                  <tr key={transaction.id || transaction.receipt}>
                    <td className="receipt-cell">{transaction.receipt || '—'}</td>
                    <td>{transaction.officerUsername || '—'}</td>
                    <td>{transaction.revenueType || '—'}</td>
                    <td>
                      <span className={`payment-method ${method === 'CASH' ? 'cash-method' : ''}`}>
                        {method}
                      </span>
                    </td>
                    <td className="amount-cell">{formatKES(transaction.amount)}</td>
                    <td>
                      <span className={`status-pill ${paid ? 'status-paid' : 'status-pending'}`}>
                        {paid ? <CircleCheck size={13} /> : <Clock3 size={13} />}
                        {transaction.status || 'Unknown'}
                      </span>
                    </td>
                    <td className="time-cell">{formatTransactionTime(transaction.createdAt)}</td>
                  </tr>
                )
              })}
              {!dataLoading && !dataError && transactions.length === 0 && (
                <tr><td colSpan="7">No transactions found.</td></tr>
              )}
              {dataLoading && (
                <tr><td colSpan="7">Loading transactions...</td></tr>
              )}
              {dataError && (
                <tr><td colSpan="7">Transactions could not be loaded.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="table-footer">
          <span>{dataLoading ? "Loading..." : dataError ? "Data unavailable" : `Showing ${transactions.length} latest transactions`}</span>
          <button className="text-button" onClick={() => onNavigate("Transactions")}>All transactions <ArrowUpRight size={15} /></button>
        </div>
      </section>

      <section className="bottom-grid">
        <div className="panel activity-panel">
          <div className="panel-heading">
            <div><h2>Field activity</h2><p>Today's paid collections by officer</p></div>
            <button className="text-button" onClick={() => onNavigate('Officers')}>
              View officers <ChevronRight size={15} />
            </button>
          </div>

          {officerActivityLoading ? (
            <div className="activity-empty" role="status">Loading officer activity...</div>
          ) : officerActivityError ? (
            <div className="activity-empty" role="status">
              Unable to load officer activity.
            </div>
          ) : officerActivity.length === 0 ? (
            <div className="activity-empty" role="status">
              No officer accounts found.
            </div>
          ) : (
            officerActivity.map((officer, index) => {
              const initials = String(officer.username || 'Officer')
                .trim()
                .split(/\s+/)
                .slice(0, 2)
                .map(part => part[0])
                .join('')
                .toUpperCase()

              const avatarClasses = ['avatar-blue', 'avatar-purple', 'avatar-orange']

              return (
                <div className="activity-row" key={officer.uid}>
                  <div className={`avatar ${avatarClasses[index % avatarClasses.length]}`}>
                    {initials}
                  </div>
                  <div className="activity-person">
                    <strong>{officer.username}</strong>
                    <span><MapPin size={12} /> {officer.wardName || officer.ward}</span>
                  </div>
                  <div className="activity-value">
                    <strong>{formatKES(officer.total)}</strong>
                    <span>
                      {officer.transactions} paid {officer.transactions === 1 ? 'transaction' : 'transactions'}
                    </span>
                  </div>
                </div>
              )
            })
          )}
        </div>

        <div className="panel quick-panel">
          <div className="panel-heading"><div><h2>Quick actions</h2><p>Common administration tasks</p></div></div>
          <button className="quick-action" onClick={() => onNavigate('Officers')}><span className="quick-icon quick-blue"><Plus size={17} /></span><span><strong>Add officer</strong><small>Create an officer account</small></span><ChevronRight size={17} /></button>
          <button className="quick-action" onClick={() => onNavigate('Reports')}><span className="quick-icon quick-purple"><ChartNoAxesCombined size={17} /></span><span><strong>Generate report</strong><small>Review collection performance</small></span><ChevronRight size={17} /></button>
          <button className="quick-action" onClick={() => onNavigate('Broadcasts')}><span className="quick-icon quick-orange"><Megaphone size={17} /></span><span><strong>Send broadcast</strong><small>Message field officers</small></span><ChevronRight size={17} /></button>
        </div>
      </section>
    </>
  )
}

function StatCard({ label, value, change, description, icon: Icon, tone }) {
  return (
    <article className="stat-card">
      <div className="stat-top">
        <span>{label}</span>
        <div className={`stat-icon ${tone}`}><Icon size={19} /></div>
      </div>
      <strong className="stat-value">{value}</strong>
      <div className="stat-bottom">
        <span className="stat-change">{change}</span>
        <span>{description}</span>
      </div>
    </article>
  )
}


function formatOfficerLastSeen(value) {
  if (!value) return 'Not recorded'

  const seconds = value._seconds ?? value.seconds
  const date = seconds
    ? new Date(seconds * 1000)
    : new Date(value)

  if (Number.isNaN(date.getTime())) return 'Not recorded'

  return date.toLocaleString('en-KE', {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function OfficersPage() {
  const [officers, setOfficers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  const [showCreateForm, setShowCreateForm] = useState(false)
  const [locations, setLocations] = useState([])
  const [locationsLoading, setLocationsLoading] = useState(true)
  const [locationsError, setLocationsError] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [createSuccess, setCreateSuccess] = useState('')
  const [officerForm, setOfficerForm] = useState({
    username: '', email: '', password: '', constituencyId: '', wardId: '',
  })

  useEffect(() => {
    let active = true
    async function loadLocations() {
      try {
        const user = auth.currentUser
        if (!user) throw new Error('Administrator session unavailable.')
        const token = await user.getIdToken()
        const response = await fetch('/api/locations', {
          headers: { Authorization: `Bearer ${token}` },
        })
        const result = await response.json()
        if (!response.ok || !result.success || !Array.isArray(result.constituencies)) {
          throw new Error(result.message || result.error || 'Could not load county locations.')
        }
        if (active) setLocations(result.constituencies)
      } catch (err) {
        if (active) setLocationsError(err.message || 'Could not load county locations.')
      } finally {
        if (active) setLocationsLoading(false)
      }
    }
    loadLocations()
    return () => { active = false }
  }, [])

  const selectedConstituency = locations.find(
    (item) => item.id === officerForm.constituencyId
  )
  const availableWards = selectedConstituency?.wards || []

  function updateOfficerField(event) {
    const { name, value } = event.target
    setOfficerForm((current) => ({
      ...current,
      [name]: value,
      ...(name === 'constituencyId' ? { wardId: '' } : {}),
    }))
    setCreateError('')
    setCreateSuccess('')
  }

  async function createOfficer(event) {
    event.preventDefault()
    setCreateError('')
    setCreateSuccess('')

    if (!officerForm.username.trim() || !officerForm.email.trim()) {
      setCreateError('Enter the officer username and email address.')
      return
    }
    if (officerForm.password.length < 6) {
      setCreateError('The password must contain at least 6 characters.')
      return
    }
    if (!selectedConstituency || !officerForm.wardId) {
      setCreateError('Select a constituency and a ward.')
      return
    }

    setCreating(true)
    try {
      const user = auth.currentUser
      if (!user) throw new Error('Administrator session unavailable.')
      const token = await user.getIdToken()
      const response = await fetch('/api/create-officer', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: officerForm.username.trim(),
          email: officerForm.email.trim(),
          password: officerForm.password,
          constituencyId: officerForm.constituencyId,
          wardId: officerForm.wardId,
        }),
      })
      const result = await response.json()

      if (!response.ok || !result.success) {
        if (result.accountCreated) {
          throw new Error(result.message || 'The login account was created, but its officer profile was not saved. Contact an administrator before retrying.')
        }
        throw new Error(result.message || result.error || 'Could not create the officer account.')
      }

      setCreateSuccess(result.message || 'Officer account created successfully.')
      setOfficerForm({
        username: '', email: '', password: '', constituencyId: '', wardId: '',
      })
      setShowCreateForm(false)
      setReloadKey((value) => value + 1)
    } catch (err) {
      setCreateError(err.message || 'Unable to create the officer account.')
    } finally {
      setCreating(false)
    }
  }


  useEffect(() => {
    let active = true

    async function loadOfficers() {
      setLoading(true)
      setError('')

      try {
        const user = auth.currentUser
        if (!user) throw new Error('Your administrator session is unavailable.')

        const token = await user.getIdToken()
        const response = await fetch('/api/officers', {
          headers: { Authorization: `Bearer ${token}` },
        })
        const result = await response.json()

        if (!response.ok || !result.success || !Array.isArray(result.officers)) {
          throw new Error(result.message || result.error || 'Could not load officer accounts.')
        }

        if (active) setOfficers(result.officers)
      } catch (err) {
        if (active) setError(err.message || 'Unable to load officer accounts.')
      } finally {
        if (active) setLoading(false)
      }
    }

    loadOfficers()
    return () => { active = false }
  }, [reloadKey])

  const filteredOfficers = officers.filter((officer) => {
    const term = search.trim().toLowerCase()
    if (!term) return true

    return [
      officer.username,
      officer.name,
      officer.email,
      officer.wardName || officer.ward,
      officer.status,
    ].some((value) => String(value || '').toLowerCase().includes(term))
  })

  return (
    <section className="officers-page">
      <div className="officers-heading">
        <div>
          <div className="eyebrow">ADMIN WORKSPACE</div>
          <h1>Officers</h1>
          <p>View registered field officers and their account activity.</p>
        </div>
        <div className="officers-heading-actions">
          <button
            className="officers-add"
            onClick={() => {
              setShowCreateForm((value) => !value)
              setCreateError('')
              setCreateSuccess('')
            }}
          >
            <Plus size={15} />
            {showCreateForm ? 'Close form' : 'Add officer'}
          </button>
          <button
            className="officers-refresh"
            onClick={() => setReloadKey((value) => value + 1)}
            disabled={loading}
          >
            <Clock3 size={15} />
            Refresh
          </button>
        </div>
      </div>

      {createSuccess && (
        <div className="officer-form-feedback officer-form-success" role="status">
          <CircleCheck size={17} /><span>{createSuccess}</span>
        </div>
      )}

      {showCreateForm && (
        <form className="officer-create-form" onSubmit={createOfficer}>
          <div className="officer-form-heading">
            <h2>Create officer account</h2>
            <p>Set the officer's login details and field location.</p>
          </div>

          {createError && (
            <div className="officer-form-feedback officer-form-error" role="alert">
              <CircleAlert size={17} /><span>{createError}</span>
            </div>
          )}
          {locationsError && (
            <div className="officer-form-feedback officer-form-error" role="alert">
              <CircleAlert size={17} /><span>{locationsError}</span>
            </div>
          )}

          <div className="officer-form-grid">
            <label><span>Username</span>
              <input name="username" value={officerForm.username}
                onChange={updateOfficerField} placeholder="Officer name"
                autoComplete="name" required />
            </label>
            <label><span>Email address</span>
              <input name="email" type="email" value={officerForm.email}
                onChange={updateOfficerField} placeholder="officer@example.com"
                autoComplete="email" required />
            </label>
            <label><span>Temporary password</span>
              <input name="password" type="password" value={officerForm.password}
                onChange={updateOfficerField} placeholder="At least 6 characters"
                autoComplete="new-password" minLength={6} required />
            </label>
            <label><span>Constituency</span>
              <select name="constituencyId" value={officerForm.constituencyId}
                onChange={updateOfficerField}
                disabled={locationsLoading || locations.length === 0} required>
                <option value="">{locationsLoading ? 'Loading...' : 'Select constituency'}</option>
                {locations.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </label>
            <label><span>Ward</span>
              <select name="wardId" value={officerForm.wardId}
                onChange={updateOfficerField}
                disabled={!officerForm.constituencyId || availableWards.length === 0}
                required>
                <option value="">Select ward</option>
                {availableWards.map((ward) => (
                  <option key={ward.id} value={ward.id}>{ward.name}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="officer-form-actions">
            <button type="button" className="officer-form-cancel"
              onClick={() => { setShowCreateForm(false); setCreateError('') }}
              disabled={creating}>Cancel</button>
            <button type="submit" className="officers-add"
              disabled={creating || locationsLoading || Boolean(locationsError)}>
              <Plus size={15} />
              {creating ? 'Creating account...' : 'Create officer'}
            </button>
          </div>
        </form>
      )}

      <div className="officers-summary">
        <div>
          <span>Registered officers</span>
          <strong>{loading ? '—' : officers.length}</strong>
        </div>
        <div>
          <span>Online status</span>
          <strong>
            {loading ? '—' : officers.filter(
              (officer) => String(officer.status || '').toLowerCase() === 'online'
            ).length}
          </strong>
        </div>
      </div>

      <div className="officers-toolbar">
        <div>
          <h2>Officer directory</h2>
          <p>Account details and latest recorded presence.</p>
        </div>
        <label className="officers-search">
          <Search size={16} />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search officers..."
            aria-label="Search officers"
          />
        </label>
      </div>

      {loading ? (
        <div className="officers-message" role="status">Loading officer accounts...</div>
      ) : error ? (
        <div className="officers-message officers-error" role="alert">
          <CircleAlert size={17} />
          <span>{error}</span>
          <button onClick={() => setReloadKey((value) => value + 1)}>Try again</button>
        </div>
      ) : filteredOfficers.length === 0 ? (
        <div className="officers-message">
          {officers.length === 0
            ? 'No officer accounts were returned by the backend.'
            : 'No officers match your search.'}
        </div>
      ) : (
        <div className="officers-table-wrap">
          <table className="officers-table">
            <thead>
              <tr>
                <th>Officer</th>
                <th>Ward</th>
                <th>Account status</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {filteredOfficers.map((officer) => {
                const name = officer.username || officer.name || 'Unnamed officer'
                const status = String(officer.status || '').toLowerCase()
                const initials = name.trim().split(/\s+/).slice(0, 2)
                  .map((part) => part[0]).join('').toUpperCase()

                return (
                  <tr key={officer.uid}>
                    <td>
                      <div className="officer-identity">
                        <div className="officer-avatar">{initials || 'O'}</div>
                        <div>
                          <strong>{name}</strong>
                          <span>{officer.email || 'No email recorded'}</span>
                        </div>
                      </div>
                    </td>
                    <td>{officer.wardName || officer.ward || 'Unassigned'}</td>
                    <td>
                      <span className={`officer-status ${status === 'online' ? 'is-online' : status === 'offline' ? 'is-offline' : 'is-unknown'}`}>
                        <span />
                        {status === 'online' ? 'Online' : status === 'offline' ? 'Offline' : 'Unknown'}
                      </span>
                    </td>
                    <td>{formatOfficerLastSeen(officer.lastSeen)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="officers-footer">
        Showing {loading ? '—' : filteredOfficers.length} of {loading ? '—' : officers.length} officers
      </div>
    </section>
  )
}


function TransactionsPage({ initialSearch = "" }) {
  const [transactions, setTransactions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState(initialSearch)
  const [methodFilter, setMethodFilter] = useState('ALL')
  const [statusFilter, setStatusFilter] = useState('ALL')
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let active = true

    async function loadTransactions() {
      setLoading(true)
      setError('')

      try {
        const user = auth.currentUser
        if (!user) throw new Error('Your administrator session is unavailable.')

        const token = await user.getIdToken()
        const response = await fetch('/api/transactions', {
          headers: { Authorization: `Bearer ${token}` },
        })
        const result = await response.json()

        if (!response.ok || !Array.isArray(result)) {
          throw new Error(result.error || 'Could not load transactions.')
        }

        if (active) setTransactions(result)
      } catch (err) {
        if (active) setError(err.message || 'Unable to load transactions.')
      } finally {
        if (active) setLoading(false)
      }
    }

    loadTransactions()
    return () => { active = false }
  }, [reloadKey])

  const statuses = [...new Set(
    transactions.map((item) => String(item.status || 'Unknown').toUpperCase())
  )].sort()

  const filteredTransactions = transactions.filter((item) => {
    const term = search.trim().toLowerCase()
    const matchesSearch = !term || [
      item.receipt,
      item.plate,
      item.id,
      item.checkoutRequestId,
      item.merchantRequestId,
      item.officerUsername,
      item.revenueType,
      item.revenueSubType,
      item.paymentMethod,
    ].some((value) => String(value || '').toLowerCase().includes(term))

    const method = String(item.paymentMethod || 'Unknown').toUpperCase()
    const status = String(item.status || 'Unknown').toUpperCase()

    return matchesSearch &&
      (methodFilter === 'ALL' || method === methodFilter) &&
      (statusFilter === 'ALL' || status === statusFilter)
  })

  const paidTransactions = transactions.filter(
    (item) => String(item.status || '').toUpperCase() === 'PAID'
  )
  const paidTotal = paidTransactions.reduce(
    (sum, item) => sum + (Number(item.amount) || 0), 0
  )

  return (
    <section className="transactions-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">ADMIN WORKSPACE</div>
          <h1>Transactions</h1>
          <p>Review revenue collections and payment records.</p>
        </div>
        <button
          className="officers-refresh"
          onClick={() => setReloadKey((value) => value + 1)}
          disabled={loading}
        >
          <Clock3 size={15} />
          Refresh
        </button>
      </div>

      <div className="stats-grid transaction-stats">
        <div className="stat-card">
          <div className="stat-top">Total records</div>
          <div className="stat-value">{loading ? '—' : transactions.length}</div>
          <div className="stat-bottom">Transactions returned by the API</div>
        </div>
        <div className="stat-card">
          <div className="stat-top">Successful payments</div>
          <div className="stat-value">{loading ? '—' : paidTransactions.length}</div>
          <div className="stat-bottom">Records marked as paid</div>
        </div>
        <div className="stat-card">
          <div className="stat-top">Paid collection value</div>
          <div className="stat-value">{loading ? '—' : formatKES(paidTotal)}</div>
          <div className="stat-bottom">Paid transactions only</div>
        </div>
      </div>

      <section className="panel transaction-list-panel">
        <div className="panel-heading">
          <div>
            <h2>All transactions</h2>
            <p>Search and filter the latest available records.</p>
          </div>
        </div>

        <div className="transaction-filters">
          <label className="officers-search">
            <Search size={16} />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search receipt, officer or revenue..."
              aria-label="Search transactions"
            />
          </label>

          <select
            className="select-button"
            value={methodFilter}
            onChange={(event) => setMethodFilter(event.target.value)}
            aria-label="Filter by payment method"
          >
            <option value="ALL">All payment methods</option>
            <option value="M-PESA">M-PESA</option>
            <option value="CASH">Cash</option>
          </select>

          <select
            className="select-button"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            aria-label="Filter by transaction status"
          >
            <option value="ALL">All statuses</option>
            {statuses.map((status) => (
              <option key={status} value={status}>{status}</option>
            ))}
          </select>
        </div>

        {loading ? (
          <div className="officers-message" role="status">Loading transactions...</div>
        ) : error ? (
          <div className="officers-message officers-error" role="alert">
            <CircleAlert size={17} />
            <span>{error}</span>
            <button onClick={() => setReloadKey((value) => value + 1)}>Try again</button>
          </div>
        ) : filteredTransactions.length === 0 ? (
          <div className="officers-message">
            {transactions.length === 0
              ? 'No transaction records were returned by the backend.'
              : 'No transactions match your search or filters.'}
          </div>
        ) : (
          <div className="table-scroll">
            <table className="transactions-table">
              <thead>
                <tr>
                  <th>Receipt number</th>
                  <th>Officer</th>
                  <th>Revenue stream</th>
                  <th>Payment</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {filteredTransactions.map((transaction) => {
                  const paid = String(transaction.status || '').toUpperCase() === 'PAID'
                  const method = String(transaction.paymentMethod || 'Unknown').toUpperCase()

                  return (
                    <tr key={transaction.id || transaction.receipt}>
                      <td className="receipt-cell">{transaction.receipt || '—'}</td>
                      <td>{transaction.officerUsername || '—'}</td>
                      <td>{transaction.revenueType || '—'}</td>
                      <td>
                        <span className={`payment-method ${method === 'CASH' ? 'cash-method' : ''}`}>
                          {method}
                        </span>
                      </td>
                      <td className="amount-cell">{formatKES(transaction.amount)}</td>
                      <td>
                        <span className={`transaction-status ${paid ? 'status-paid' : 'status-pending'}`}>
                          {paid ? <CircleCheck size={13} /> : <Clock3 size={13} />}
                          {transaction.status || 'Unknown'}
                        </span>
                      </td>
                      <td className="time-cell">{formatTransactionTime(transaction.createdAt)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="officers-footer">
          Showing {loading ? '—' : filteredTransactions.length} of {loading ? '—' : transactions.length} transactions
        </div>
      </section>
    </section>
  )
}




function BroadcastsPage() {
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [officers, setOfficers] = useState([])
  const [targetLoading, setTargetLoading] = useState(true)
  const [targetError, setTargetError] = useState('')
  const [locations, setLocations] = useState([])
  const [locationLoading, setLocationLoading] = useState(true)
  const [locationError, setLocationError] = useState('')
  const [targetScope, setTargetScope] = useState('all')
  const [targetConstituencyId, setTargetConstituencyId] = useState('')
  const [targetWardId, setTargetWardId] = useState('')
  const [targetOfficerUid, setTargetOfficerUid] = useState('')

  useEffect(() => {
    let active = true

    async function loadOfficers() {
      try {
        const user = auth.currentUser
        if (!user) throw new Error('Administrator session unavailable.')

        const token = await user.getIdToken()
        const response = await fetch('/api/officers', {
          headers: { Authorization: `Bearer ${token}` },
        })
        const result = await response.json()

        if (!response.ok || !result.success || !Array.isArray(result.officers)) {
          throw new Error(result.message || result.error || 'Could not load officers.')
        }

        if (active) setOfficers(result.officers)
      } catch (err) {
        if (active) setTargetError(err.message || 'Could not load officers.')
      } finally {
        if (active) setTargetLoading(false)
      }
    }

    async function loadLocations() {
      try {
        const user = auth.currentUser
        if (!user) throw new Error('Administrator session unavailable.')

        const token = await user.getIdToken()
        const response = await fetch('/api/locations', {
          headers: { Authorization: `Bearer ${token}` },
        })
        const result = await response.json()

        if (!response.ok || !result.success || !Array.isArray(result.constituencies)) {
          throw new Error(result.message || result.error || 'Could not load county locations.')
        }

        if (active) setLocations(result.constituencies)
      } catch (err) {
        if (active) setLocationError(err.message || 'Could not load county locations.')
      } finally {
        if (active) setLocationLoading(false)
      }
    }

    loadOfficers()
    loadLocations()

    return () => { active = false }
  }, [])

  const constituencies = locations

  const selectedConstituency = constituencies.find(
    item => item.id === targetConstituencyId
  )

  const wards = selectedConstituency?.wards || []

  async function sendBroadcast(event) {
    event.preventDefault()
    const text = message.trim()

    if (!text) {
      setError('Please enter a message before sending.')
      return
    }

    if (targetScope === 'officer' && targetLoading) {
      setError('Please wait for officer targeting options to load.')
      return
    }

    if ((targetScope === 'constituency' || targetScope === 'ward') && locationLoading) {
      setError('Please wait for county locations to load.')
      return
    }

    if ((targetScope === 'constituency' || targetScope === 'ward') && locationError) {
      setError(locationError)
      return
    }

    if (targetScope === 'constituency' && !targetConstituencyId) {
      setError('Please select a constituency.')
      return
    }

    if (targetScope === 'ward' && (!targetConstituencyId || !targetWardId)) {
      setError('Please select a constituency and ward.')
      return
    }

    if (targetScope === 'officer' && !targetOfficerUid) {
      setError('Please select an officer.')
      return
    }

    const target = {
      scope: targetScope,
      ...(targetScope === 'constituency' || targetScope === 'ward'
        ? { constituencyId: targetConstituencyId }
        : {}),
      ...(targetScope === 'ward' ? { wardId: targetWardId } : {}),
      ...(targetScope === 'officer' ? { officerUid: targetOfficerUid } : {}),
    }

    setSending(true)
    setError('')
    setSuccess('')

    try {
      const user = auth.currentUser
      if (!user) throw new Error('Your administrator session is unavailable.')

      const token = await user.getIdToken()
      const response = await fetch('/api/broadcast', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: text, target }),
      })

      const result = await response.json()

      if (!response.ok || !result.success) {
        throw new Error(result.error || result.message || 'Could not send broadcast.')
      }

      setSuccess(result.message || 'Broadcast sent successfully.')
      setMessage('')
    } catch (err) {
      setError(err.message || 'Unable to send broadcast.')
    } finally {
      setSending(false)
    }
  }

  const sendLabel = {
    all: 'Send to all officers',
    constituency: 'Send to constituency',
    ward: 'Send to ward',
    officer: 'Send to selected officer',
  }[targetScope]

  return (
    <section className="broadcasts-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">ADMIN WORKSPACE</div>
          <h1>Broadcasts</h1>
          <p>Send important announcements to field officers.</p>
        </div>
      </div>

      <section className="panel broadcast-compose-panel">
        <div className="panel-heading">
          <div>
            <h2>Compose announcement</h2>
            <p>Choose who should receive this announcement.</p>
          </div>
          <div className="broadcast-heading-icon">
            <Megaphone size={19} />
          </div>
        </div>

        <form onSubmit={sendBroadcast} className="broadcast-form">
          <label htmlFor="broadcast-target">Recipients</label>
          <select
            id="broadcast-target"
            value={targetScope}
            onChange={event => {
              setTargetScope(event.target.value)
              setTargetConstituencyId('')
              setTargetWardId('')
              setTargetOfficerUid('')
              setError('')
              setSuccess('')
            }}
          >
            <option value="all">All officers</option>
            <option value="constituency">A constituency</option>
            <option value="ward">A specific ward</option>
            <option value="officer">An individual officer</option>
          </select>

          {targetScope === 'officer' && targetLoading && (
            <p className="broadcast-target-hint">Loading officers...</p>
          )}

          {(targetScope === 'constituency' || targetScope === 'ward') && locationLoading && (
            <p className="broadcast-target-hint">Loading county constituencies and wards...</p>
          )}

          {targetScope === 'officer' && targetError && (
            <p className="broadcast-target-error" role="alert">{targetError}</p>
          )}

          {(targetScope === 'constituency' || targetScope === 'ward') && locationError && (
            <p className="broadcast-target-error" role="alert">{locationError}</p>
          )}

          {(targetScope === 'constituency' || targetScope === 'ward') && (
            <>
              <label htmlFor="broadcast-constituency">Constituency</label>
              <select
                id="broadcast-constituency"
                value={targetConstituencyId}
                onChange={event => {
                  setTargetConstituencyId(event.target.value)
                  setTargetWardId('')
                  setError('')
                }}
                required
                disabled={locationLoading || Boolean(locationError) || constituencies.length === 0}
              >
                <option value="">Select constituency</option>
                {constituencies.map(item => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </>
          )}

          {targetScope === 'ward' && (
            <>
              <label htmlFor="broadcast-ward">Ward</label>
              <select
                id="broadcast-ward"
                value={targetWardId}
                onChange={event => setTargetWardId(event.target.value)}
                required
                disabled={!targetConstituencyId || locationLoading || Boolean(locationError) || wards.length === 0}
              >
                <option value="">Select ward</option>
                {wards.map(item => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </>
          )}

          {targetScope === 'officer' && (
            <>
              <label htmlFor="broadcast-officer">Officer</label>
              <select
                id="broadcast-officer"
                value={targetOfficerUid}
                onChange={event => setTargetOfficerUid(event.target.value)}
                required
                disabled={targetLoading || officers.length === 0}
              >
                <option value="">Select officer</option>
                {officers.map(officer => (
                  <option key={officer.uid} value={officer.uid}>
                    {officer.username || officer.name || officer.email || officer.uid}
                    {' — '}
                    {officer.wardName || officer.ward || 'Ward not set'}
                  </option>
                ))}
              </select>
            </>
          )}

          <label htmlFor="broadcast-message">Message</label>
          <textarea
            id="broadcast-message"
            value={message}
            onChange={event => {
              setMessage(event.target.value)
              setError('')
              setSuccess('')
            }}
            placeholder="Write an announcement for field officers..."
            rows={7}
            maxLength={2000}
            required
          />

          <div className="broadcast-form-footer">
            <span>{message.length}/2000 characters</span>
            <button
              type="submit"
              className="button button-primary"
              disabled={
                sending ||
                !message.trim() ||
                (targetScope === 'officer' && targetLoading) ||
                (targetScope === 'officer' && Boolean(targetError)) ||
                ((targetScope === 'constituency' || targetScope === 'ward') &&
                  (locationLoading || Boolean(locationError)))
              }
            >
              <Megaphone size={16} />
              {sending ? 'Sending...' : sendLabel}
            </button>
          </div>
        </form>
      </section>

      {error && (
        <div className="broadcast-feedback broadcast-feedback-error" role="alert">
          <CircleAlert size={17} />
          <span>{error}</span>
        </div>
      )}

      {success && (
        <div className="broadcast-feedback broadcast-feedback-success" role="status">
          <CircleCheck size={17} />
          <span>{success}</span>
        </div>
      )}

      <div className="broadcast-delivery-note">
        <Megaphone size={17} />
        <div>
          <strong>How delivery works</strong>
          <p>Officers receive announcements addressed to them while online. The portal checks for new announcements every 30 seconds.</p>
        </div>
      </div>
    </section>
  )
}

function ReportsPage() {
  const localDate = (daysAgo = 0) => {
    const date = new Date()
    date.setDate(date.getDate() - daysAgo)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  const [type, setType] = useState('daily')
  const [startDate, setStartDate] = useState(() => localDate())
  const [endDate, setEndDate] = useState(() => localDate())
  const [ward, setWard] = useState('')
  const [officerUid, setOfficerUid] = useState('')
  const [officers, setOfficers] = useState([])
  const [officersError, setOfficersError] = useState('')
  const [loadingOfficers, setLoadingOfficers] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const [report, setReport] = useState(null)

  useEffect(() => {
    let active = true

    async function loadOfficers() {
      try {
        const user = auth.currentUser
        if (!user) throw new Error('Administrator session unavailable.')

        const token = await user.getIdToken()
        const response = await fetch('/api/officers', {
          headers: { Authorization: `Bearer ${token}` },
        })
        const result = await response.json()

        if (!response.ok || !result.success || !Array.isArray(result.officers)) {
          throw new Error(result.error || 'Could not load officer list.')
        }

        if (active) setOfficers(result.officers)
      } catch (err) {
        if (active) setOfficersError(err.message || 'Could not load officers.')
      } finally {
        if (active) setLoadingOfficers(false)
      }
    }

    loadOfficers()
    return () => { active = false }
  }, [])

  const wards = [...new Set(
    officers.map((officer) => String(officer.wardName || officer.ward || '').trim()).filter(Boolean)
  )].sort()

  async function generateReport(event) {
    event.preventDefault()
    setGenerating(true)
    setError('')
    setReport(null)

    try {
      const user = auth.currentUser
      if (!user) throw new Error('Your administrator session is unavailable.')

      const token = await user.getIdToken()
      const payload = { type }

      if (type === 'daily') {
        payload.startDate = startDate
      } else if (type === 'weekly' || type === 'monthly') {
        payload.startDate = startDate
        payload.endDate = endDate
      } else if (type === 'ward') {
        payload.ward = ward
      } else if (type === 'officer') {
        payload.officerUid = officerUid
      }

      const response = await fetch('/api/report', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })
      const result = await response.json()

      if (!response.ok || !result.success || !Array.isArray(result.transactions)) {
        throw new Error(result.error || result.message || 'Report generation failed.')
      }

      setReport(result)
    } catch (err) {
      setError(err.message || 'Unable to generate report.')
    } finally {
      setGenerating(false)
    }
  }

  function exportReport() {
    if (!report || !Array.isArray(report.transactions)) return

    const columns = [
      'Receipt', 'Officer', 'Revenue stream', 'Ward',
      'Payment method', 'Amount', 'Status', 'Date',
    ]
    const rows = report.transactions.map((item) => [
      item.receipt,
      item.officerUsername,
      item.revenueType,
      item.wardName || item.ward,
      item.paymentMethod,
      item.amount,
      item.status,
      formatTransactionTime(item.createdAt),
    ])

    const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`
    const csv = [columns, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `bungoma-pay-${type}-report-${localDate()}.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  const reportTitle = {
    daily: 'Daily collection report',
    weekly: 'Date-range collection report',
    monthly: 'Monthly collection report',
    ward: 'Ward collection report',
    officer: 'Officer collection report',
  }[type]

  return (
    <section className="reports-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">ADMIN WORKSPACE</div>
          <h1>Reports</h1>
          <p>Generate revenue reports by date, ward or field officer.</p>
        </div>
      </div>

      <section className="panel report-builder">
        <div className="panel-heading">
          <div>
            <h2>Report configuration</h2>
            <p>Select the report type and provide its criteria.</p>
          </div>
        </div>

        <form onSubmit={generateReport} className="report-form">
          <label className="report-field">
            <span>Report type</span>
            <select
              className="select-button"
              value={type}
              onChange={(event) => {
                setType(event.target.value)
                setReport(null)
                setError('')
              }}
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly / date range</option>
              <option value="monthly">Monthly / date range</option>
              <option value="ward">By ward</option>
              <option value="officer">By officer</option>
            </select>
          </label>

          {(type === 'daily' || type === 'weekly' || type === 'monthly') && (
            <div className="report-date-fields">
              <label className="report-field">
                <span>{type === 'daily' ? 'Report date' : 'Start date'}</span>
                <input
                  type="date"
                  value={startDate}
                  onChange={(event) => setStartDate(event.target.value)}
                  required
                />
              </label>

              {(type === 'weekly' || type === 'monthly') && (
                <label className="report-field">
                  <span>End date</span>
                  <input
                    type="date"
                    value={endDate}
                    min={startDate}
                    onChange={(event) => setEndDate(event.target.value)}
                    required
                  />
                </label>
              )}
            </div>
          )}

          {type === 'ward' && (
            <label className="report-field">
              <span>Ward</span>
              <select
                className="select-button"
                value={ward}
                onChange={(event) => setWard(event.target.value)}
                required
                disabled={loadingOfficers || wards.length === 0}
              >
                <option value="">
                  {loadingOfficers ? 'Loading wards...' : 'Select a ward'}
                </option>
                {wards.map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
              {officersError && <small>{officersError}</small>}
            </label>
          )}

          {type === 'officer' && (
            <label className="report-field">
              <span>Field officer</span>
              <select
                className="select-button"
                value={officerUid}
                onChange={(event) => setOfficerUid(event.target.value)}
                required
                disabled={loadingOfficers || officers.length === 0}
              >
                <option value="">
                  {loadingOfficers ? 'Loading officers...' : 'Select an officer'}
                </option>
                {officers.map((officer) => (
                  <option key={officer.uid} value={officer.uid}>
                    {officer.username || officer.name || officer.email || officer.uid}
                  </option>
                ))}
              </select>
              {officersError && <small>{officersError}</small>}
            </label>
          )}

          <div className="report-actions">
            <button
              className="button button-primary"
              type="submit"
              disabled={generating ||
                ((type === 'ward') && (!ward || loadingOfficers)) ||
                ((type === 'officer') && (!officerUid || loadingOfficers)) ||
                (type !== 'ward' && type !== 'officer' && (!startDate ||
                  ((type !== 'daily') && (!endDate || endDate < startDate))))}
            >
              <ChartNoAxesCombined size={16} />
              {generating ? 'Generating...' : 'Generate report'}
            </button>
          </div>
        </form>
      </section>

      {error && (
        <div className="officers-message officers-error" role="alert">
          <CircleAlert size={17} />
          <span>{error}</span>
        </div>
      )}

      {report && (
        <>
          <div className="page-heading report-result-heading">
            <div>
              <h2>{reportTitle}</h2>
              <p>
                Generated {report.summary?.generatedAt
                  ? new Date(report.summary.generatedAt).toLocaleString('en-KE')
                  : 'successfully'}
              </p>
            </div>
            <button className="button button-secondary" onClick={exportReport}>
              <Download size={16} />
              Export CSV
            </button>
          </div>

          <div className="stats-grid report-stats">
            <div className="stat-card">
              <div className="stat-top">Transactions</div>
              <div className="stat-value">
                {report.summary?.totalTransactions ?? report.transactions.length}
              </div>
              <div className="stat-bottom">Matching records</div>
            </div>
            <div className="stat-card">
              <div className="stat-top">Total reported revenue</div>
              <div className="stat-value">{formatKES(report.summary?.totalRevenue)}</div>
              <div className="stat-bottom">Paid transactions only</div>
            </div>
            <div className="stat-card">
              <div className="stat-top">M-PESA collections</div>
              <div className="stat-value">{formatKES(report.summary?.mpesaTotal)}</div>
              <div className="stat-bottom">Paid M-PESA collections</div>
            </div>
            <div className="stat-card">
              <div className="stat-top">Cash collections</div>
              <div className="stat-value">{formatKES(report.summary?.cashTotal)}</div>
              <div className="stat-bottom">Paid cash collections</div>
            </div>
          </div>

          <section className="panel report-stream-panel">
            <div className="panel-heading">
              <div>
                <h2>Revenue by stream</h2>
                <p>Paid collections grouped by stream and specific charge</p>
              </div>
              <span className="stream-paid-label">PAID ONLY</span>
            </div>
            {Object.keys(report.summary?.revenueBreakdown || {}).length === 0 ? (
              <div className="stream-empty">No paid revenue breakdown available.</div>
            ) : (
              <div className="stream-list">
                {Object.entries(report.summary.revenueBreakdown)
                  .sort((a, b) => Number(b[1]?.total || 0) - Number(a[1]?.total || 0))
                  .map(([stream, details]) => (
                    <div className="stream-item" key={stream}>
                      <div className="stream-main">
                        <div>
                          <strong>{stream}</strong>
                          <span>{Number(details.transactions || 0).toLocaleString('en-KE')} paid transactions</span>
                        </div>
                        <strong className="stream-total">{formatKES(details.total)}</strong>
                      </div>
                      <div className="stream-subtypes">
                        {Object.entries(details.subTypes || {})
                          .sort((a, b) => Number(b[1]?.total || 0) - Number(a[1]?.total || 0))
                          .map(([subType, values]) => (
                            <div className="stream-subtype" key={subType}>
                              <span>{subType}</span>
                              <span>{Number(values.transactions || 0).toLocaleString('en-KE')} · {formatKES(values.total)}</span>
                            </div>
                          ))}
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </section>

          <PaymentStatusAudit summary={report.summary?.statusSummary} />

          <section className="panel report-results-panel">
            <div className="panel-heading">
              <div>
                <h2>Report transactions</h2>
                <p>{report.transactions.length} matching records</p>
              </div>
            </div>
            <div className="table-scroll">
              <table className="transactions-table">
                <thead>
                  <tr>
                    <th>Receipt</th>
                    <th>Officer</th>
                    <th>Revenue stream</th>
                    <th>Ward</th>
                    <th>Payment</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {report.transactions.map((item) => {
                    const paid = String(item.status || '').toUpperCase() === 'PAID'
                    const method = String(item.paymentMethod || 'Unknown').toUpperCase()
                    return (
                      <tr key={item.id || item.receipt}>
                        <td className="receipt-cell">{item.receipt || '—'}</td>
                        <td>{item.officerUsername || '—'}</td>
                        <td>
                          <div className="report-revenue-type">
                            <strong>{item.revenueType || 'Unclassified'}</strong>
                            <span>{item.revenueSubType || 'Unspecified'}</span>
                          </div>
                        </td>
                        <td>{item.wardName || item.ward || '—'}</td>
                        <td>
                          <span className={`payment-method ${method === 'CASH' ? 'cash-method' : ''}`}>
                            {method}
                          </span>
                        </td>
                        <td className="amount-cell">{formatKES(item.amount)}</td>
                        <td>
                          <span className={`transaction-status ${paid ? 'status-paid' : 'status-pending'}`}>
                            {paid ? <CircleCheck size={13} /> : <Clock3 size={13} />}
                            {item.status || 'Unknown'}
                          </span>
                        </td>
                        <td className="time-cell">{formatTransactionTime(item.createdAt)}</td>
                      </tr>
                    )
                  })}
                  {report.transactions.length === 0 && (
                    <tr><td colSpan="8">No transactions matched this report.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </section>
  )
}

function SettingsPage() {
  const user = auth.currentUser

  function formatAccountDate(value) {
    if (!value) return 'Not available'
    const date = new Date(value)
    return Number.isNaN(date.getTime())
      ? 'Not available'
      : date.toLocaleString()
  }

  return (
    <section className="settings-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">ADMIN WORKSPACE</div>
          <h1>Settings</h1>
          <p>Review your administrator account and workspace information.</p>
        </div>
      </div>

      <section className="panel settings-panel">
        <div className="panel-heading">
          <div>
            <h2>Administrator account</h2>
            <p>Your currently authenticated Firebase account.</p>
          </div>
          <ShieldCheck size={22} />
        </div>

        <div className="settings-details">
          <div className="settings-detail">
            <span>Display name</span>
            <strong>{user?.displayName || 'Administrator'}</strong>
          </div>
          <div className="settings-detail">
            <span>Email address</span>
            <strong>{user?.email || 'Not available'}</strong>
          </div>
          <div className="settings-detail">
            <span>Workspace role</span>
            <strong>Administrator</strong>
          </div>
          <div className="settings-detail">
            <span>Email verification</span>
            <strong>{user?.emailVerified ? 'Verified' : 'Not verified'}</strong>
          </div>
          <div className="settings-detail">
            <span>Account created</span>
            <strong>{formatAccountDate(user?.metadata?.creationTime)}</strong>
          </div>
          <div className="settings-detail">
            <span>Last sign-in</span>
            <strong>{formatAccountDate(user?.metadata?.lastSignInTime)}</strong>
          </div>
        </div>
      </section>

      <section className="panel settings-panel">
        <div className="panel-heading">
          <div>
            <h2>Workspace information</h2>
            <p>Current revenue management workspace identity.</p>
          </div>
          <Settings size={21} />
        </div>

        <div className="settings-details">
          <div className="settings-detail">
            <span>Workspace name</span>
            <strong>Bungoma Pay</strong>
          </div>
          <div className="settings-detail">
            <span>Platform</span>
            <strong>Revenue Management</strong>
          </div>
          <div className="settings-detail">
            <span>Access</span>
            <strong>Restricted administrator access</strong>
          </div>
          <div className="settings-detail">
            <span>Authentication</span>
            <strong>Firebase Authentication</strong>
          </div>
        </div>
      </section>

      <div className="settings-security-note">
        <ShieldCheck size={19} />
        <div>
          <strong>Secure administrator session</strong>
          <p>Your dashboard access is checked against your server-side administrator role. Account and workspace details on this page are read-only.</p>
        </div>
      </div>
    </section>
  )
}

function SectionPlaceholder({ page }) {
  const descriptions = {
    Transactions: 'Review and manage revenue collection records.',
    Officers: 'Manage officer accounts, roles and field assignments.',
    Reports: 'Review revenue performance and generate reports.',
    Broadcasts: 'Communicate important updates to field officers.',
    Settings: 'Manage workspace preferences and system configuration.',
  }

  const Icon = navigation.find((item) => item.label === page)?.icon || Settings

  return (
    <section className="section-placeholder">
      <div className="eyebrow">ADMIN WORKSPACE</div>
      <div className="placeholder-icon"><Icon size={28} /></div>
      <h1>{page}</h1>
      <p>{descriptions[page]}</p>
      <div className="placeholder-note">
        <CircleAlert size={17} />
        This section is part of the application shell. Its workflows will be implemented in the next stages.
      </div>
    </section>
  )
}

export default App
