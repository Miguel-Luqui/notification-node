import express from "express";
import dotenv from "dotenv";
import amqp from "amqplib";
import swaggerUi from "swagger-ui-express";
import swaggerJSDoc from "swagger-jsdoc";
import jwt from "jsonwebtoken";

dotenv.config();

/**
 * notification-node: API que recebe pedidos de notificação e os enfileira no RabbitMQ.
 * - Este arquivo configura a conexão com RabbitMQ, expõe endpoints HTTP (incluindo /notify)
 *   e fornece uma UI Swagger para facilitar testes durante a apresentação.
 */

/* ===========================
   Config (centralizado)
   =========================== */
const CONFIG = {
  RABBIT_URL: process.env.RABBITMQ_URL ?? "amqp://rabbitmq:5672",
  QUEUE: process.env.RABBITMQ_QUEUE ?? "notifications",
  PORT: Number(process.env.PORT ?? 3000),
  // JWT / Auth (PoC)
  JWT_SECRET: process.env.JWT_SECRET ?? "change_me",
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN ?? "1h",
  ADMIN_USER: process.env.ADMIN_USER ?? "admin",
  ADMIN_PASS: process.env.ADMIN_PASS ?? "secret",
};

const { RABBIT_URL, QUEUE, PORT, JWT_SECRET, JWT_EXPIRES_IN, ADMIN_USER, ADMIN_PASS } = CONFIG;

/* ===========================
   Estado de conexão com RabbitMQ
   =========================== */
let connection = null;
let channel = null;
let isConnected = false;
let reconnectTimer = null;

/* Helper: sleep (ms) */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ===========================
   RabbitMQ connect + reconnection
   =========================== */
async function connectRabbit({ maxRetries = 10, initialDelayMs = 500 } = {}) {
  let attempt = 0;
  let delay = initialDelayMs;

  while (attempt < maxRetries) {
    try {
      connection = await amqp.connect(RABBIT_URL);

      connection.on("error", (err) => {
        console.error("RabbitMQ connection error:", err?.message ?? err);
      });

      connection.on("close", () => {
        console.warn("RabbitMQ connection closed. Will attempt to reconnect.");
        isConnected = false;
        channel = null;
        scheduleReconnect();
      });

      channel = await connection.createChannel();
      await channel.assertQueue(QUEUE, { durable: true });

      channel.on("error", (err) => {
        console.error("RabbitMQ channel error:", err?.message ?? err);
      });

      isConnected = true;
      console.info("Connected to RabbitMQ, queue:", QUEUE);
      return;
    } catch (err) {
      attempt += 1;
      console.warn(`Failed to connect to RabbitMQ (attempt ${attempt}/${maxRetries}): ${err?.message ?? err}`);
      await sleep(delay);
      delay = Math.min(delay * 2, 10000);
    }
  }

  throw new Error("Unable to connect to RabbitMQ after multiple attempts");
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await connectRabbit();
    } catch (err) {
      console.error("Reconnect failed:", err?.message ?? err);
      scheduleReconnect();
    }
  }, 2000);
}

/* ===========================
   Publicar mensagens (com tratamento)
   =========================== */
async function publishToQueue(payload) {
  if (!channel || !isConnected) {
    throw new Error("RabbitMQ not connected");
  }

  let body;
  try {
    body = Buffer.from(JSON.stringify(payload), "utf8");
  } catch (err) {
    // Falha ao serializar: payload inválido
    throw new Error("Failed to serialize payload");
  }

  try {
    const ok = channel.sendToQueue(QUEUE, body, {
      persistent: true,
      contentType: "application/json",
      messageId: payload.id?.toString(),
    });

    if (!ok) {
      // backpressure: logamos para PoC
      console.warn("RabbitMQ sendToQueue returned false (backpressure)");
    }
  } catch (err) {
    // Encapsula erro para o caller
    throw new Error(`Failed to send to queue: ${err?.message ?? err}`);
  }
}

/* ===========================
   Express app + middleware
   =========================== */
const app = express();
app.use(express.json());

