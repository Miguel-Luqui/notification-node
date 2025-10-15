import express from "express";
import dotenv from "dotenv";
import amqp from "amqplib";

dotenv.config();

const RABBIT_URL = process.env.RABBITMQ_URL ?? "amqp://rabbitmq:5672";
const QUEUE = process.env.RABBITMQ_QUEUE ?? "notifications";

const app = express();
app.use(express.json());

let channel;

async function connectRabbit() {
  const conn = await amqp.connect(RABBIT_URL);
  channel = await conn.createChannel();
  await channel.assertQueue(QUEUE, { durable: true });
  console.log("Connected to RabbitMQ, queue:", QUEUE);
}

app.post("/notify", async (req, res) => {
  const { to, subject, text, html } = req.body;

  if (!to || !subject || (!text && !html)) {
    return res.status(400).json({ error: "Campos obrigatórios: to, subject, text|html" });
  }

  const job = {
    id: Date.now(),
    to,
    subject,
    text,
    html,
    createdAt: new Date().toISOString()
  };

  try {
    channel.sendToQueue(QUEUE, Buffer.from(JSON.stringify(job)), { persistent: true });
    return res.status(202).json({ message: "Enfileirado", job });
  } catch (err) {
    console.error("Falha ao publicar na fila:", err);
    return res.status(500).json({ error: "Erro ao enfileirar" });
  }
});

const port = process.env.PORT ?? 3000;
app.listen(port, async () => {
  try {
    await connectRabbit();
    console.log(`Notification API listening on port ${port}`);
  } catch (err) {
    console.error("Erro ao conectar RabbitMQ:", err);
    process.exit(1);
  }
});