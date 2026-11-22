import { useState, type FormEvent } from 'react';
import type { User } from '@ceg/contract';
import { api, errorText } from '../api.ts';

const USERNAME = /^[a-z0-9_-]{3,20}$/;

export function Login({ onLoggedIn }: { onLoggedIn: (u: User) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === 'register') {
      if (!USERNAME.test(username)) return setError('Username: 3 to 20 of a-z, 0-9, _ or -.');
      if (password.length < 10) return setError('Password: at least 10 characters.');
      if (!invite.trim()) return setError('An invite code is required.');
    }
    setBusy(true);
    try {
      const r = mode === 'login'
        ? await api.login({ username, password })
        : await api.register({ invite_code: invite.trim(), username, password });
      onLoggedIn(r.user);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <h1>C Exam Gym</h1>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'login'} onClick={() => setMode('login')}>
          Log in
        </button>
        <button type="button" role="tab" aria-selected={mode === 'register'} onClick={() => setMode('register')}>
          Register
        </button>
      </div>
      <form onSubmit={(e) => void submit(e)} className="form">
        {mode === 'register' && (
          <label>
            Invite code
            <input
              name="invite_code"
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              required
            />
          </label>
        )}
        <label>
          Username
          <input
            name="username"
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase())}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="username"
            spellCheck={false}
            required
          />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
          />
        </label>
        <button type="submit" className="primary" disabled={busy}>
          {mode === 'login' ? 'Log in' : 'Create account'}
        </button>
        {error && <p className="error" role="alert">{error}</p>}
      </form>
    </main>
  );
}
