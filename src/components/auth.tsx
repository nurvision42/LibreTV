'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, onUnauthorized, STATUS_QUERY_KEY } from '@/lib/client-api';
import {
  canDismissAuthModal,
  gateInputFromStatus,
  gateInputFromUnauthorized,
  resolveAuthGate,
  shouldRecheckSessionBeforeLock,
} from '@/lib/auth-gate';
import { applyEnvPresets } from '@/lib/subscription-sync';
import type { AuthStatusResponse } from '@/lib/types';
import { useToast } from './toast';

/**
 * 认证上下文：
 * - 页面加载时查询 /api/status；PASSWORD 已配置且会话未验证时立刻强制打开登录框，
 *   不等待后续接口 401；
 * - 未验证，或服务器未配置 PASSWORD 时，登录框不能靠遮罩、Escape 或关闭控件卸掉，
 *   背后的主界面同时 inert，不能把站点当成已登录在用；
 * - 任何 API 返回 401/503 时同样锁住（客户端 API 层统一触发）。
 */

type SetupRequired = boolean;

interface AuthContextValue {
  checked: boolean;
  verified: boolean;
  /** 服务器未设置 PASSWORD，需要管理员配置 */
  setupRequired: SetupRequired;
  /** /api/status 返回的应用版本（构建时从 package.json 注入） */
  version: string | null;
  openLogin: () => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  checked: false,
  verified: false,
  setupRequired: false,
  version: null,
  openLogin: () => {},
  logout: async () => {},
});

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

/** 弹层内可聚焦元素（焦点循环，避免 Tab 逃到背后的搜索框） */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [checked, setChecked] = useState(false);
  const [verified, setVerified] = useState(false);
  const [setupRequired, setSetupRequired] = useState(false);
  /** null：/api/status 还没说明是否配置了 PASSWORD */
  const [passwordRequired, setPasswordRequired] = useState<boolean | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const verifiedRef = useRef(false);
  verifiedRef.current = verified;

  // 与 Providers 共用同一 query key 与缓存，避免 /api/status 被请求两次
  useEffect(() => {
    let cancelled = false;
    queryClient
      .fetchQuery({ queryKey: STATUS_QUERY_KEY, queryFn: () => api.status() })
      .then((s) => {
        if (cancelled) return;
        const next = gateInputFromStatus(s);
        setVerified(next.verified);
        setPasswordRequired(next.passwordRequired);
        setSetupRequired(next.setupRequired);
        setVersion(s.version);
        setChecked(true);
      })
      .catch(() => {
        if (!cancelled) setChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [queryClient]);

  useEffect(
    () =>
      onUnauthorized((event) => {
        const detail = (event as CustomEvent).detail;
        const next = gateInputFromUnauthorized(detail);
        const apply = () => {
          setSetupRequired(next.setupRequired);
          setPasswordRequired(next.passwordRequired);
          setVerified(next.verified);
          setModalOpen(next.requestedOpen);
        };
        // 登录前发出的请求可能在登录成功后才 401。此时会话 cookie 已生效，
        // 向 /api/status 复核，避免把刚进来的用户再次锁在不可关闭的登录框里。
        if (shouldRecheckSessionBeforeLock(verifiedRef.current, detail)) {
          void api
            .status()
            .then((s) => {
              if (!s.verified) apply();
            })
            .catch(() => apply());
          return;
        }
        apply();
      }),
    []
  );

  const gate = useMemo(
    () =>
      resolveAuthGate({
        passwordRequired,
        verified,
        setupRequired,
        requestedOpen: modalOpen,
      }),
    [passwordRequired, verified, setupRequired, modalOpen]
  );

  const openLogin = useCallback(() => setModalOpen(true), []);

  // 遮罩、Esc、关闭控件最终都进这里。未验证时 canDismiss 为 false，
  // 而且即便 modalOpen 被清掉，resolveAuthGate 仍会要求弹层保持挂载。
  const requestClose = useCallback(() => {
    if (!canDismissAuthModal(gate)) return;
    setModalOpen(false);
  }, [gate]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setVerified(false);
      toast('已退出登录', 'info');
    }
  }, [toast]);

  const handleLoginSuccess = useCallback(async () => {
    setVerified(true);
    // 登录成功即说明 PASSWORD 已配置；status 若此前失败，也不能漏掉这个事实
    setPasswordRequired(true);
    setSetupRequired(false);
    setModalOpen(false);
    // 登录前以 401 失败的查询（如豆瓣推荐）需要重新拉取
    queryClient.invalidateQueries();
    toast('验证成功', 'success');
    // 预置订阅（DEFAULT_SUBSCRIPTIONS）的首屏同步发生在登录之前，会 401 静默失败，
    // 这里用缓存中的 /api/status 补跑一次（缓存缺失时回落为一次请求）
    try {
      const cached = queryClient.getQueryData<AuthStatusResponse>(STATUS_QUERY_KEY);
      const status =
        cached ??
        (await queryClient.fetchQuery<AuthStatusResponse>({
          queryKey: STATUS_QUERY_KEY,
          queryFn: () => api.status(),
          staleTime: 0,
        }));
      if (status) await applyEnvPresets(status);
    } catch {
      // 补拉预置数据失败不影响登录后的正常使用
    }
  }, [toast, queryClient]);

  const locked = gate.open && !gate.dismissible;

  return (
    <AuthContext.Provider value={{ checked, verified, setupRequired, version, openLogin, logout }}>
      {/* 未验证时主界面不接收指针和键盘；弹层是兄弟节点，不受 inert 影响 */}
      <div
        inert={locked ? true : undefined}
        aria-hidden={locked ? true : undefined}
        className={locked ? 'pointer-events-none' : undefined}
      >
        {children}
      </div>
      {/* 是否挂载只看 resolveAuthGate。setModalOpen(false) 在未验证时不会卸掉弹层。 */}
      {gate.open && (
        <LoginModal
          setupRequired={setupRequired || passwordRequired === false}
          dismissible={gate.dismissible}
          onSuccess={handleLoginSuccess}
          onClose={requestClose}
        />
      )}
    </AuthContext.Provider>
  );
}

