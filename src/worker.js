import dotenv from "dotenv";
import amqp from "amqplib";
import nodemailer from "nodemailer";

dotenv.config();

/**
 * notification-node worker
 * - Papel: consumir mensagens da fila `notifications` e enviar e-mails.
 * - Fluxo:
 *   1) Ler mensagem JSON da fila;
 *   2) Tentar enviar e-mail via SMTP (MailHog no PoC);
 *   3) Se sucesso -> ack; se falha -> requeue com attempts++ ou mover para fila de falhas.
 */

/* Configurações (ajuste via .env se necessário) */
const RABBIT_URL = process.env.RABBITMQ_URL ?? "amqp://rabbitmq:5672";
const QUEUE = process.env.RABBITMQ_QUEUE ?? "notifications";
const FAILED_QUEUE = process.env.RABBITMQ_FAILED_QUEUE ?? `${QUEUE}_failed`;

const SMTP_HOST = process.env.SMTP_HOST ?? "mailhog";
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 1025);
const SMTP_USER = process.env.SMTP_USER ?? undefined;
const SMTP_PASS = process.env.SMTP_PASS ?? undefined;
const EMAIL_FROM = process.env.EMAIL_FROM ?? "no-reply@example.com";

/* Retry policy (PoC) */
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? 3);
const BASE_REQUEUE_DELAY_MS = Number(process.env.REQUEUE_DELAY_MS ?? 2000); // base backoff

/* Estado global */
let connection = null;
let channel = null;
let transporter = null;

/* Helper: sleep (ms) */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cria e verifica o transporter SMTP (nodemailer).
 * - Em dev usamos MailHog (sem auth). Em produção configure auth e TLS.
 */
async function createTransport() {
  const opts = {
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false // MailHog não usa TLS; em produção ajuste
  };

  if (SMTP_USER && SMTP_PASS) {
    opts.auth = { user: SMTP_USER, pass: SMTP_PASS };
  }

  const t = nodemailer.createTransport(opts);

  try {
    await t.verify();
    console.info("SMTP transporter verificado:", `${SMTP_HOST}:${SMTP_PORT}`);
  } catch (err) {
    console.warn("Warning: verificação SMTP falhou (ok para dev):", err?.message ?? err);
  }

  return t;
}

/**
 * Conecta ao RabbitMQ, assegura as filas e prepara o consumo.
 * - Usa prefetch(1) para processar uma mensagem por vez (controle de concorrência).
 * - Adiciona handlers básicos de erro/close para tentar reconectar quando necessário.
 */
async function connectRabbit() {
  connection = await amqp.connect(RABBIT_URL);

  connection.on("error", (err) => {
    console.error("RabbitMQ connection error:", err?.message ?? err);
  });

  connection.on("close", () => {
    console.warn("RabbitMQ connection closed");
    connection = null;
    channel = null;
    // O processo atual tenta reconectar ao subir novamente ou pode ser reiniciado pelo orchestrator (docker)
  });

  channel = await connection.createChannel();
  await channel.assertQueue(QUEUE, { durable: true });
  await channel.assertQueue(FAILED_QUEUE, { durable: true });
  // Processa uma mensagem por vez; evita overloading do SMTP local
  channel.prefetch(1);

  channel.on("error", (err) => {
    console.error("RabbitMQ channel error:", err?.message ?? err);
  });

  console.info("Connected to RabbitMQ - consuming from queue:", QUEUE);
}

/**
 * Publica uma mensagem na fila especificada com headers/metadata.
 * - Utilizado para requeue ou para mover para fila de falhas.
 */
async function publishMessage(queueName, payload, attempts = 0) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const ok = channel.sendToQueue(queueName, body, {
    persistent: true,
    contentType: "application/json",
    headers: { attempts }
  });

  if (!ok) {
    // Em PoC apenas logamos; em produção trate backpressure adequadamente
    console.warn(`sendToQueue returned false for queue ${queueName} (backpressure)`);
  }
}

