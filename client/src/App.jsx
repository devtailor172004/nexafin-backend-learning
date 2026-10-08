import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import LiveOps from './pages/LiveOps.jsx';
import Payments from './pages/Payments.jsx';
import ProviderHealth from './pages/ProviderHealth.jsx';
import Reconciliation from './pages/Reconciliation.jsx';
import Customers from './pages/Customers.jsx';
import Kyc from './pages/Kyc.jsx';
import KycVerification from './pages/KycVerification.jsx';
import Simulator from './pages/Simulator.jsx';
import { EmptyState } from './components/ui.jsx';
import { ToastProvider } from './lib/toast.jsx';

function RequireAuth({ children }) {
    const { isAuthenticated } = useAuth();
    if (!isAuthenticated) {
        return <Navigate to="/login" replace />;
    }
    return children;
}

function NotFound() {
    return (
        <EmptyState
            title="Page not found"
            description="Use the navigation to return to a module."
        />
    );
}

export default function App() {
    return (
        <AuthProvider>
            <ToastProvider>
            <BrowserRouter>
                <Routes>
                    <Route path="/login" element={<Login />} />
                    <Route element={<RequireAuth><Layout /></RequireAuth>}>
                        <Route path="/" element={<Dashboard />} />
                        <Route path="/simulator" element={<Simulator />} />
                        <Route path="/live" element={<LiveOps />} />
                        <Route path="/payments" element={<Payments />} />
                        <Route path="/health" element={<ProviderHealth />} />
                        <Route path="/reconciliation" element={<Reconciliation />} />
                        <Route path="/customers" element={<Customers />} />
                        <Route path="/kyc" element={<Kyc />} />
                        <Route path="/kyc/verification" element={<KycVerification />} />
                        <Route path="*" element={<NotFound />} />
                    </Route>
                </Routes>
            </BrowserRouter>
            </ToastProvider>
        </AuthProvider>
    );
}
