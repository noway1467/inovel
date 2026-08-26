export const loginGuardKey = "yuedu-login-guard";
export const maxLoginFailures = 5;
export const cooldownSeconds = 15 * 60;

export interface LoginGuardState {
  failedCount: number;
  blockedUntil: number;
}

export function loadLoginGuard(): LoginGuardState {
  try {
    const raw = localStorage.getItem(loginGuardKey);
    if (!raw) return { failedCount: 0, blockedUntil: 0 };
    const parsed = JSON.parse(raw) as Partial<LoginGuardState>;
    return {
      failedCount: typeof parsed.failedCount === "number" ? parsed.failedCount : 0,
      blockedUntil: typeof parsed.blockedUntil === "number" ? parsed.blockedUntil : 0,
    };
  } catch {
    return { failedCount: 0, blockedUntil: 0 };
  }
}

export function saveLoginGuard(state: LoginGuardState) {
  try {
    localStorage.setItem(loginGuardKey, JSON.stringify(state));
  } catch {
    // 隐私模式下忽略
  }
}

export function remainingBlockSeconds(): number {
  const state = loadLoginGuard();
  return Math.max(0, Math.ceil((state.blockedUntil - Date.now()) / 1000));
}

export function recordLocalLoginFailure() {
  const state = loadLoginGuard();
  const nextCount = state.failedCount + 1;
  const blockedUntil = nextCount >= maxLoginFailures ? Date.now() + cooldownSeconds * 1000 : state.blockedUntil;
  saveLoginGuard({ failedCount: nextCount, blockedUntil });
  return { failedCount: nextCount, blockedUntil };
}

export function clearLocalLoginFailures() {
  saveLoginGuard({ failedCount: 0, blockedUntil: 0 });
}

