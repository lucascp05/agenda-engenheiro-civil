CREATE TYPE "Papel" AS ENUM ('CLIENTE', 'ENGENHEIRO');
CREATE TYPE "Situacao" AS ENUM ('RECEBIDO', 'INFORMACOES', 'MARCADO', 'CONCLUIDO');

CREATE TABLE "Conta" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "celular" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "papel" "Papel" NOT NULL DEFAULT 'CLIENTE',
    CONSTRAINT "Conta_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Pedido" (
    "id" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "servico" TEXT NOT NULL,
    "municipio" TEXT NOT NULL,
    "comunidade" TEXT,
    "local" TEXT NOT NULL,
    "descricao" TEXT NOT NULL,
    "link" TEXT,
    "situacao" "Situacao" NOT NULL DEFAULT 'RECEBIDO',
    "criadoEm" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Pedido_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Mensagem" (
    "id" TEXT NOT NULL,
    "pedidoId" TEXT NOT NULL,
    "autor" "Papel" NOT NULL,
    "texto" TEXT NOT NULL,
    "criadoEm" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Mensagem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Visita" (
    "id" TEXT NOT NULL,
    "pedidoId" TEXT NOT NULL,
    "horario" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "Visita_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Conta_celular_key" ON "Conta"("celular");
CREATE INDEX "Pedido_clienteId_criadoEm_idx" ON "Pedido"("clienteId", "criadoEm");
CREATE INDEX "Mensagem_pedidoId_criadoEm_idx" ON "Mensagem"("pedidoId", "criadoEm");
CREATE UNIQUE INDEX "Visita_pedidoId_key" ON "Visita"("pedidoId");
CREATE UNIQUE INDEX "Visita_horario_key" ON "Visita"("horario");

ALTER TABLE "Pedido" ADD CONSTRAINT "Pedido_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Conta"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Mensagem" ADD CONSTRAINT "Mensagem_pedidoId_fkey" FOREIGN KEY ("pedidoId") REFERENCES "Pedido"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Visita" ADD CONSTRAINT "Visita_pedidoId_fkey" FOREIGN KEY ("pedidoId") REFERENCES "Pedido"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
