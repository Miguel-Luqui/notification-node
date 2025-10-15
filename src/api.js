import express from "express";
import dotenv from "dotenv";
import amqp from "amqplib";
import swaggerUi from "swagger-ui-express";
import swaggerJSDoc from "swagger-jsdoc";

dotenv.config();

/**
 * notification-node: API que recebe pedidos de notificação e os enfileira no RabbitMQ.
 * - Este arquivo configura a conexão com RabbitMQ, expõe endpoints HTTP (incluindo /notify)
 *   e fornece uma UI Swagger para facilitar testes durante a apresentação.
 */

/**
 * Configurações (padrões para PoC)
 */
const RABBIT_URL = process.env.RABBITMQ_URL ?? "amqp://rabbitmq:5672";
const QUEUE = process.env.RABBITMQ_QUEUE ?? "notifications";
const PORT = Number(process.env.PORT ?? 3000);

/**
 * Estado de conexão com RabbitMQ (variáveis globais para simplificar o PoC)
 */
let connection = null;
let channel = null;
let isConnected = false;
let reconnectTimer = null;

/**
 * Helper: sleep (ms)
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Conecta ao RabbitMQ com política simples de reconexão exponencial.
 * - Garante criação/existência da fila durável.
 * - Mantém `channel` e `connection` para publicação de mensagens.
 */
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

      // Tratamento opcional de erro no channel
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
      delay = Math.min(delay * 2, 10000); // backoff cap
    }
  }

  throw new Error("Unable to connect to RabbitMQ after multiple attempts");
}

/**
 * Agenda tentativa de reconexão (evita múltiplos timers concorrentes)
 */
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await connectRabbit();
    } catch (err) {
      console.error("Reconnect failed:", err?.message ?? err);
      // re-schedule another attempt
      scheduleReconnect();
    }
  }, 2000);
}

/**
 * Publica um job na fila `QUEUE`.
 * - Lança se não houver conexão.
 * - Serializa payload para JSON e marca mensagem como persistent.
 */
async function publishToQueue(payload) {
  if (!channel || !isConnected) {
    throw new Error("RabbitMQ not connected");
  }

  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const ok = channel.sendToQueue(QUEUE, body, {
    persistent: true,
    contentType: "application/json",
    messageId: payload.id?.toString(),
  });

  if (!ok) {
    // Quando ok === false o buffer interno está cheio — em produção implementar backpressure corretamente
    console.warn("RabbitMQ sendToQueue returned false (backpressure)");
  }
}

/**
 * Express app
 *
 * Resumo:
 * - O Express cria um servidor HTTP simples que aceita requisições.
 * - `app.use(express.json())` permite que a API receba JSON no corpo das requisições.
 * - Expondo endpoints como `/notify` você permite que clientes (curl, Swagger, frontend)
 *   enviem pedidos de notificação que serão enfileirados no RabbitMQ.
 * - `GET /health` oferece um atalho para verificar se a API está conseguindo falar com o RabbitMQ.
 */
const app = express();

/* Middleware para interpretar JSON no corpo das requisições.
   Sem isso `req.body` seria `undefined` quando o cliente enviar JSON. */
app.use(express.json());

/**
 * Swagger / OpenAPI configuration
 * - Gera documentação automaticamente a partir de comentários JSDoc no próprio arquivo.
 * - Disponível em /docs para testar/validar a API durante a apresentação.
 */
const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Notification Node PoC",
      version: "1.0.0",
      description: "API para enfileirar notificações (PoC)"
    }
  },
  apis: ["./src/api.js"]
};

const swaggerSpec = swaggerJSDoc(swaggerOptions);
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

/**
 * Health check endpoint
 * - Simples: retorna status de conexão com o RabbitMQ.
 * - Útil para verificar rapidamente se o sistema está operacional.
 */
app.get("/health", (req, res) => {
  res.json({
    status: isConnected ? "ok" : "degraded",
    rabbitmq: {
      connected: isConnected,
      url: RABBIT_URL
    }
  });
});

/**
 * POST /notify
 * - Valida entrada (to, subject, text|html).
 * - Cria um objeto `job` com metadados mínimos.
 * - Publica na fila do RabbitMQ.
 *
 * Observações:
 * - O endpoint não envia o e-mail diretamente; ele apenas "anota" o pedido na fila.
 * - Um worker separado (node) irá ler a fila e enviar o e-mail de fato.
 */
app.post("/notify", async (req, res) => {
  try {
    const { to, subject, text, html } = req.body ?? {};

    // Validação simples e clara
    if (!to || typeof to !== "string" || !subject || typeof subject !== "string" || (!text && !html)) {
      return res.status(400).json({ error: "Campos obrigatórios: to (string), subject (string), text|html" });
    }

    // Monta job com metadata mínima (id, timestamps)
    const job = {
      id: Date.now(),
      to: to.trim(),
      subject: subject.trim(),
      text: text ?? null,
      html: html ?? null,
      createdAt: new Date().toISOString()
    };

    if (!isConnected) {
      // Indica temporariamente indisponível para o cliente — retry pode ser implementado pelo cliente
      return res.status(503).json({ error: "Serviço temporariamente indisponível. Tente novamente em alguns segundos." });
    }

    await publishToQueue(job);
    return res.status(202).json({ message: "Enfileirado", job });
  } catch (err) {
    console.error("Falha ao publicar na fila:", err?.message ?? err);
    return res.status(500).json({ error: "Erro ao enfileirar" });
  }
});

/**
 * Global error handler (fallback)
 * - Captura erros não tratados nas rotas e retorna 500.
 */
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err?.message ?? err);
  res.status(500).json({ error: "Erro interno" });
});

/**
 * Startup: conecta no broker e inicia servidor HTTP.
 * - Expondo logs essenciais para demonstrar o fluxo durante a apresentação.
 */
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

/**
 * Encerramento gracioso — fecha conexão com RabbitMQ e o servidor HTTP.
 * - Importante para evitar mensagens perdidas durante shutdown (PoC).
 */
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