import { lazy, Suspense, useEffect, useState } from 'react'
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth'
import { auth } from './firebase'
const AdminApp = lazy(() => import('./App.jsx'))
const OfficerPortal = lazy(() => import('./OfficerPortal.jsx'))
import './AuthGate.css'

function LoginScreen({ portal, onLogin, error, busy }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const isAdmin = portal === 'admin'

  async function handleSubmit(event) {
    event.preventDefault()
    await onLogin(email.trim(), password)
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-brand">
          <div className="auth-brand-mark">B</div>
          <div>
            <strong>Bungoma Pay</strong>
            <span>Revenue Management</span>
          </div>
        </div>

        <div className="auth-heading">
          <span>{isAdmin ? 'ADMINISTRATOR ACCESS' : 'OFFICER ACCESS'}</span>
          <h1>{isAdmin ? 'Admin sign in' : 'Officer sign in'}</h1>
          <p>
            {isAdmin
              ? 'Sign in to access the restricted administration workspace.'
              : 'Sign in to access your revenue collection portal.'}
          </p>
        </div>

        {error && <div className="auth-error" role="alert">{error}</div>}

        <form onSubmit={handleSubmit} className="auth-form">
          <label htmlFor="portal-email">Email address</label>
          <input
            id="portal-email"
            type="email"
            autoComplete="username"
            placeholder="Enter your email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />

          <label htmlFor="portal-password">Password</label>
          <input
            id="portal-password"
            type="password"
            autoComplete="current-password"
            placeholder="Enter your password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />

          <button type="submit" disabled={busy}>
            {busy ? 'Signing in...' : 'Sign in securely'}
          </button>
        </form>

        <p className="auth-footnote">
          {isAdmin
            ? 'Restricted to authorized administrators.'
            : 'Use your assigned Bungoma Pay officer account.'}
        </p>
      </section>
    </main>
  )
}

export default function AuthGate() {
  const path = window.location.pathname
    .replace(/^\/dashboard(?=\/|$)/, '')
    .replace(/\/+$/, '') || '/'
  const portal = path.startsWith('/officer') ? 'officer' : 'admin'
  const [status, setStatus] = useState('checking')
  const [profile, setProfile] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!active) return

      if (!user) {
        setProfile(null)
        setStatus('signed-out')
        return
      }

      setStatus('checking')

      try {
        const token = await user.getIdToken()
        const response = await fetch('/api/me', {
          headers: { Authorization: `Bearer ${token}` },
        })

        const result = await response.json().catch(() => ({}))

        if (!response.ok || !result.success) {
          throw new Error(result.message || 'Could not verify your account.')
        }

        if (!active) return

        const account = result.user || {}

        if (account.role !== portal) {
          await signOut(auth)
          if (!active) return
          setProfile(null)
          setError(
            `Access denied. This account is not authorized for the ${portal} portal.`
          )
          setStatus('signed-out')
          return
        }

        setError('')
        setProfile(account)
        setStatus('authorized')
      } catch (err) {
        if (!active) return
        setError(err.message || 'Unable to verify your account.')
        setStatus('error')
      }
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [portal])

  async function handleLogin(email, password) {
    setBusy(true)
    setError('')

    try {
      await signInWithEmailAndPassword(auth, email, password)
    } catch (err) {
      const messages = {
        'auth/invalid-credential': 'Incorrect email or password.',
        'auth/invalid-email': 'Please enter a valid email address.',
        'auth/too-many-requests': 'Too many attempts. Please try again later.',
        'auth/network-request-failed': 'Network error. Check your connection.',
      }

      setError(messages[err.code] || 'Sign-in failed. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function handleSignOut() {
    await signOut(auth)
    setProfile(null)
    setError('')
    setStatus('signed-out')
  }

  if (status === 'checking') {
    return (
      <main className="auth-loading">
        <div className="auth-spinner" />
        <p>Verifying your account...</p>
      </main>
    )
  }

  if (status === 'authorized' && portal === 'admin') {
    return (
      <>
        <div className="auth-session-strip">
          <span>Administrator: {profile?.email || 'Authorized'}</span>
          <button onClick={handleSignOut}>Sign out</button>
        </div>
        <Suspense fallback={<main className="auth-loading"><div className="auth-spinner" /><p>Loading administrator portal...</p></main>}>
          <AdminApp />
        </Suspense>
      </>
    )
  }

  if (status === 'authorized' && portal === 'officer') {
    return (
      <Suspense fallback={<main className="auth-loading"><div className="auth-spinner" /><p>Loading officer portal...</p></main>}>
        <OfficerPortal profile={profile} />
      </Suspense>
    )
  }

  return (
    <LoginScreen
      portal={portal}
      onLogin={handleLogin}
      error={error}
      busy={busy}
    />
  )
}
