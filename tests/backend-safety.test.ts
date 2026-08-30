import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { NextRequest, NextResponse } from "next/server";
import {
  parseCars,
  parsePlates,
  parseSelectedJson,
  RequestValidationError,
  validateParkingUrl,
} from "../lib/api-validation";
import { resolveUrl } from "../lib/ajpark-http";
import {
  APP_SESSION_COOKIE,
  isAppAuthConfigured,
  isAppAuthorized,
  setAppSession,
  verifyAppPassword,
} from "../lib/api-auth";
import { LoginRateLimiter } from "../lib/login-rate-limit";

test("parking URL blocks private and link-local targets", () => {
  for (const url of [
    "http://127.0.0.1:3000/login",
    "http://169.254.169.254/latest/meta-data",
    "http://192.168.0.10/login",
    "http://localhost:3000/login",
  ]) {
    assert.throws(() => validateParkingUrl(url), RequestValidationError);
  }
});

test("parking URL accepts a public HTTP(S) host", () => {
  assert.equal(validateParkingUrl("https://parking.example.com/login"), "https://parking.example.com/login");
});

test("redirect resolution cannot leave the configured origin", () => {
  assert.equal(
    resolveUrl("https://parking.example.com/login", "/discount/search"),
    "https://parking.example.com/discount/search"
  );
  assert.throws(
    () => resolveUrl("https://parking.example.com/login", "http://127.0.0.1/internal"),
    /차단/
  );
});

test("car input is normalized, bounded, and unique", () => {
  assert.deepEqual(parseCars([{ plate: " 12가 3456 ", label: " 방문 " }]), [
    { plate: "12가3456", label: "방문", ticketChoice: undefined },
  ]);
  assert.throws(
    () => parseCars(Array.from({ length: 31 }, (_, index) => ({ plate: `12가${String(index).padStart(4, "0")}` }))),
    RequestValidationError
  );
  assert.throws(
    () => parsePlates(["12가3456", "12가3456"]),
    RequestValidationError
  );
});

test("candidate selection only accepts a requested car and safe index", () => {
  const cars = parseCars([{ plate: "12가3456", label: "" }]);
  assert.deepEqual(parseSelectedJson({ "12가3456": 2 }, cars), { "12가3456": 2 });
  assert.throws(() => parseSelectedJson({ "99나9999": 0 }, cars), RequestValidationError);
  assert.throws(() => parseSelectedJson({ "12가3456": 99 }, cars), RequestValidationError);
});

test("app authentication fails closed without strong environment secrets", () => {
  const previousPassword = process.env.APP_PASSWORD;
  const previousSecret = process.env.AUTH_SECRET;
  try {
    delete process.env.APP_PASSWORD;
    delete process.env.AUTH_SECRET;
    assert.equal(isAppAuthConfigured(), false);
    assert.equal(verifyAppPassword("werwer1."), false);

    process.env.APP_PASSWORD = "a-secure-password";
    process.env.AUTH_SECRET = "0123456789abcdef0123456789abcdef";
    assert.equal(isAppAuthConfigured(), true);
    assert.equal(verifyAppPassword("a-secure-password"), true);
    assert.equal(verifyAppPassword("wrong-password"), false);
  } finally {
    if (previousPassword === undefined) delete process.env.APP_PASSWORD;
    else process.env.APP_PASSWORD = previousPassword;
    if (previousSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = previousSecret;
  }
});

test("existing installed-app sessions survive the session-token migration", () => {
  const previousPassword = process.env.APP_PASSWORD;
  const previousSecret = process.env.AUTH_SECRET;
  try {
    process.env.APP_PASSWORD = "a-secure-password";
    process.env.AUTH_SECRET = "0123456789abcdef0123456789abcdef";

    const legacyToken = createHmac("sha256", process.env.AUTH_SECRET)
      .update(`freeparking-session-v1:${process.env.APP_PASSWORD}`)
      .digest("base64url");
    const legacyRequest = new NextRequest("https://freeparking.example/", {
      headers: { cookie: `${APP_SESSION_COOKIE}=${legacyToken}` },
    });
    assert.equal(isAppAuthorized(legacyRequest), true);

    const response = NextResponse.json({ ok: true });
    setAppSession(response);
    const currentToken = response.cookies.get(APP_SESSION_COOKIE)?.value;
    assert.ok(currentToken);

    process.env.APP_PASSWORD = "a-changed-password";
    const currentRequest = new NextRequest("https://freeparking.example/", {
      headers: { cookie: `${APP_SESSION_COOKIE}=${currentToken}` },
    });
    assert.equal(isAppAuthorized(currentRequest), true);
  } finally {
    if (previousPassword === undefined) delete process.env.APP_PASSWORD;
    else process.env.APP_PASSWORD = previousPassword;
    if (previousSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = previousSecret;
  }
});

test("login rate limiter blocks repeated failures and resets after success", () => {
  const limiter = new LoginRateLimiter();
  const start = 1_000;
  for (let index = 0; index < 5; index += 1) limiter.fail("client", start);
  assert.equal(limiter.check("client", start).allowed, false);
  assert.equal(limiter.check("client", start + 15 * 60 * 1000).allowed, true);

  limiter.fail("client", start);
  limiter.success("client");
  assert.equal(limiter.check("client", start).allowed, true);
});