const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Notification Node PoC",
      version: "1.0.0",
      description: "API para enfileirar notificações (PoC)",
    },

    // Adiciona paths explícitos e securitySchemes para evitar
    // "No operations defined in spec!" quando não há JSDoc annotations.
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
      schemas: {
        NotifyRequest: {
          type: "object",
          properties: {
            to: { type: "string", example: "user@example.com" },
            subject: { type: "string", example: "Hello" },
            text: { type: "string", example: "Plain text body" },
            html: { type: "string", example: "<p>HTML body</p>" },
          },
          required: ["to", "subject"],
        },
        LoginRequest: {
          type: "object",
          properties: {
            username: { type: "string", example: "admin" },
            password: { type: "string", example: "secret" },
          },
          required: ["username", "password"],
        },
        AuthResponse: {
          type: "object",
          properties: {
            token: { type: "string" },
            expiresIn: { type: "string" },
          },
        },
        Job: {
          type: "object",
          properties: {
            id: { type: "integer" },
            to: { type: "string" },
            subject: { type: "string" },
            text: { type: ["string", "null"] },
            html: { type: ["string", "null"] },
            createdAt: { type: "string", format: "date-time" },
            requestedBy: { type: "string" },
          },
        },
      },
    },

    paths: {
      "/health": {
        get: {
          summary: "Health check",
          responses: {
            "200": {
              description: "Health information",
            },
          },
        },
      },

      "/auth/login": {
        post: {
          summary: "Login (PoC) - retorna JWT",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LoginRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Token gerado",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/AuthResponse" },
                },
              },
            },
            "400": { description: "Bad request" },
            "401": { description: "Invalid credentials" },
          },
        },
      },

      "/notify": {
        post: {
          summary: "Enfileira notificação (protegido por JWT)",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/NotifyRequest" },
              },
            },
          },
          responses: {
            "202": {
              description: "Enfileirado",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Job" },
                },
              },
            },
            "400": { description: "Bad request" },
            "401": { description: "Unauthorized" },
            "503": { description: "Service unavailable" },
            "500": { description: "Internal error" },
          },
        },
      },
    },
  },
  apis: ["./src/api.js"],
};

const swaggerSpec = swaggerJSDoc(swaggerOptions);
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

/* Health */
app.get("/health", (req, res) => {
  res.json({
    status: isConnected ? "ok" : "degraded",
    rabbitmq: {
      connected: isConnected,
      url: RABBIT_URL,
    },
  });
});

/* Middleware JWT (PoC)
   - Verifica header Authorization: Bearer <token>
   - Em produção, melhore payload e validação.
*/
function authenticateJWT(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const token = auth.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/* Login PoC: emite token para ADMIN_USER / ADMIN_PASS */
app.post("/auth/login", (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) {
    return res.status(400).json({ error: "username and password required" });
  }
  if (username !== ADMIN_USER || password !== ADMIN_PASS) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const token = jwt.sign({ sub: username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  return res.json({ token, expiresIn: JWT_EXPIRES_IN });
});

/**
 * POST /notify
 * - Protegida por JWT (authenticateJWT)
 * - Valida entrada (to, subject, text|html).
 * - Enfileira job no RabbitMQ.
 */
app.post("/notify", authenticateJWT, async (req, res) => {
  try {
    const { to, subject, text, html } = req.body ?? {};

    if (!to || typeof to !== "string" || !subject || typeof subject !== "string" || (!text && !html)) {
      return res.status(400).json({ error: "Campos obrigatórios: to (string), subject (string), text|html" });
    }

    const job = {
      id: Date.now(),
      to: to.trim(),
      subject: subject.trim(),
      text: text ?? null,
      html: html ?? null,
      createdAt: new Date().toISOString(),
      // meta PoC: quem enfileirou
      requestedBy: (req.user && req.user.sub) ?? "unknown",
    };

    if (!isConnected) {
      return res.status(503).json({ error: "Serviço temporariamente indisponível. Tente novamente em alguns segundos." });
    }

    await publishToQueue(job);
    return res.status(202).json({ message: "Enfileirado", job });
  } catch (err) {
    console.error("Falha ao publicar na fila:", err?.message ?? err);
    return res.status(500).json({ error: "Erro ao enfileirar" });
  }
});

/* Global error handler */
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err?.message ?? err);
  res.status(500).json({ error: "Erro interno" });
});

/* ===========================
   Startup + shutdown
   =========================== */
let server = null;

async function start() {
  try {
    await connectRabbit();
  } catch (err) {
    console.error("Não foi possível conectar ao RabbitMQ na inicialização:", err?.message ?? err);
    // Continuamos para que o health endpoint esteja disponível para diagnóstico.
  }

  server = app.listen(PORT, () => {
    console.log(`Notification API listening on port ${PORT}`);
    console.log(`Swagger UI available at http://localhost:${PORT}/docs`);
    console.log(`Health available at http://localhost:${PORT}/health`);
  });
}

start().catch((err) => {
  console.error("Falha na inicialização:", err?.message ?? err);
  process.exit(1);
});

async function shutdown(signal) {
  console.log(`Received ${signal} - shutting down gracefully...`);
  try {
    if (server) {
      server.close(() => console.log("HTTP server closed"));
    }
    if (channel) {
      try { await channel.close(); } catch (_) {}
      channel = null;
    }
    if (connection) {
      try { await connection.close(); } catch (_) {}
      connection = null;
    }
    isConnected = false;
  } catch (err) {
    console.error("Erro durante shutdown:", err?.message ?? err);
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

export default app;