/**
 * Processa uma única mensagem:
 * - Desserializa job;
 * - Monta mailOptions e envia;
 * - Em falha aplica retry simples com backoff; após MAX_ATTEMPTS => envia para fila de falhas.
 *
 * Importante: sempre faz channel.ack(msg) (aceita a mensagem) depois de re-publicar ou mover,
 * para evitar loops infinitos. Em produção usar DLQ com TTL/delayed-retry é preferível.
 */
async function processMessage(msg) {
  if (!msg) return;

  const raw = msg.content.toString();
  let job;
  try {
    job = JSON.parse(raw);
  } catch (err) {
    console.error("Invalid JSON in message - moving to failed queue:", raw);
    // move to failed queue com info do erro
    const payload = { error: "Invalid JSON", raw, failedAt: new Date().toISOString() };
    await publishMessage(FAILED_QUEUE, payload, 0);
    channel.ack(msg);
    return;
  }

  // attempts pode vir nos headers ou no próprio payload; preferimos header
  const headerAttempts = (msg.properties?.headers?.attempts ?? 0);
  const attempts = Number(headerAttempts);

  console.info(`Processing job id=${job.id ?? "<no-id>"} to=${job.to} attempts=${attempts}`);

  const mailOptions = {
    from: EMAIL_FROM,
    to: job.to,
    subject: job.subject,
    text: job.text ?? undefined,
    html: job.html ?? undefined
  };

  try {
    await transporter.sendMail(mailOptions);
    console.info(`Email enviado com sucesso para ${job.to} (job ${job.id ?? "n/a"})`);
    channel.ack(msg);
  } catch (err) {
    console.error("Erro ao enviar e-mail:", err?.message ?? err);

    const nextAttempt = attempts + 1;
    if (nextAttempt <= MAX_ATTEMPTS) {
      // backoff exponencial simples antes de re-publicar
      const delayMs = BASE_REQUEUE_DELAY_MS * Math.pow(2, attempts);
      console.info(`Requeue do job em ${delayMs}ms (attempt ${nextAttempt}/${MAX_ATTEMPTS})`);
      // aguardamos aqui para reduzir flood imediato; em produção prefira DLQ/delayed-exchange
      await sleep(delayMs);
      // republia na mesma fila com attempts incrementado
      await publishMessage(QUEUE, job, nextAttempt);
    } else {
      console.warn(`Job excedeu ${MAX_ATTEMPTS} tentativas — movendo para ${FAILED_QUEUE}`);
      const payload = {
        error: err?.message ?? "send error",
        original: job,
        failedAt: new Date().toISOString()
      };
      await publishMessage(FAILED_QUEUE, payload, nextAttempt);
    }

    // ack original para evitar processamento infinito do mesmo msg
    channel.ack(msg);
  }
}

/**
 * Inicia o worker: cria transporter, conecta ao broker e começa a consumir.
 */
async function startWorker() {
  transporter = await createTransport();

  try {
    await connectRabbit();
  } catch (err) {
    console.error("Falha ao conectar RabbitMQ:", err?.message ?? err);
    process.exit(1); // Para PoC: encerramos para sinalizar erro; em produção implemente reconexão robusta
  }

  await channel.consume(
    QUEUE,
    async (msg) => {
      try {
        await processMessage(msg);
      } catch (err) {
        console.error("Unhandled error processing message:", err?.message ?? err);
        try {
          // Em caso de erro fatal, ack para evitar travamento; em produção repensar estratégia
          channel.ack(msg);
        } catch (_) {}
      }
    },
    { noAck: false }
  );

  console.info("Worker está aguardando mensagens...");
}

startWorker().catch((err) => {
  console.error("Worker falhou na inicialização:", err?.message ?? err);
  process.exit(1);
});

/**
 * Encerramento gracioso
 */
async function shutdown(signal) {
  console.log(`Received ${signal} - shutting down worker gracefully...`);
  try {
    if (channel) {
      try { await channel.close(); } catch (_) {}
      channel = null;
    }
    if (connection) {
      try { await connection.close(); } catch (_) {}
      connection = null;
    }
    console.log("RabbitMQ connection closed");
  } catch (err) {
    console.error("Erro durante shutdown:", err?.message ?? err);
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));