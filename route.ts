import { env } from "cloudflare:workers";

export const runtime = "edge";

type AppEnv = {
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
};

const COOKIE_NAME = "bella_admin_session";
const SESSION_SECONDS = 8 * 60 * 60;
const appEnv = env as unknown as AppEnv;

function json(data: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(data, { status, headers });
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function textToBase64Url(value: string) {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function base64UrlToText(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

async function sign(value: string) {
  const secret = appEnv.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET inválido");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function createSession(email: string) {
  const payload = textToBase64Url(
    JSON.stringify({ email, expiresAt: Date.now() + SESSION_SECONDS * 1000 }),
  );
  return `${payload}.${await sign(payload)}`;
}

async function readSession(request: Request) {
  const cookie = request.headers.get("cookie") ?? "";
  const token = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);
  if (!token) return null;

  const [payload, signature] = token.split(".");
  if (!payload || !signature || signature !== (await sign(payload))) return null;

  try {
    const session = JSON.parse(base64UrlToText(payload)) as {
      email: string;
      expiresAt: number;
    };
    if (!session.email || session.expiresAt <= Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

function routePath(context: { params: Promise<{ path?: string[] }> }) {
  return context.params.then(({ path }) => (path ?? []).join("/"));
}

export async function GET(
  request: Request,
  context: { params: Promise<{ path?: string[] }> },
) {
  const path = await routePath(context);

  if (path === "session") {
    const session = await readSession(request);
    return json({
      authenticated: Boolean(session),
      admin: Boolean(session),
      email: session?.email ?? null,
      signIn: "/admin-login",
      signOut: "/api/logout",
    });
  }

  if (path === "logout") {
    return new Response(null, {
      status: 303,
      headers: {
        Location: "/",
        "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
      },
    });
  }

  return json({ error: "Rota não encontrada" }, 404);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ path?: string[] }> },
) {
  const path = await routePath(context);
  if (path !== "admin/login") return json({ error: "Rota não encontrada" }, 404);

  const configuredEmail = appEnv.ADMIN_EMAIL?.trim().toLowerCase();
  const configuredPassword = appEnv.ADMIN_PASSWORD;
  if (!configuredEmail || !configuredPassword || !appEnv.SESSION_SECRET) {
    return json({ error: "Configuração administrativa incompleta" }, 500);
  }

  let credentials: { email?: string; password?: string };
  try {
    credentials = (await request.json()) as { email?: string; password?: string };
  } catch {
    return json({ error: "Dados inválidos" }, 400);
  }

  const email = credentials.email?.trim().toLowerCase();
  if (email !== configuredEmail || credentials.password !== configuredPassword) {
    return json({ error: "E-mail ou senha inválidos" }, 401);
  }

  const token = await createSession(configuredEmail);
  return json(
    { ok: true },
    200,
    {
      "Set-Cookie": `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`,
    },
  );
}
