import { useEffect, useState } from 'react'
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth'
import { auth } from './firebase'
import OfficerPortal from './OfficerPortal'
import './AuthGate.css'

function LoginScreen({ onLogin, error, busy }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

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
          <span>SECURE ACCOUNT ACCESS</span>
          <h1>Welcome back</h1>
          <p>Sign in to access the revenue management workspace.</p>
        </div>

        {error && <div className="auth-error" role="alert">{error}</div>}

        <form onSubmit={handleSubmit} className="auth-form">
          <label htmlFor="admin-email">Email address</label>
          <input
            id="admin-email"
            type="email"
            autoComplete="username"
            placeholder="Enter your email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />

          <label htmlFor="admin-password">Password</label>
          <input
            id="admin-password"
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
          Access is restricted to authorized Bungoma Pay accounts.
        </p>
      </section>
    </main>
  )
}

export default function AuthGate({ children }) {
  const [status, setStatus] = useState('checking')
  const [profile, setProfile] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!active) return

      setError('')

      if (!user) {
        setProfile(null)
        setStatus('signed-out')
        return
      }

      setStatus('checking')

      try {
        const token = await user.getIdToken()
        const response = await fetch('/api/me', {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        })

        const responseText = await response.text()
        let result

        try {
          result = JSON.parse(responseText)
        } catch {
          throw new Error(
            `Account verification returned non-JSON (HTTP ${response.status}, ${response.headers.get('content-type') || 'unknown content type'}). Check the API response.`
          )
        }

        if (!response.ok || !result.success) {
          throw new Error(result.message || 'Could not verify your account.')
        }

        if (!active) return

        const account = result.user || {}

        if (account.role !== 'admin' && account.role !== 'officer') {
          throw new Error('This account does not have an authorized portal role.')
        }

        setProfile(account)
        setStatus(account.role)
      } catch (err) {
        if (!active) return
        setError(err.message || 'Unable to verify your account with the server.')
        setStatus('error')
      }
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [])

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

      setError(`${messages[err.code] || 'Sign-in failed. Please try again.'} [${err.code || 'unknown'}]`)
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

  if (status === 'admin') {
    return (
      <>
        <div className="auth-session-strip">
          <span>Signed in: {profile?.email || 'Administrator'}</span>
          <button onClick={handleSignOut}>Sign out</button>
        </div>
        {children}
      </>
    )
  }

  if (status === 'officer') {
    return <OfficerPortal profile={profile} />
  }

  return (
    <LoginScreen
      onLogin={handleLogin}
      error={error}
      busy={busy}
    />
  )
}
