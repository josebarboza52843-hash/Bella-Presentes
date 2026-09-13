declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    ADMIN_EMAIL?: string;
    ADMIN_PASSWORD?: string;
    SESSION_SECRET?: string;
  }
}
