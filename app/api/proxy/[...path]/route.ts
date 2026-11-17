import { type NextRequest, NextResponse } from "next/server";

function getDjangoOrigin(): string {
  const raw = (process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "").trim();
  return raw.replace(/\/+$/, "");
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
]);

// accept-encoding: Node fetch javobni o'zi ochadi (decompress), shuning uchun upstream'dan siqilmagan javob so'raymiz
const EXCLUDE_HEADERS = new Set([...HOP_BY_HOP, "host", "cookie", "accept-encoding"]);
// body allaqachon ochilgan — eski content-encoding/content-length brauzerni chalg'itadi
const EXCLUDE_RESPONSE_HEADERS = new Set([...HOP_BY_HOP, "content-encoding", "content-length"]);

async function handler(req: NextRequest) {
  const origin = getDjangoOrigin();
  if (!origin) {
    return NextResponse.json(
      { detail: "API_URL не настроен на сервере." },
      { status: 502 },
    );
  }

  const rawPath = req.nextUrl.pathname.replace(/^\/api\/proxy/, "");
  const djangoPath = rawPath.endsWith("/") ? rawPath : `${rawPath}/`;
  // Faqat Django /api/ — /admin/ va boshqalar proksi orqali ochilmasin.
  // Tekshiruv normallashtirilgan URL bo'yicha (%2e%2e → .. ham hisobga olinadi).
  const upstreamParsed = new URL(`${origin}${djangoPath}${req.nextUrl.search}`);
  const basePath = new URL(origin).pathname.replace(/\/+$/, "");
  if (!upstreamParsed.pathname.startsWith(`${basePath}/api/`)) {
    return NextResponse.json({ detail: "Topilmadi." }, { status: 404 });
  }
  const upstreamUrl = upstreamParsed.toString();

  const forwardHeaders = new Headers();
  for (const [key, value] of req.headers) {
    if (!EXCLUDE_HEADERS.has(key.toLowerCase())) {
      forwardHeaders.set(key, value);
    }
  }

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const body = hasBody ? await req.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: forwardHeaders,
      body,
    });
  } catch (err) {
    console.warn("[proxy] upstream fetch failed:", err);
    return NextResponse.json(
      { detail: "Server bilan bog'lanib bo'lmadi. Keyinroq urinib ko'ring." },
      { status: 502 },
    );
  }

  const resHeaders = new Headers();
  for (const [key, value] of upstream.headers) {
    if (!EXCLUDE_RESPONSE_HEADERS.has(key.toLowerCase())) {
      resHeaders.set(key, value);
    }
  }

  return new NextResponse(upstream.body ?? null, {
    status: upstream.status,
    headers: resHeaders,
  });
}

export {
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
};
