import { describe, expect, it } from 'vitest';
import {
  canDismissAuthModal,
  gateInputFromStatus,
  gateInputFromUnauthorized,
  resolveAuthGate,
  shouldRecheckSessionBeforeLock,
  type AuthGateInput,
} from './auth-gate';

/**
 * 密码门：未验证时登录框必须开着，且遮罩 / Esc / 关闭控件都不能把它关掉。
 * 组件（src/components/auth.tsx）只消费这里的决策，不另写一套关闭条件。
 */

function gate(partial: Partial<AuthGateInput> = {}) {
  return resolveAuthGate({
    passwordRequired: null,
    verified: false,
    setupRequired: false,
    requestedOpen: false,
    ...partial,
  });
}

describe('resolveAuthGate', () => {
  it('首屏 /api/status 尚未返回时不弹登录框', () => {
    expect(gate()).toEqual({ open: false, dismissible: false });
  });

  it('状态请求失败且还没有 401 时不凭空上锁', () => {
    // passwordRequired 保持 null，verified 仍是初始 false
    expect(gate({ passwordRequired: null, verified: false, requestedOpen: false }).open).toBe(false);
  });

  it('PASSWORD 已配置且未验证：强制打开，且不能关闭', () => {
    const decision = gate({ passwordRequired: true, verified: false, requestedOpen: false });
    expect(decision).toEqual({ open: true, dismissible: false });
    expect(canDismissAuthModal(decision)).toBe(false);
  });

  it('遮罩 / Esc / 关闭按钮把 requestedOpen 清掉后，密码门仍然开着', () => {
    const before = gate({ passwordRequired: true, verified: false, requestedOpen: true });
    // 这三处关闭动作在组件里最终都只是 setModalOpen(false) → requestedOpen false
    const afterDismissAttempt = gate({ passwordRequired: true, verified: false, requestedOpen: false });
    expect(canDismissAuthModal(before)).toBe(false);
    expect(afterDismissAttempt).toEqual({ open: true, dismissible: false });
    expect(canDismissAuthModal(afterDismissAttempt)).toBe(false);
  });

  it('登录成功后弹层关闭', () => {
    expect(gate({ passwordRequired: true, verified: true, requestedOpen: false })).toEqual({
      open: false,
      dismissible: false,
    });
  });

  it('退出登录（会话失效）后重新锁上，不依赖再次点击', () => {
    expect(gate({ passwordRequired: true, verified: false, requestedOpen: false })).toEqual({
      open: true,
      dismissible: false,
    });
  });

  it('已验证用户主动打开时可以关闭', () => {
    const decision = gate({ passwordRequired: true, verified: true, requestedOpen: true });
    expect(decision).toEqual({ open: true, dismissible: true });
    expect(canDismissAuthModal(decision)).toBe(true);
  });

  it('未配置 PASSWORD：锁在配置说明上，不能进主界面', () => {
    expect(
      gate({ passwordRequired: false, verified: false, setupRequired: true, requestedOpen: false })
    ).toEqual({ open: true, dismissible: false });
  });

  it('仅 setupRequired（503 先到、status 还没到）同样不可关闭', () => {
    expect(gate({ passwordRequired: null, setupRequired: true, verified: false, requestedOpen: false })).toEqual({
      open: true,
      dismissible: false,
    });
  });
});

describe('gateInputFromStatus', () => {
  it('passwordRequired 且未验证 → 首屏就要弹出且不可关闭', () => {
    const input = gateInputFromStatus({ passwordRequired: true, verified: false });
    expect(input).toEqual({ passwordRequired: true, verified: false, setupRequired: false });
    expect(resolveAuthGate({ ...input, requestedOpen: false })).toEqual({ open: true, dismissible: false });
  });

  it('已验证 → 不弹框', () => {
    const input = gateInputFromStatus({ passwordRequired: true, verified: true });
    expect(resolveAuthGate({ ...input, requestedOpen: false }).open).toBe(false);
  });

  it('未配置密码 → 配置说明且不可关闭', () => {
    const input = gateInputFromStatus({ passwordRequired: false, verified: false });
    expect(input.setupRequired).toBe(true);
    expect(resolveAuthGate({ ...input, requestedOpen: false })).toEqual({ open: true, dismissible: false });
  });
});

describe('gateInputFromUnauthorized', () => {
  it('401 记为需要密码，随后清掉 requestedOpen 仍然锁住', () => {
    const input = gateInputFromUnauthorized(undefined);
    expect(input).toEqual({
      passwordRequired: true,
      verified: false,
      setupRequired: false,
      requestedOpen: true,
    });
    expect(resolveAuthGate(input)).toEqual({ open: true, dismissible: false });
    expect(resolveAuthGate({ ...input, requestedOpen: false })).toEqual({ open: true, dismissible: false });
  });

  it('已验证会话上的 401 先复核，避免登录前的请求把刚成功的登录再次锁住', () => {
    expect(shouldRecheckSessionBeforeLock(true, undefined)).toBe(true);
    expect(shouldRecheckSessionBeforeLock(true, 'setup')).toBe(false);
    expect(shouldRecheckSessionBeforeLock(false, undefined)).toBe(false);
  });

  it('503（detail=setup）锁在配置说明，不能当成可关闭的登录框', () => {
    const input = gateInputFromUnauthorized('setup');
    expect(input.setupRequired).toBe(true);
    expect(input.passwordRequired).toBe(false);
    expect(resolveAuthGate(input)).toEqual({ open: true, dismissible: false });
    expect(canDismissAuthModal(resolveAuthGate({ ...input, requestedOpen: false }))).toBe(false);
  });
});
