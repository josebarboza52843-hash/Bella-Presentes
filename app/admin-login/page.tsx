"use client";

import { useState } from "react";

export default function AdminLoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setMessage("");

    try {
      const response = await fetch("/api/admin/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json();

      if (!response.ok) {
        setMessage(data?.error || "E-mail ou senha incorretos.");
        return;
      }

      window.location.href = "/";
    } catch {
      setMessage("Não foi possível entrar. Tente novamente.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#f8e8ec",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "420px",
          background: "#ffffff",
          borderRadius: "20px",
          padding: "32px",
          boxShadow: "0 12px 35px rgba(80, 45, 35, 0.15)",
        }}
      >
        <h1
          style={{
            color: "#6b4035",
            textAlign: "center",
            marginBottom: "8px",
          }}
        >
          Bella Presentes
        </h1>

        <p
          style={{
            textAlign: "center",
            color: "#8b6b62",
            marginBottom: "28px",
          }}
        >
          Acesso administrativo
        </p>

        <form onSubmit={handleLogin}>
          <label style={{ color: "#6b4035", fontWeight: 600 }}>
            E-mail
          </label>

          <input
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "13px",
              margin: "8px 0 18px",
              borderRadius: "10px",
              border: "1px solid #d8b9b0",
            }}
          />

          <label style={{ color: "#6b4035", fontWeight: 600 }}>
            Senha
          </label>

          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "13px",
              margin: "8px 0 18px",
              borderRadius: "10px",
              border: "1px solid #d8b9b0",
            }}
          />

          {message && (
            <p style={{ color: "#a33", textAlign: "center" }}>
              {message}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: "100%",
              padding: "14px",
              border: "none",
              borderRadius: "10px",
              background: "#6b4035",
              color: "#ffffff",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {loading ? "Entrando..." : "Entrar"}
          </button>
        </form>

        <p style={{ textAlign: "center", marginTop: "22px" }}>
          <a href="/" style={{ color: "#b28a43" }}>
            Voltar para a loja
          </a>
        </p>
      </div>
    </main>
  );
}
