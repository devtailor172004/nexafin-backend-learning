import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { clearSession, endpoints, getStoredUser, getToken, setSession } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
    const [user, setUser] = useState(() => getStoredUser());
    const [token, setTokenState] = useState(() => getToken());

    const login = useCallback(async (email, password) => {
        const response = await endpoints.login(email, password);
        const nextToken = response?.data?.token;
        const nextUser = response?.data?.user;

        if (!nextToken) {
            throw new Error('Login succeeded but no token was returned.');
        }

        setSession(nextToken, nextUser);
        setTokenState(nextToken);
        setUser(nextUser);

        return nextUser;
    }, []);

    const logout = useCallback(() => {
        // Best-effort server-side token blacklisting is not required for the
        // client to be safe: the local session is cleared synchronously.
        clearSession();
        setTokenState(null);
        setUser(null);
    }, []);

    const value = useMemo(() => ({
        user,
        token,
        isAuthenticated: Boolean(token),
        isAdmin: user?.role === 'Admin',
        login,
        logout
    }), [user, token, login, logout]);

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (!context) {
        throw new Error('useAuth must be used inside an AuthProvider.');
    }
    return context;
}
