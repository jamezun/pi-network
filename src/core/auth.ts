// Pi Network — Improvement #5: JWT Auth in Register Handshake
//
// OpenClaw is single-user and offers nothing here. We build standard JWT.
// The broker validates a token on `register`; rejects unauthenticated
// connections when `requireAuth` is on (consumer mode). Tokens carry
// userId + tier + rate-limit entitlements.
//
// Tailscale-trust remains a valid transport for self-hosted: when
// `requireAuth === false` (default), the token is optional and Tailscale
// identity is trusted instead.

import { createHmac, timingSafeEqual } from "node:crypto";

export type AuthTier = "free" | "pro" | "power";

export interface TokenClaims {
  userId: string;
  tier: AuthTier;
  /** Per-minute message cap entitlement (-1 = unlimited). */
  rateLimitPerMin: number;
  iat: number;   // issued at (seconds)
  exp: number;   // expiry (seconds)
}

export interface AuthConfig {
  /** Shared HMAC secret for signing/verifying tokens. */
  secret: string;
  /** When true, connections without a valid token are rejected. */
  requireAuth: boolean;
  /** Allowed clock skew in seconds (default 30). */
  leewaySeconds?: number;
}

export class AuthError extends Error {}

const B64U = (s: string): string => Buffer.from(s, "base64url").toString("utf8");
const toB64U = (buf: Buffer | string): string => Buffer.from(buf).toString("base64url");

/** Sign a token. `ttlSeconds` defaults to 24h. */
export function signToken(claims: Omit<TokenClaims, "iat" | "exp">, secret: string, ttlSeconds = 86400): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: TokenClaims = { ...claims, iat: now, exp: now + ttlSeconds };
  const header = toB64U(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = toB64U(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const sig = createHmac("sha256", secret).update(data).digest();
  return `${data}.${toB64U(sig)}`;
}

/** Verify + decode a token. Throws AuthError on any failure. */
export function verifyToken(token: string, config: AuthConfig): TokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("Malformed token");
  const data = `${parts[0]}.${parts[1]}`;
  const expected = createHmac("sha256", config.secret).update(data).digest();
  const actual = Buffer.from(parts[2], "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new AuthError("Invalid signature");
  }
  let claims: TokenClaims;
  try {
    claims = JSON.parse(B64U(parts[1]));
  } catch {
    throw new AuthError("Unparsable claims");
  }
  if (typeof claims.exp !== "number" || typeof claims.userId !== "string") {
    throw new AuthError("Missing required claims");
  }
  const leeway = config.leewaySeconds ?? 30;
  const now = Math.floor(Date.now() / 1000);
  if (now > claims.exp + leeway) throw new AuthError("Token expired");
  return claims;
}

/**
 * Gate a register attempt. Returns claims on success.
 * - When requireAuth is false and no token is given → returns null (legacy/Tailscale trust).
 * - When requireAuth is true and token is missing/invalid → throws AuthError.
 */
export function authorizeRegister(
  token: string | undefined,
  config: AuthConfig,
): TokenClaims | null {
  if (!token) {
    if (config.requireAuth) throw new AuthError("Authentication required");
    return null; // trusted transport (Tailscale) / single-user mode
  }
  return verifyToken(token, config);
}

/** Simple in-memory rate limiter keyed by userId. */
export class RateLimiter {
  private buckets = new Map<string, { count: number; windowStart: number }>();
  constructor(private windowMs = 60_000) {}

  check(userId: string, limitPerMin: number): boolean {
    if (limitPerMin < 0) return true; // unlimited
    const now = Date.now();
    let bucket = this.buckets.get(userId);
    if (!bucket || now - bucket.windowStart > this.windowMs) {
      bucket = { count: 0, windowStart: now };
      this.buckets.set(userId, bucket);
    }
    if (bucket.count >= limitPerMin) return false;
    bucket.count++;
    return true;
  }
}
