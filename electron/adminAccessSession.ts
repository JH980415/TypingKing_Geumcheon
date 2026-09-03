import { createHash, timingSafeEqual } from "node:crypto";

export const REVIEW_LOCAL_ADMIN_PASSWORD = "0208";

export function resolveAdminPasswordForRuntime(
  configuredPassword: string,
  environment?: string
): string {
  return environment === "review" ? REVIEW_LOCAL_ADMIN_PASSWORD : configuredPassword;
}

export type AdminAccessSender = {
  id: number;
  once(event: "destroyed", listener: () => void): unknown;
};

type AdminSession = { adminName: string; expiresAt: number };

export class AdminAccessSessions {
  private readonly password: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly sessions = new Map<number, AdminSession>();
  private readonly observedSenders = new WeakSet<object>();

  constructor(options: { password: string; ttlMs: number; now?: () => number }) {
    const normalizedPassword = typeof options.password === "string"
      ? options.password.trim()
      : "";
    if (
      normalizedPassword.length === 0
      || normalizedPassword === "CHANGE_ME_BEFORE_EVENT"
    ) {
      throw new Error("ADMIN_PASSWORD_INVALID");
    }
    if (
      !Number.isSafeInteger(options.ttlMs)
      || options.ttlMs < 1_000
      || options.ttlMs > 60 * 60 * 1000
    ) {
      throw new Error("ADMIN_SESSION_TTL_INVALID");
    }
    this.password = options.password;
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
  }

  authenticate(
    sender: AdminAccessSender,
    password: string,
    adminName?: string
  ): { ok: true; adminName: string } | { ok: false } {
    const normalizedName = normalizeAdminName(adminName);
    if (!secureEqual(password, this.password) || normalizedName == null) {
      this.sessions.delete(sender.id);
      return { ok: false };
    }
    this.sessions.set(sender.id, {
      adminName: normalizedName,
      expiresAt: this.now() + this.ttlMs
    });
    if (!this.observedSenders.has(sender)) {
      this.observedSenders.add(sender);
      sender.once("destroyed", () => this.sessions.delete(sender.id));
    }
    return { ok: true, adminName: normalizedName };
  }

  require(sender: Pick<AdminAccessSender, "id">): { adminName: string } {
    const session = this.sessions.get(sender.id);
    if (session == null || session.expiresAt <= this.now()) {
      this.sessions.delete(sender.id);
      throw new AdminAccessError();
    }
    return { adminName: session.adminName };
  }
}

export class AdminAccessError extends Error {
  constructor() {
    super("관리자 인증이 필요하거나 만료되었습니다. 다시 로그인해 주세요.");
    this.name = "ADMIN_AUTH_REQUIRED";
  }
}

function normalizeAdminName(value: string | undefined): string | null {
  const name = value?.trim() || "admin";
  if (name.length > 40 || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

function secureEqual(left: unknown, right: string): boolean {
  if (typeof left !== "string") return false;
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest)
    && Buffer.byteLength(left) === Buffer.byteLength(right);
}
