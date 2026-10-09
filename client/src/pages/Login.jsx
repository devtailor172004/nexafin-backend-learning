import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { Button, Field, TextInput } from '../components/ui.jsx';

export default function Login() {
    const { login, isAuthenticated } = useAuth();
    const navigate = useNavigate();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);

    if (isAuthenticated) {
        return <Navigate to="/" replace />;
    }

    const onSubmit = async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await login(email.trim(), password);
            navigate('/', { replace: true });
        } catch (err) {
            setError(err.message || 'Login failed.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="flex min-h-full items-center justify-center px-4 py-10">
            <div className="w-full max-w-sm">
                <div className="mb-8 text-center">
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-400">SecurePay Lab</p>
                    <h1 className="mt-2 text-2xl font-semibold text-slate-100">Operations Console</h1>
                    <p className="mt-1 text-sm text-slate-400">Payments · KYC · Real-time operations</p>
                </div>

                <form onSubmit={onSubmit} className="space-y-4 rounded-2xl border border-slate-800 bg-[#0e1526] p-5">
                    <Field label="Email">
                        <TextInput
                            type="email"
                            required
                            autoComplete="username"
                            placeholder="admin@example.com"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                        />
                    </Field>

                    <Field label="Password">
                        <TextInput
                            type="password"
                            required
                            autoComplete="current-password"
                            placeholder="••••••••"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                        />
                    </Field>

                    {error && (
                        <p className="rounded-lg border border-rose-900/60 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">{error}</p>
                    )}

                    <Button type="submit" disabled={busy} className="w-full">
                        {busy ? 'Signing in…' : 'Sign in'}
                    </Button>

                    <p className="text-center text-xs text-slate-400">
                        Admin credentials are required to access the operations layer.
                    </p>
                </form>
            </div>
        </div>
    );
}
