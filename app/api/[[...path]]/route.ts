import { env } from "cloudflare:workers";

export const runtime = "edge";

type AppEnv = {
  DB?: D1Database;
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
};

const COOKIE_NAME = "bella_admin_session";
const SESSION_SECONDS = 8 * 60 * 60;
const appEnv = env as unknown as AppEnv;

async function ensureDatabase() {
  if (!appEnv.DB) throw new Error("Banco D1 não conectado");
  await appEnv.DB.exec(`
    CREATE TABLE IF NOT EXISTS bella_administrators (
      email TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const primaryEmail = appEnv.ADMIN_EMAIL?.trim().toLowerCase();
  if (primaryEmail) {
    await appEnv.DB.prepare(
      "INSERT OR IGNORE INTO bella_administrators (email) VALUES (?)",
    ).bind(primaryEmail).run();
  }
  return appEnv.DB;
}

async function isAdministrator(email: string) {
  const db = await ensureDatabase();
  const row = await db.prepare(
    "SELECT email FROM bella_administrators WHERE email = ?",
  ).bind(email.trim().toLowerCase()).first();
  return Boolean(row);
}

async function requireAdministrator(request: Request) {
  const session = await readSession(request);
  if (!session || !(await isAdministrator(session.email))) return null;
  return session;
}

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
    const admin = Boolean(session && (await isAdministrator(session.email)));
    return json({
      authenticated: Boolean(session),
      admin,
      email: session?.email ?? null,
      signIn: "/admin-login",
      signOut: "/api/logout",
    });
  }

  if (path === "administrators") {
    if (!(await requireAdministrator(request))) return json({ error: "Não autorizado" }, 401);
    const db = await ensureDatabase();
    const result = await db.prepare(
      "SELECT email FROM bella_administrators ORDER BY created_at, email",
    ).all<{ email: string }>();
    return json({ administrators: (result.results ?? []).map((row) => row.email) });
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

  if (path === "administrators") {
    if (!(await requireAdministrator(request))) return json({ error: "Não autorizado" }, 401);
    const body = (await request.json()) as { email?: string };
    const email = body.email?.trim().toLowerCase();
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) return json({ error: "E-mail inválido" }, 400);
    const db = await ensureDatabase();
    await db.prepare(
      "INSERT OR IGNORE INTO bella_administrators (email) VALUES (?)",
    ).bind(email).run();
    const result = await db.prepare(
      "SELECT email FROM bella_administrators ORDER BY created_at, email",
    ).all<{ email: string }>();
    return json({ administrators: (result.results ?? []).map((row) => row.email) });
  }

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
  if (!email || !(await isAdministrator(email)) || credentials.password !== configuredPassword) {
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

export async function DELETE(
  request: Request,
  context: { params: Promise<{ path?: string[] }> },
) {
  const path = await routePath(context);
  if (path !== "administrators") return json({ error: "Rota não encontrada" }, 404);
  const session = await requireAdministrator(request);
  if (!session) return json({ error: "Não autorizado" }, 401);
  const body = (await request.json()) as { email?: string };
  const email = body.email?.trim().toLowerCase();
  const primaryEmail = appEnv.ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) return json({ error: "E-mail inválido" }, 400);
  if (email === primaryEmail) return json({ error: "O administrador principal não pode ser removido" }, 400);
  if (email === session.email) return json({ error: "Você não pode remover o próprio acesso" }, 400);
  const db = await ensureDatabase();
  await db.prepare("DELETE FROM bella_administrators WHERE email = ?").bind(email).run();
  const result = await db.prepare(
    "SELECT email FROM bella_administrators ORDER BY created_at, email",
  ).all<{ email: string }>();
  return json({ administrators: (result.results ?? []).map((row) => row.email) });
}
