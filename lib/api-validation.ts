import type { CarInput } from "./register";

export type ParkingSettings = { url: string; id: string; pw: string };

const MAX_CARS_PER_REQUEST = 30;
const ALLOWED_TICKET_CODES = new Set(["00005", "00004", "00002", "00001"]);

export class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestValidationError(`${field} 형식이 올바르지 않습니다.`);
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") {
    throw new RequestValidationError(`${field} 값이 필요합니다.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new RequestValidationError(`${field} 길이가 올바르지 않습니다.`);
  }
  return normalized;
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] === 0
  );
}

export function validateParkingUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new RequestValidationError("주차 시스템 URL이 올바르지 않습니다.");
  }

  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new RequestValidationError("주차 시스템 URL은 인증정보가 없는 HTTP(S) 주소여야 합니다.");
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "::1" ||
    hostname === "0:0:0:0:0:0:0:1" ||
    isPrivateIpv4(hostname)
  ) {
    throw new RequestValidationError("내부 네트워크 주소는 주차 시스템 URL로 사용할 수 없습니다.");
  }

  const allowedHosts = new Set(
    (process.env.NICEPARK_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean)
  );
  if (process.env.NICEPARK_URL) {
    try {
      allowedHosts.add(new URL(process.env.NICEPARK_URL).hostname.toLowerCase());
    } catch {}
  }
  if (allowedHosts.size > 0 && !allowedHosts.has(hostname)) {
    throw new RequestValidationError("허용되지 않은 주차 시스템 호스트입니다.");
  }

  return parsed.href;
}

export function parseParkingSettings(input: unknown): ParkingSettings {
  const settings = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const url = process.env.NICEPARK_URL || (
    typeof settings.url === "string" && settings.url.trim() ? settings.url : undefined
  );
  const id = process.env.NICEPARK_ID || (
    typeof settings.id === "string" && settings.id.trim() ? settings.id : undefined
  );
  const pw = process.env.NICEPARK_PW || (
    typeof settings.pw === "string" && settings.pw ? settings.pw : undefined
  );

  return {
    url: validateParkingUrl(boundedString(url, "사이트 URL", 2048)),
    id: boundedString(id, "관리자 아이디", 128),
    pw: boundedString(pw, "관리자 비밀번호", 256),
  };
}

function validPlate(value: unknown): string {
  const plate = boundedString(value, "차량번호", 20).replace(/\s+/g, "").toUpperCase();
  if (plate.length < 4 || !/^[0-9A-Z가-힣-]+$/.test(plate)) {
    throw new RequestValidationError("차량번호 형식이 올바르지 않습니다.");
  }
  return plate;
}

export function parseCars(input: unknown): CarInput[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_CARS_PER_REQUEST) {
    throw new RequestValidationError(`차량은 1~${MAX_CARS_PER_REQUEST}대까지 요청할 수 있습니다.`);
  }
  const seen = new Set<string>();
  return input.map((item) => {
    const car = objectValue(item, "차량");
    const plate = validPlate(car.plate);
    if (seen.has(plate)) throw new RequestValidationError(`중복 차량번호가 있습니다: ${plate}`);
    seen.add(plate);
    const label = typeof car.label === "string" ? car.label.trim().slice(0, 80) : "";
    const ticketChoice = typeof car.ticketChoice === "string" ? car.ticketChoice : undefined;
    if (ticketChoice && !ALLOWED_TICKET_CODES.has(ticketChoice)) {
      throw new RequestValidationError("지원하지 않는 주차권 종류입니다.");
    }
    return { plate, label, ticketChoice };
  });
}

export function parsePlates(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_CARS_PER_REQUEST) {
    throw new RequestValidationError(`차량은 1~${MAX_CARS_PER_REQUEST}대까지 조회할 수 있습니다.`);
  }
  const plates = input.map(validPlate);
  if (new Set(plates).size !== plates.length) {
    throw new RequestValidationError("중복 차량번호가 있습니다.");
  }
  return plates;
}

export function parseSelectedJson(input: unknown, cars: CarInput[]): Record<string, number> {
  if (input === undefined || input === null) return {};
  const raw = objectValue(input, "차량 선택값");
  const allowedPlates = new Set(cars.map((car) => car.plate));
  const result: Record<string, number> = {};
  for (const [plate, value] of Object.entries(raw)) {
    if (!allowedPlates.has(plate) || !Number.isInteger(value) || Number(value) < 0 || Number(value) > 20) {
      throw new RequestValidationError("차량 선택값이 올바르지 않습니다.");
    }
    result[plate] = Number(value);
  }
  return result;
}