function LoginModal({
  setupRequired,
  dismissible,
  onSuccess,
  onClose,
}: {
  setupRequired: boolean;
  dismissible: boolean;
  onSuccess: () => void;
  onClose: () => void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;

  useEffect(() => {
    if (inputRef.current) inputRef.current.focus();
    else panelRef.current?.focus();
  }, [setupRequired]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 捕获阶段拦住，避免 Esc 先把背后的抽屉/搜索历史关掉，或在未验证时被当成关闭。
        e.preventDefault();
        e.stopPropagation();
        if (canDismissAuthModal({ open: true, dismissible: dismissibleRef.current })) onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0 || el === document.activeElement
      );
      if (nodes.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onClose]);

  const submit = async () => {
    if (!password.trim() || loading) return;
    setLoading(true);
    setError('');
    try {
      await api.login(password);
      onSuccess();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '验证失败';
      setError(msg === '需要登录' ? '密码错误' : msg);
      setPassword('');
      inputRef.current?.focus();
    } finally {
      setLoading(false);
    }
  };

  const onBackdropClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    e.stopPropagation();
    // 未验证时点遮罩只是把焦点留在密码框里，不能卸掉弹层。
    if (!canDismissAuthModal({ open: true, dismissible })) {
      inputRef.current?.focus();
      return;
    }
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/80 animate-fade-in overscroll-none"
      onMouseDown={(e) => {
        // 阻止点击穿透到背后的搜索框（移动端松手时元素已卸掉会把同一次点击交下去）
        if (e.target === e.currentTarget) e.preventDefault();
      }}
      onClick={onBackdropClick}
    >
      <div
        ref={panelRef}
        className="bg-surface-raised rounded-xl p-6 w-full max-w-sm mx-4 shadow-2xl outline-none"
        role="dialog"
        aria-modal="true"
        aria-label={setupRequired ? '需要配置密码' : '访问验证'}
        tabIndex={-1}
      >
        {setupRequired ? (
          <>
            <h2 className="text-lg font-semibold text-content mb-3">需要配置密码</h2>
            <p className="text-sm text-muted leading-relaxed">
              为确保安全，必须设置 <code className="text-accent">PASSWORD</code> 环境变量才能使用本服务。
              请联系管理员在部署配置中添加该变量后重启服务。
            </p>
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold text-content mb-1">访问验证</h2>
            <p className="text-sm text-muted mb-4">请输入密码继续访问</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <input
                ref={inputRef}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input w-full"
                placeholder="密码"
                autoComplete="current-password"
              />
              {error && <p className="mt-2 text-sm text-danger">{error}</p>}
              <button type="submit" className="btn-primary w-full mt-4" disabled={loading || !password.trim()}>
                {loading ? '验证中...' : '进入'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
