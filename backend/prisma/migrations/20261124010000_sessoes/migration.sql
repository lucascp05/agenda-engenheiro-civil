ALTER TABLE "Conta" ADD COLUMN "versaoSessao" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "SessaoAcesso" (
    "id" TEXT NOT NULL,
    "contaId" TEXT NOT NULL,
    "expiraEm" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "SessaoAcesso_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SessaoAcesso_contaId_idx" ON "SessaoAcesso"("contaId");
CREATE INDEX "SessaoAcesso_expiraEm_idx" ON "SessaoAcesso"("expiraEm");
ALTER TABLE "SessaoAcesso" ADD CONSTRAINT "SessaoAcesso_contaId_fkey" FOREIGN KEY ("contaId") REFERENCES "Conta"("id") ON DELETE CASCADE ON UPDATE CASCADE;
