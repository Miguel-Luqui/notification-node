Serviço API (src/api.js): recebe requisições POST /notify (protegido por JWT), valida payload e enfileira jobs no RabbitMQ; também expõe /auth/login (PoC), /health e Swagger UI (/docs).
Worker (src/worker.js): consome a fila notifications, envia e‑mails via SMTP (MailHog em PoC), faz retry simples e move falhas para uma DLQ.
Infra/execução: configuração via .env, Dockerfile + docker‑compose para RabbitMQ, MailHog, API e worker.
Objetivo: PoC de pipeline de notificações (API → RabbitMQ → worker → SMTP).
