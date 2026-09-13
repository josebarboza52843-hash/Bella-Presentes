import { env } from "cloudflare:workers";
import QRCode from "qrcode";

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
  await appEnv.DB.prepare(`
    CREATE TABLE IF NOT EXISTS bella_administrators (
      email TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  await appEnv.DB.prepare(`
    CREATE TABLE IF NOT EXISTS bella_catalog (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  await appEnv.DB.prepare(`
    CREATE TABLE IF NOT EXISTS bella_orders (
      id TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      destination_zip TEXT NOT NULL,
      items_json TEXT NOT NULL,
      subtotal REAL NOT NULL,
      shipping_amount REAL,
      total REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'novo',
      payment_method TEXT NOT NULL DEFAULT 'A definir',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
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

function orderId() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = crypto.randomUUID().slice(0, 6).toUpperCase();
  return `BP-${date}-${suffix}`;
}

function emv(id: string, value: string) {
  return `${id}${String(value.length).padStart(2, "0")}${value}`;
}

function crc16(text: string) {
  let crc = 0xffff;
  for (let i = 0; i < text.length; i++) {
    crc ^= text.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function pixText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9 ]/g, "")
    .trim()
    .toUpperCase();
}

function buildPixPayload(key: string, name: string, city: string, total: number, reference: string) {
  const merchant = emv("00", "BR.GOV.BCB.PIX") + emv("01", key.trim());
  const referenceValue = pixText(reference).slice(0, 25) || "***";
  const base =
    emv("00", "01") +
    emv("26", merchant) +
    emv("52", "0000") +
    emv("53", "986") +
    emv("54", total.toFixed(2)) +
    emv("58", "BR") +
    emv("59", pixText(name).slice(0, 25)) +
    emv("60", pixText(city).slice(0, 15)) +
    emv("62", emv("05", referenceValue)) +
    "6304";
  return base + crc16(base);
}

async function listOrders(db: D1Database) {
  const result = await db.prepare(`
    SELECT id,
      customer_name AS customerName,
      customer_phone AS customerPhone,
      destination_zip AS destinationZip,
      items_json AS itemsJson,
      subtotal,
      shipping_amount AS shippingAmount,
      total,
      status,
      payment_method AS paymentMethod,
      notes,
      created_at AS createdAt
    FROM bella_orders
    ORDER BY created_at DESC
  `).all();
  return result.results ?? [];
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

  if (path === "catalog") {
    const db = await ensureDatabase();
    const row = await db.prepare(
      "SELECT data FROM bella_catalog WHERE id = 1",
    ).first<{ data: string }>();
    if (!row?.data) {
      return json({ products: [], categories: [], pixSettings: {}, deliverySettings: null });
    }
    try {
      return json(JSON.parse(row.data));
    } catch {
      return json({ products: [], categories: [], pixSettings: {}, deliverySettings: null });
    }
  }

  if (path === "orders") {
    if (!(await requireAdministrator(request))) return json({ error: "Não autorizado" }, 401);
    const db = await ensureDatabase();
    return json({ orders: await listOrders(db) });
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

export async function PUT(
  request: Request,
  context: { params: Promise<{ path?: string[] }> },
) {
  const path = await routePath(context);
  if (path !== "catalog") return json({ error: "Rota não encontrada" }, 404);
  if (!(await requireAdministrator(request))) return json({ error: "Não autorizado" }, 401);

  let catalog: {
    products?: unknown[];
    categories?: unknown[];
    pixSettings?: Record<string, unknown>;
    deliverySettings?: Record<string, unknown> | null;
  };
  try {
    catalog = await request.json();
  } catch {
    return json({ error: "Dados inválidos" }, 400);
  }
  if (!Array.isArray(catalog.products) || !Array.isArray(catalog.categories)) {
    return json({ error: "Catálogo inválido" }, 400);
  }

  const db = await ensureDatabase();
  await db.prepare(`
    INSERT INTO bella_catalog (id, data, updated_at)
    VALUES (1, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP
  `).bind(JSON.stringify(catalog)).run();
  return json({ ok: true });
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

  if (path === "orders") {
    let body: {
      customerName?: string;
      customerPhone?: string;
      destinationZip?: string;
      items?: Array<{ id?: number; name?: string; quantity?: number; unitPrice?: number }>;
      subtotal?: number;
    };
    try {
      body = await request.json();
    } catch {
      return json({ error: "Dados do pedido inválidos" }, 400);
    }
    const customerName = body.customerName?.trim();
    const customerPhone = body.customerPhone?.replace(/\D/g, "") ?? "";
    const destinationZip = body.destinationZip?.replace(/\D/g, "") ?? "";
    const items = Array.isArray(body.items)
      ? body.items.filter((item) => item.name && Number(item.quantity) > 0 && Number(item.unitPrice) >= 0)
      : [];
    if (!customerName || customerPhone.length < 10 || destinationZip.length !== 8 || !items.length) {
      return json({ error: "Preencha corretamente os dados do pedido" }, 400);
    }
    const subtotal = Number(
      items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unitPrice), 0).toFixed(2),
    );
    if (!Number.isFinite(subtotal) || subtotal < 0) return json({ error: "Valor inválido" }, 400);
    const id = orderId();
    const db = await ensureDatabase();
    await db.prepare(`
      INSERT INTO bella_orders
        (id, customer_name, customer_phone, destination_zip, items_json, subtotal, total)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(id, customerName, customerPhone, destinationZip, JSON.stringify(items), subtotal, subtotal).run();
    return json({ id, total: subtotal }, 201);
  }

  if (path === "pix") {
    if (!(await requireAdministrator(request))) return json({ error: "Não autorizado" }, 401);
    const body = (await request.json()) as { id?: string };
    if (!body.id) return json({ error: "Pedido não informado" }, 400);
    const db = await ensureDatabase();
    const order = await db.prepare(`
      SELECT id, customer_phone AS customerPhone, total
      FROM bella_orders WHERE id = ?
    `).bind(body.id).first<{ id: string; customerPhone: string; total: number }>();
    if (!order) return json({ error: "Pedido não encontrado" }, 404);
    const row = await db.prepare("SELECT data FROM bella_catalog WHERE id = 1").first<{ data: string }>();
    let settings: { key?: string; name?: string; city?: string } = {};
    try {
      settings = row?.data ? JSON.parse(row.data).pixSettings ?? {} : {};
    } catch {}
    if (!settings.key || !settings.name || !settings.city) {
      return json({ error: "Configure a chave PIX em Pagamentos" }, 400);
    }
    const payload = buildPixPayload(settings.key, settings.name, settings.city, Number(order.total), order.id);
    const qr = await QRCode.toDataURL(payload, { width: 320, margin: 1, errorCorrectionLevel: "M" });
    return json({ payload, qr, total: Number(order.total), customerPhone: order.customerPhone });
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

  const token = await createSession(email);
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
  if (path === "orders") {
    if (!(await requireAdministrator(request))) return json({ error: "Não autorizado" }, 401);
    const body = (await request.json()) as { id?: string };
    if (!body.id) return json({ error: "Pedido não informado" }, 400);
    const db = await ensureDatabase();
    await db.prepare("DELETE FROM bella_orders WHERE id = ?").bind(body.id).run();
    return json({ ok: true });
  }
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

export async function PATCH(
  request: Request,
  context: { params: Promise<{ path?: string[] }> },
) {
  const path = await routePath(context);
  if (path !== "orders") return json({ error: "Rota não encontrada" }, 404);
  if (!(await requireAdministrator(request))) return json({ error: "Não autorizado" }, 401);
  const body = (await request.json()) as {
    id?: string;
    status?: string;
    shippingAmount?: number | null;
    paymentMethod?: string;
    notes?: string;
  };
  const statuses = ["novo", "aguardando_pagamento", "pago", "preparando", "enviado", "entregue", "cancelado"];
  if (!body.id || !body.status || !statuses.includes(body.status)) {
    return json({ error: "Dados do pedido inválidos" }, 400);
  }
  const shipping = body.shippingAmount == null ? null : Number(body.shippingAmount);
  if (shipping != null && (!Number.isFinite(shipping) || shipping < 0)) {
    return json({ error: "Frete inválido" }, 400);
  }
  const db = await ensureDatabase();
  const current = await db.prepare("SELECT subtotal FROM bella_orders WHERE id = ?")
    .bind(body.id).first<{ subtotal: number }>();
  if (!current) return json({ error: "Pedido não encontrado" }, 404);
  const total = Number((Number(current.subtotal) + (shipping ?? 0)).toFixed(2));
  await db.prepare(`
    UPDATE bella_orders
    SET status = ?, shipping_amount = ?, total = ?, payment_method = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(
    body.status,
    shipping,
    total,
    String(body.paymentMethod ?? "A definir").slice(0, 40),
    String(body.notes ?? "").slice(0, 2000),
    body.id,
  ).run();
  return json({ ok: true, total });
}
