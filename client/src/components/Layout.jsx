import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { Toaster } from '../lib/toast.jsx';

const NAV_GROUPS = [
    {
        label: 'Overview',
        items: [
            { to: '/', label: 'Dashboard', end: true, icon: '📊' },
            { to: '/live', label: 'Live Ops', icon: '⚡' }
        ]
    },
    {
        label: 'Payments',
        items: [
            { to: '/simulator', label: 'Payment Simulator', icon: '🧪' },
            { to: '/payments', label: 'Payments', icon: '💳' },
            { to: '/reconciliation', label: 'Reconciliation', icon: '🧾' },
            { to: '/health', label: 'Provider Health', icon: '🩺' }
        ]
    },
    {
        label: 'Customers & KYC',
        items: [
            { to: '/customers', label: 'Customer 360', icon: '👤' },
            { to: '/kyc', label: 'KYC Review', icon: '🛡️' },
            { to: '/kyc/verification', label: 'KYC Verification', icon: '✅', badge: 'New' }
        ]
    }
];

function NavItems({ onNavigate }) {
    return (
        <nav className="flex flex-col gap-4">
            {NAV_GROUPS.map((group) => (
                <div key={group.label}>
                    <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
                        {group.label}
                    </p>
                    <div className="flex flex-col gap-1">
                        {group.items.map((item) => (
                            <NavLink
                                key={item.to}
                                to={item.to}
                                end={item.end}
                                onClick={onNavigate}
                                className={({ isActive }) => (
                                    `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                                        isActive
                                            ? 'bg-sky-500/15 text-sky-200 ring-1 ring-inset ring-sky-500/30'
                                            : 'text-slate-400 hover:bg-slate-800/70 hover:text-slate-100'
                                    }`
                                )}
                            >
                                <span aria-hidden="true">{item.icon}</span>
                                <span className="flex-1">{item.label}</span>
                                {item.badge && (
                                    <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-300 ring-1 ring-inset ring-emerald-500/30">
                                        {item.badge}
                                    </span>
                                )}
                            </NavLink>
                        ))}
                    </div>
                </div>
            ))}
        </nav>
    );
}

export default function Layout() {
    const [drawerOpen, setDrawerOpen] = useState(false);
    const { user, logout } = useAuth();
    const navigate = useNavigate();

    const handleLogout = () => {
        logout();
        navigate('/login', { replace: true });
    };

    return (
        <div className="flex min-h-full flex-col lg:flex-row">
            {/* In-app notifications */}
            <Toaster />

            {/* Mobile top bar */}
            <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-slate-800 bg-[#0b1120]/95 px-4 py-3 backdrop-blur lg:hidden">
                <button
                    onClick={() => setDrawerOpen(true)}
                    className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300"
                    aria-label="Open navigation"
                >
                    ☰
                </button>
                <span className="text-sm font-semibold tracking-wide text-slate-100">SecurePay Lab</span>
                <button onClick={handleLogout} className="rounded-lg px-2 py-1.5 text-xs text-slate-400 hover:text-slate-100">
                    Logout
                </button>
            </header>

            {/* Mobile drawer */}
            {drawerOpen && (
                <div className="fixed inset-0 z-40 lg:hidden">
                    <div className="absolute inset-0 bg-black/60" onClick={() => setDrawerOpen(false)} />
                    <aside className="absolute left-0 top-0 h-full w-72 overflow-y-auto border-r border-slate-800 bg-[#0b1120] p-4">
                        <div className="mb-4 flex items-center justify-between">
                            <span className="text-sm font-semibold tracking-wide text-slate-100">SecurePay Lab</span>
                            <button onClick={() => setDrawerOpen(false)} className="text-slate-400 hover:text-slate-100" aria-label="Close navigation">✕</button>
                        </div>
                        <NavItems onNavigate={() => setDrawerOpen(false)} />
                    </aside>
                </div>
            )}

            {/* Desktop sidebar */}
            <aside className="hidden w-60 shrink-0 flex-col overflow-y-auto border-r border-slate-800 bg-[#0b1120] p-4 lg:flex">
                <div className="mb-6">
                    <p className="text-sm font-semibold tracking-wide text-slate-100">SecurePay Lab</p>
                    <p className="mt-0.5 text-[11px] text-slate-500">Payments · KYC · Operations Intelligence</p>
                </div>
                <NavItems />
                <div className="mt-auto border-t border-slate-800 pt-4">
                    <p className="truncate text-xs text-slate-400">{user?.fullName || 'Admin'}</p>
                    <p className="truncate text-[11px] text-slate-500">{user?.email}</p>
                    <button onClick={handleLogout} className="mt-3 w-full rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700">
                        Sign out
                    </button>
                </div>
            </aside>

            <main className="flex-1 overflow-x-hidden p-4 sm:p-6">
                <Outlet />
            </main>
        </div>
    );
}
