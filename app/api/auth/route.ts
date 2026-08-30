import { NextRequest, NextResponse } from "next/server";
import {
  clearAppSession,
  isAppAuthorized,
  isAppAuthConfigured,
  setAppSession,
  verifyAppPassword,
} from "@/lib/api-auth";
import { loginRateLimiter } from "@/lib/login-rate-limit";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function hasServerParkingSettings(): boolean {
  return [process.env.NICEPARK_URL, process.env.NICEPARK_ID, process.env.NICEPARK_PW]
    .every((value) => Boolean(value?.trim()));
}

export async function GET(req: NextRequest) {
  const authenticated = isAppAuthorized(req);
  return NextResponse.json(
    {
      authenticated,
      configured: isAppAuthConfigured(),
      parkingConfigured: authenticated && hasServerParkingSettings(),
    },
    { headers: NO_STORE_HEADERS }
  );
}

export async function POST(req: NextRequest) {
  if (!isAppAuthConfigured()) {
    return NextResponse.json(
      { error: "서버 인증 설정이 필요합니다." },
      { status: 503, headers: NO_STORE_HEADERS }
    );
  }

  const clientKey = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("x-real-ip")
    || "unknown";
  const rate = loginRateLimiter.check(clientKey);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요." },
      { status: 429, headers: { ...NO_STORE_HEADERS, "Retry-After": String(rate.retryAfter) } }
    );
  }

  let password = "";
  try {
    const body = await req.json();
    password = typeof body?.password === "string" ? body.password : "";
  } catch {
    return NextResponse.json({ error: "요청 형식이 올바르지 않습니다." }, { status: 400 });
  }

  if (!password || password.length > 256 || !verifyAppPassword(password)) {
    loginRateLimiter.fail(clientKey);
    return NextResponse.json(
      { error: "비밀번호가 올바르지 않습니다." },
      { status: 401, headers: NO_STORE_HEADERS }
    );
  }

  loginRateLimiter.success(clientKey);
  const response = NextResponse.json(
    { authenticated: true, parkingConfigured: hasServerParkingSettings() },
    { headers: NO_STORE_HEADERS }
  );
  setAppSession(response);
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ authenticated: false }, { headers: NO_STORE_HEADERS });
  clearAppSession(response);
  return response;
}
