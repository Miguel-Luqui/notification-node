import dotenv from "dotenv";
import amqp from "amqplib";
import nodemailer from "nodemailer";

dotenv.config();

const RABBIT_URL = process.env.RABBITMQ_URL ?? "amqp://rabbitmq:5672";
const QUEUE = process.env.RABBITMQ_QUEUE ?? "notifications";

async function createTransport() {
  // Para dev usamos MailHog (SMTP 1025)
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? "mailhog",
    port: Number(process.env.SMTP_PORT ?? 1025),
    secure: false
    // sem auth para MailHog; em produção configure auth/tls
  });

  // Verificação rápida
  await transporter.verify().catch(err => {
    console.warn("Warning: não foi possível verificar SMTP (dev ok):", err.message);
  });

  return transporter;
}

async function startWorker() {
  const conn = await amqp.connect(RABBIT_URL);
  const channel = await conn.createChannel();
  await channel.assertQueue(QUEUE, { durable: true });
  channel.prefetch(1);
  console.log("Worker conectado ao RabbitMQ, aguardando mensagens...");

  const transporter = await createTransport();

  channel.consume(
    QUEUE,
    async (msg) => {
      if (!msg) return;
      try {
        const job = JSON.parse(msg.content.toString());
        console.log("Processando job:", job.id, "para", job.to);

        const mail = {
          from: process.env.EMAIL_FROM ?? "no-reply@example.com",
          to: job.to,
          subject: job.subject,
          text: job.text,
          html: job.html
        };

        await transporter.sendMail(mail);
        console.log("E-mail enviado:", job.id, "para", job.to);

        channel.ack(msg);
      } catch (err) {
        console.error("Erro ao processar job:", err);
        // Em PoC: envia para fila de erro simples e ack para evitar loop infinito
        const failedQueue = `${QUEUE}_failed`;
        await channel.assertQueue(failedQueue, { durable: true });
        const payload = {
          error: err.message,
          original: msg.content.toString(),
          failedAt: new Date().toISOString()
        };
        channel.sendToQueue(failedQueue, Buffer.from(JSON.stringify(payload)), { persistent: true });
        channel.ack(msg);
      }
    },
    { noAck: false }
  );
}

startWorker().catch((err) => {
  console.error("Worker falhou:", err);
  process.exit(1);
});