"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import {
  login as apiLogin,
  register as apiRegister,
  getMe,
  setTokens,
  loadTokens,
  clearTokens,
  getAccessToken,
  logout as apiLogout,
  type SafeUser,
} from "./api";

interface AuthState {
  user: SafeUser | null;
  loading: boolean;
  authenticated: boolean;
}

interface AuthContextType extends AuthState {
  login: (email: string, password: string) => Promise<{ error?: string }>;
  register: (
    email: string,
    name: string,
    password: string
  ) => Promise<{ error?: string }>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    loading: true,
    authenticated: false,
  });

  useEffect(() => {
    loadTokens();
    if (getAccessToken()) {
      getMe().then((res) => {
        if (res.success && res.data) {
          setState({ user: res.data, loading: false, authenticated: true });
        } else {
          clearTokens();
          setState({ user: null, loading: false, authenticated: false });
        }
      });
    } else {
      setState({ user: null, loading: false, authenticated: false });
    }
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await apiLogin(email, password);
      if (res.success && res.data) {
        setTokens(res.data.tokens.accessToken, res.data.tokens.refreshToken);
        setState({
          user: res.data.user,
          loading: false,
          authenticated: true,
        });
        return {};
      }
      return { error: res.error?.message || "Login failed" };
    },
    []
  );

  const register = useCallback(
    async (email: string, name: string, password: string) => {
      const res = await apiRegister(email, name, password);
      if (res.success && res.data) {
        setTokens(res.data.tokens.accessToken, res.data.tokens.refreshToken);
        setState({
          user: res.data.user,
          loading: false,
          authenticated: true,
        });
        return {};
      }
      return { error: res.error?.message || "Registration failed" };
    },
    []
  );

  const logout = useCallback(() => {
    apiLogout();
    setState({ user: null, loading: false, authenticated: false });
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
