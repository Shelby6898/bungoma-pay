import { useEffect, useMemo, useState } from 'react'
import { signOut } from 'firebase/auth'
import { collection, onSnapshot, orderBy, query, where } from 'firebase/firestore'
import { Activity, Bell, Camera, CheckCircle2, Clock3, LogOut, Menu, Settings, Wallet, X } from 'lucide-react'
import { auth, db } from './firebase'
import './OfficerPortal.css'

const revenueOptions = {
  Parking: ['General Vehicle Parking', 'Bodaboda Parking', 'Enclosed Bus Park'],
  'Market Fee': ['Daily Trader Fee', 'Produce Fee', 'Market Vehicle / Transport Charge'],
  Cess: ['Maize Cess', 'Coffee / Tea Cess', 'Other Produce Cess'],
  'Business Permit': ['New Permit', 'Renewal', 'Duplicate', 'Transfer'],
}
const money = value => 'KES ' + Number(value || 0).toLocaleString('en-KE')
const readQueue = uid => {
  try { return JSON.parse(localStorage.getItem('offlineQueue:' + uid) || '[]') }
  catch { return [] }
}

export default function OfficerPortal({ profile }) {
  const user = auth.currentUser
  const [transactions, setTransactions] = useState([])
  const [queue, setQueue] = useState(() => user ? readQueue(user.uid) : [])
  const [broadcast, setBroadcast] = useState(null)
  const [tab, setTab] = useState('mpesa')
  const [mpesaType, setMpesaType] = useState('Parking')
  const [cashType, setCashType] = useState('Parking')
  const [mpesaSub, setMpesaSub] = useState(revenueOptions.Parking[0])
  const [cashSub, setCashSub] = useState(revenueOptions.Parking[0])
  const [amount, setAmount] = useState('50')
  const [plate, setPlate] = useState('')
  const [phone, setPhone] = useState('')
  const [cashAmount, setCashAmount] = useState('')
  const [cashClient, setCashClient] = useState('')
  const [displayName, setDisplayName] = useState(profile?.username || profile?.name || user?.email?.split('@')[0] || 'Officer')
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)

  const total = useMemo(() => transactions.reduce((sum, tx) => sum + Number(tx.amount || 0), 0), [transactions])
  const token = async () => auth.currentUser?.getIdToken()

  useEffect(() => {
    if (!user) return
    const txQuery = query(collection(db, 'transactions'), where('createdBy', '==', user.uid), orderBy('createdAt', 'desc'))
    const stopTransactions = onSnapshot(txQuery, snapshot => {
      setTransactions(snapshot.docs.map(item => ({ id: item.id, ...item.data() })))
    }, () => setStatus({ type: 'error', message: 'Could not load your live transactions.' }))
    const stopBroadcasts = onSnapshot(query(collection(db, 'broadcasts'), orderBy('createdAt', 'desc')), snapshot => {
      const unread = snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
        .find(item => !(item.readBy || []).includes(user.uid))
      setBroadcast(unread || null)
    })
    const heartbeat = window.setInterval(async () => {
      if (!navigator.onLine || !auth.currentUser) return
      const idToken = await token()
      fetch('/api/heartbeat', { method: 'POST', headers: { Authorization: 'Bearer ' + idToken } }).catch(() => {})
    }, 30000)
    const onlineHandler = () => setOnline(navigator.onLine)
    window.addEventListener('online', onlineHandler)
    window.addEventListener('offline', onlineHandler)
    return () => {
      stopTransactions()
      stopBroadcasts()
      window.clearInterval(heartbeat)
      window.removeEventListener('online', onlineHandler)
      window.removeEventListener('offline', onlineHandler)
    }
  }, [user?.uid])

  useEffect(() => {
    if (user) localStorage.setItem('offlineQueue:' + user.uid, JSON.stringify(queue))
  }, [queue, user?.uid])

  useEffect(() => {
    if (online && queue.length && user) syncOffline()
  }, [online, user?.uid, queue.length])

  async function request(path, payload) {
    const idToken = await token()
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + idToken },
      body: JSON.stringify(payload),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok || !result.success) throw new Error(result.message || result.error || 'Request failed.')
    return result
  }

  async function submitMpesa(event) {
    event.preventDefault()
    if (!amount || !plate.trim() || !phone.trim()) {
      setStatus({ type: 'error', message: 'Enter the amount, vehicle/client reference and phone number.' })
      return
    }
    const payload = { amount, plate: plate.trim(), phone: phone.trim(), ward: profile?.wardName || profile?.ward || '', revenueType: mpesaType, revenueSubType: mpesaSub }
    const key = 'pendingMpesaRequest:' + user.uid
    setBusy(true); setStatus({ type: 'loading', message: 'Preparing M-PESA request…' })
    try {
      let pending
      try { pending = JSON.parse(localStorage.getItem(key) || 'null') } catch { localStorage.removeItem(key) }
      if (pending && Object.keys(payload).some(field => pending[field] !== payload[field])) {
        throw new Error('A previous M-PESA request is unresolved. Restore its original details before retrying.')
      }
      if (!pending) {
        pending = { ...payload, idempotencyKey: crypto.randomUUID() }
        localStorage.setItem(key, JSON.stringify(pending))
      }
      await request('/api/pay', pending)
      localStorage.removeItem(key)
      setStatus({ type: 'success', message: 'STK Push sent. Ask the customer to enter their M-PESA PIN.' })
      setPlate(''); setPhone('')
    } catch (error) { setStatus({ type: 'error', message: error.message }) }
    finally { setBusy(false) }
  }

  async function submitCash(event) {
    event.preventDefault()
    if (!cashAmount || !cashClient.trim()) {
      setStatus({ type: 'error', message: 'Enter the cash amount and client/vehicle reference.' })
      return
    }
    const payload = { amount: cashAmount, plate: cashClient.trim(), revenueType: cashType, revenueSubType: cashSub }
    if (!online) {
      const offline = { ...payload, createdBy: user.uid, receipt: 'OFFLINE-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase(), createdAt: new Date().toISOString() }
      setQueue(current => [...current, offline])
      setStatus({ type: 'success', message: 'Saved securely on this device. It will sync when you are online.' })
      setCashAmount(''); setCashClient('')
      return
    }
    const key = 'pendingCashRequest:' + user.uid
    setBusy(true); setStatus({ type: 'loading', message: 'Recording cash payment…' })
    try {
      let pending
      try { pending = JSON.parse(localStorage.getItem(key) || 'null') } catch { localStorage.removeItem(key) }
      if (!pending) {
        pending = { ...payload, idempotencyKey: crypto.randomUUID() }
        localStorage.setItem(key, JSON.stringify(pending))
      } else if (Object.keys(payload).some(field => pending[field] !== payload[field])) {
        throw new Error('A previous cash request is unresolved. Restore its original details before retrying.')
      }
      const result = await request('/api/cash', pending)
      localStorage.removeItem(key)
      setStatus({ type: 'success', message: 'Cash recorded. Receipt: ' + result.receipt })
      setCashAmount(''); setCashClient('')
    } catch (error) { setStatus({ type: 'error', message: error.message }) }
    finally { setBusy(false) }
  }

  async function syncOffline() {
    if (!user || !navigator.onLine || !queue.length || busy) return
    setBusy(true)
    try {
      const batch = queue.slice(0, 50)
      const result = await request('/api/sync-offline', { transactions: batch })
      const completed = Number(result.synced) + Number(result.skipped)
      if (!Number.isInteger(completed) || completed !== batch.length) throw new Error('Server did not confirm every queued transaction.')
      setQueue(current => current.slice(batch.length))
      setStatus({ type: 'success', message: 'Offline queue synchronization completed.' })
    } catch (error) {
      setStatus({ type: 'error', message: 'Sync paused. Unconfirmed transactions remain saved: ' + error.message })
    } finally { setBusy(false) }
  }

  async function markBroadcastRead() {
    if (!broadcast) return
    try { await request('/api/broadcast/' + encodeURIComponent(broadcast.id) + '/read', {}) }
    catch { setStatus({ type: 'error', message: 'Could not mark the announcement as read.' }) }
    setBroadcast(null)
  }

  async function saveProfile(event) {
    event.preventDefault()
    setBusy(true)
    try {
      await request('/api/profile/update', { username: displayName.trim() })
      setStatus({ type: 'success', message: 'Profile updated.' })
      setSettingsOpen(false)
    } catch (error) { setStatus({ type: 'error', message: error.message }) }
    finally { setBusy(false) }
  }

  async function logout() {
    try {
      const idToken = await token()
      if (idToken) fetch('/api/offline', { method: 'POST', headers: { Authorization: 'Bearer ' + idToken } }).catch(() => {})
    } finally { await signOut(auth) }
  }

  const dateLabel = value => {
    if (!value) return '—'
    const date = value.toDate ? value.toDate() : new Date(value)
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' })
  }

  return (
    <div className="officer-shell">
      <header className="officer-header">
        <div className="officer-brand"><span className="officer-brand-mark">B</span><div><strong>Bungoma Pay</strong><small>Officer collection portal</small></div></div>
        <div className="officer-header-actions">
          <div className="officer-user"><span>{displayName.charAt(0).toUpperCase()}</span><div><strong>{displayName}</strong><small>Revenue officer</small></div></div>
          <button className="officer-icon-button" onClick={() => setSettingsOpen(true)} aria-label="Profile settings"><Settings size={18}/></button>
          <button className="officer-logout" onClick={logout}><LogOut size={16}/> Sign out</button>
        </div>
      </header>
      {!online && <div className="officer-offline">You are offline. Cash collections are saved on this device until synchronization is possible.</div>}
      {broadcast && <div className="officer-broadcast"><Bell size={18}/><div><strong>{broadcast.senderName || 'Administrator'} sent an announcement</strong><p>{broadcast.message}</p></div><button onClick={markBroadcastRead} aria-label="Dismiss announcement"><X size={18}/></button></div>}
      <main className="officer-content">
        <div className="officer-welcome"><div><span className="officer-eyebrow">FIELD WORKSPACE</span><h1>Welcome, {displayName}</h1><p>{profile?.wardName || profile?.ward || profile?.constituencyName || 'Assigned collection area'}</p></div><div className="officer-live"><Activity size={16}/> Live portal</div></div>
        <section className="officer-stats">
          <article><span><Wallet size={18}/></span><small>Total recorded revenue</small><strong>{money(total)}</strong></article>
          <article><span><CheckCircle2 size={18}/></span><small>Recorded transactions</small><strong>{transactions.length}</strong></article>
          <article><span><Clock3 size={18}/></span><small>Awaiting sync</small><strong>{queue.length}</strong></article>
        </section>
        <section className="officer-panel">
          <div className="officer-tabs"><button className={tab === 'mpesa' ? 'active' : ''} onClick={() => setTab('mpesa')}>M-PESA payment</button><button className={tab === 'cash' ? 'active' : ''} onClick={() => setTab('cash')}>Cash collection</button></div>
          {tab === 'mpesa' ? <form className="officer-form" onSubmit={submitMpesa}>
            <h2>Request an M-PESA payment</h2><p>The customer receives an STK prompt on their phone.</p>
            <label>Amount (KES)<input type="number" min="1" step="1" value={amount} onChange={e => setAmount(e.target.value)} required/></label>
            <label>Revenue stream<select value={mpesaType} onChange={e => {setMpesaType(e.target.value);setMpesaSub(revenueOptions[e.target.value][0])}}>{Object.keys(revenueOptions).map(x=><option key={x}>{x}</option>)}</select></label>
            <label>Specific charge<select value={mpesaSub} onChange={e=>setMpesaSub(e.target.value)}>{revenueOptions[mpesaType].map(x=><option key={x}>{x}</option>)}</select></label>
            <label>Vehicle plate / client ID<input value={plate} onChange={e=>setPlate(e.target.value)} placeholder="e.g. KCA 123A" required/></label>
            <label>Customer phone number<input value={phone} onChange={e=>setPhone(e.target.value)} placeholder="e.g. 0712 345 678" inputMode="tel" required/></label>
            <button className="officer-submit" disabled={busy || !online}>{busy ? 'Please wait…' : 'Send M-PESA prompt'}</button>
            {!online && <small>M-PESA requests require an internet connection.</small>}
          </form> : <form className="officer-form" onSubmit={submitCash}>
            <h2>Record a cash collection</h2><p>Cash transactions can be saved offline and synchronized later.</p>
            <label>Amount (KES)<input type="number" min="1" step="1" value={cashAmount} onChange={e=>setCashAmount(e.target.value)} required/></label>
            <label>Client ID / vehicle reference<input value={cashClient} onChange={e=>setCashClient(e.target.value)} placeholder="Client name, ID or plate" required/></label>
            <label>Revenue stream<select value={cashType} onChange={e=>{setCashType(e.target.value);setCashSub(revenueOptions[e.target.value][0])}}>{Object.keys(revenueOptions).map(x=><option key={x}>{x}</option>)}</select></label>
            <label>Specific charge<select value={cashSub} onChange={e=>setCashSub(e.target.value)}>{revenueOptions[cashType].map(x=><option key={x}>{x}</option>)}</select></label>
            <button className="officer-submit" disabled={busy}>{busy ? 'Please wait…' : online ? 'Record cash payment' : 'Save cash offline'}</button>
          </form>}
          {status && <div className={'officer-status ' + status.type} role="status">{status.message}</div>}
        </section>
        <section className="officer-panel officer-history">
          <div className="officer-history-heading"><div><h2>My transactions</h2><p>Live records linked to your officer account</p></div><button onClick={syncOffline} disabled={!online || !queue.length || busy}>Sync {queue.length} pending</button></div>
          {queue.map(tx=><article className="officer-tx pending" key={tx.receipt}><div><strong>{tx.plate}</strong><small>{tx.revenueType} · Pending sync</small></div><div><strong>{money(tx.amount)}</strong><small>OFFLINE</small></div></article>)}
          {transactions.length === 0 && queue.length === 0 ? <p className="officer-empty">No transactions recorded yet.</p> : transactions.slice(0,40).map(tx=><article className="officer-tx" key={tx.id}><div><strong>{tx.plate || tx.cashClient || 'Client'}</strong><small>{tx.revenueType || '—'} · {tx.revenueSubType || '—'} · {dateLabel(tx.createdAt)}</small></div><div><strong>{money(tx.amount)}</strong><small>{tx.paymentMethod || tx.status || 'Recorded'}</small></div></article>)}
        </section>
      </main>
      {settingsOpen && <div className="officer-modal-backdrop"><form className="officer-modal" onSubmit={saveProfile}><div><h2>Profile settings</h2><button type="button" onClick={()=>setSettingsOpen(false)} aria-label="Close"><X size={18}/></button></div><label>Display name<input value={displayName} onChange={e=>setDisplayName(e.target.value)} maxLength="80" required/></label><p>Password changes are managed through the sign-in page.</p><button className="officer-submit" disabled={busy}>Save profile</button></form></div>}
    </div>
  )
}
