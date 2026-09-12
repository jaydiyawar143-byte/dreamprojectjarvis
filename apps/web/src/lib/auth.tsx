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
  setAccessToken,
  setRemember,
  bootstrapSession,
  clearTokens,
  logout as apiLogout,
  type SafeUser,
} from "./api";

interface AuthState {
  user: SafeUser | null;
  loading: boolean;
  authenticated: boolean;
}

/**
 * What a failed auth attempt reports back.
 *
 * `code` travels alongside the message because the two say different things and
 * the UI must distinguish them: `AUTHENTICATION_REQUIRED` means the credentials
 * were rejected, `NETWORK_ERROR` means the request never reached a server. A
 * screen that only has the message has to guess, and guessing wrong tells
 * someone to re-type a password that was never the problem.
 */
export interface AuthFailure {
  error?: string;
  /** The API envelope's error code, when there was a response at all. */
  code?: string;
}

interface AuthContextType extends AuthState {
  login: (
    email: string,
    password: string,
    rememberMe?: boolean
  ) => Promise<AuthFailure>;
  register: (
    email: string,
    name: string,
    password: string,
    rememberMe?: boolean
  ) => Promise<AuthFailure>;
  /** Picks up a session created by an OAuth redirect. */
  adoptSession: () => Promise<AuthFailure>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    loading: true,
    authenticated: false,
  });

  // -------------------------------------------------------------------------
  // Session restore.
  //
  // There is nothing in web storage to read any more. The browser holds an
  // HttpOnly refresh cookie this code cannot see, so the only way to learn
  // whether a session exists is to present it: bootstrapSession() asks the API
  // to exchange the cookie for an access token.
  //
  // `loading` stays true for the whole exchange, which is what RequireAuth
  // waits on — a returning user must never be bounced to /login while their
  // perfectly valid cookie is still being redeemed.
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const restored = await bootstrapSession();
      if (cancelled) return;

      if (!restored) {
        setState({ user: null, loading: false, authenticated: false });
        return;
      }

      const res = await getMe();
      if (cancelled) return;

      if (res.success && res.data) {
        setState({ user: res.data, loading: false, authenticated: true });
      } else {
        clearTokens();
        setState({ user: null, loading: false, authenticated: false });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(
    async (email: string, password: string, rememberMe = true) => {
      const res = await apiLogin(email, password, rememberMe);
      if (res.success && res.data) {
        // Only the access token exists on this side; the refresh token went
        // into an HttpOnly cookie and is deliberately unreachable from here.
        setAccessToken(res.data.tokens.accessToken);
        setRemember(rememberMe);
        setState({
          user: res.data.user,
          loading: false,
          authenticated: true,
        });
        return {};
      }
      return {
        error: res.error?.message || "Login failed",
        ...(res.error?.code ? { code: res.error.code } : {}),
      };
    },
    []
  );

  const register = useCallback(
    async (email: string, name: string, password: string, rememberMe = true) => {
      const res = await apiRegister(email, name, password, rememberMe);
      if (res.success && res.data) {
        setAccessToken(res.data.tokens.accessToken);
        setRemember(rememberMe);
        setState({
          user: res.data.user,
          loading: false,
          authenticated: true,
        });
        return {};
      }
      return {
        error: res.error?.message || "Registration failed",
        ...(res.error?.code ? { code: res.error.code } : {}),
      };
    },
    []
  );

  /**
   * Adopts a session established outside the form — the Google callback lands
   * on a page that already holds a valid cookie, so it restores rather than
   * re-authenticates.
   */
  const adoptSession = useCallback(async () => {
    const restored = await bootstrapSession();
    if (!restored) return { error: "Could not establish a session" };

    const res = await getMe();
    if (res.success && res.data) {
      setRemember(true);
      setState({ user: res.data, loading: false, authenticated: true });
      return {};
    }
    clearTokens();
    return {
      error: res.error?.message || "Could not load your account",
      ...(res.error?.code ? { code: res.error.code } : {}),
    };
  }, []);

  // Revokes server-side before dropping local state, so the refresh token
  // cannot outlive the logout.
  const logout = useCallback(async () => {
    await apiLogout();
    setState({ user: null, loading: false, authenticated: false });
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, login, register, adoptSession, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
