import { createHmac, timingSafeEqual } from "crypto";
import type { NextRequest, NextResponse } from "next/server";

export const APP_SESSION_COOKIE = "fp_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

function appPassword(): string | null {
  const value = process.env.APP_PASSWORD?.trim();
  return value && value.length >= 8 ? value : null;
}

function authSecret(): string | null {
  const value = process.env.AUTH_SECRET?.trim();
  return value && value.length >= 32 ? value : null;
}

export function isAppAuthConfigured(): boolean {
  return appPassword() !== null && authSecret() !== null;
}

function currentSessionToken(): string | null {
  const signingSecret = authSecret();
  if (!signingSecret) return null;
  return createHmac("sha256", signingSecret)
    .update("freeparking-session-v2")
    .digest("base64url");
}

// v1 세션은 앱 비밀번호를 토큰 재료로 사용했다. 이미 설치된 앱의 30일
// 세션을 끊지 않기 위해 마이그레이션 기간 동안 기존 토큰도 계속 허용한다.
function legacySessionToken(): string | null {
  const password = appPassword();
  const signingSecret = authSecret();
  if (!password || !signingSecret) return null;
  return createHmac("sha256", signingSecret)
    .update(`freeparking-session-v1:${password}`)
    .digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyAppPassword(candidate: string): boolean {
  const password = appPassword();
  return password !== null && safeEqual(candidate, password);
}

export function isAppAuthorized(req: NextRequest): boolean {
  const incoming = req.cookies.get(APP_SESSION_COOKIE)?.value ?? "";
  const acceptedTokens = [currentSessionToken(), legacySessionToken()]
    .filter((token): token is string => token !== null);
  return acceptedTokens.some((token) => safeEqual(incoming, token));
}

export function setAppSession(response: NextResponse): void {
  const token = currentSessionToken();
  if (!token) throw new Error("앱 인증 환경 변수가 설정되지 않았습니다.");
  response.cookies.set(APP_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
}

export function clearAppSession(response: NextResponse): void {
  response.cookies.set(APP_SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}
