/**
 * 密码门决策（纯函数）。
 *
 * 测试环境是 node、没有 jsdom，所以「弹层开不开、能不能被关掉」放在这里，
 * 组件只负责按这个结果渲染。这里没有「用户已经关掉」这种输入：
 * 未验证时调用方把 requestedOpen 清成 false（遮罩 / Esc / 关闭按钮都会这么做）
 * 也不能把弹层卸掉。
 */

export interface AuthGateInput {
  /**
   * 服务器是否配置了 PASSWORD。
   * null 表示 /api/status 还没给出结论（初始值，或状态请求失败）。
   */
  passwordRequired: boolean | null;
  verified: boolean;
  /** 服务器明确未配置 PASSWORD（status 推导，或 503） */
  setupRequired: boolean;
  /** 401/503 或用户主动 openLogin()。不是「弹层当前是否可见」。 */
  requestedOpen: boolean;
}

export interface AuthGateDecision {
  /** 登录框 / 配置密码说明必须挂载 */
  open: boolean;
  /**
   * false 时遮罩点击、Escape、以及任何关闭控件都不得卸掉弹层。
   * 只有「已经验证、用户又主动打开」才为 true。
   */
  dismissible: boolean;
}

/** 遮罩、Escape、关闭按钮共用这一判断。 */
export function canDismissAuthModal(decision: AuthGateDecision): boolean {
  return decision.open && decision.dismissible;
}

export function resolveAuthGate(input: AuthGateInput): AuthGateDecision {
  // 未配置 PASSWORD：只能看配置说明，不能进主界面，也不能关掉。
  // passwordRequired === false 与 setupRequired 是同一事实的两种来源（status / 503）。
  if (input.setupRequired || input.passwordRequired === false) {
    return { open: true, dismissible: false };
  }

  // 已确认需要密码且当前会话未验证：首屏就要弹，点遮罩 / Esc 都关不掉。
  if (input.passwordRequired === true && !input.verified) {
    return { open: true, dismissible: false };
  }

  // 策略还未知，但接口已经 401：先锁上，避免等状态接口期间把主界面用起来。
  if (input.requestedOpen && !input.verified) {
    return { open: true, dismissible: false };
  }

  // 已登录后的主动打开（例如导出前复查）可以关掉。
  if (input.requestedOpen && input.verified) {
    return { open: true, dismissible: true };
  }

  return { open: false, dismissible: false };
}

/** /api/status 成功体 → 密码门输入（不含 requestedOpen，由组件保留）。 */
export function gateInputFromStatus(status: { passwordRequired: boolean; verified: boolean }): Omit<
  AuthGateInput,
  'requestedOpen'
> {
  return {
    passwordRequired: status.passwordRequired,
    verified: status.verified,
    setupRequired: !status.passwordRequired,
  };
}

/**
 * 401/503 全局事件 → 密码门输入。
 * 401 说明 PASSWORD 已配置（未配置时服务端返回的是 503），因此顺便记上 passwordRequired，
 * 这样随后把 requestedOpen 清掉也不会把门打开。
 */
export function gateInputFromUnauthorized(detail: unknown): AuthGateInput {
  const setup = detail === 'setup';
  return {
    passwordRequired: !setup,
    verified: false,
    setupRequired: setup,
    requestedOpen: true,
  };
}

/**
 * 当前会话已被 /api/status 或登录接口确认为已验证时，又收到 401：
 * 先重新请求 /api/status 再决定要不要上锁。
 * 登录前发出的推荐/搜索可能在 Set-Cookie 之后才返回 401，直接上锁会把刚登录成功的用户再次关在外面。
 * 503（未配置密码）不复核，立刻锁住。
 */
export function shouldRecheckSessionBeforeLock(currentlyVerified: boolean, detail: unknown): boolean {
  return currentlyVerified && detail !== 'setup';
}
