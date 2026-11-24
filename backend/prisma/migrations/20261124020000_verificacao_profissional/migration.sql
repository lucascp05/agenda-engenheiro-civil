ALTER TYPE "Papel" ADD VALUE 'ADMIN';
CREATE TYPE "SituacaoProfissional" AS ENUM ('EM_ANALISE', 'APROVADO', 'REJEITADO');

CREATE TABLE "PerfilProfissional" (
    "contaId" TEXT NOT NULL,
    "nomeCompleto" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "creaUf" TEXT NOT NULL,
    "registro" TEXT NOT NULL,
    "autorizaPublicacao" BOOLEAN NOT NULL DEFAULT false,
    "situacao" "SituacaoProfissional" NOT NULL DEFAULT 'EM_ANALISE',
    "criadoEm" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revisorId" TEXT,
    "revisadoEm" TIMESTAMPTZ(3),
    "fonteOficial" TEXT,
    "metodoIdentidade" TEXT,
    CONSTRAINT "PerfilProfissional_pkey" PRIMARY KEY ("contaId"),
    CONSTRAINT "PerfilProfissional_contaId_fkey" FOREIGN KEY ("contaId") REFERENCES "Conta"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PerfilProfissional_revisorId_fkey" FOREIGN KEY ("revisorId") REFERENCES "Conta"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PerfilProfissional_revisao_check" CHECK (
      ("situacao" = 'EM_ANALISE' AND "revisorId" IS NULL AND "revisadoEm" IS NULL AND "fonteOficial" IS NULL AND "metodoIdentidade" IS NULL)
      OR ("situacao" = 'REJEITADO' AND "revisorId" IS NOT NULL AND "revisadoEm" IS NOT NULL AND "revisorId" <> "contaId")
      OR ("situacao" = 'APROVADO' AND "revisorId" IS NOT NULL AND "revisadoEm" IS NOT NULL AND "revisorId" <> "contaId" AND "fonteOficial" IS NOT NULL AND "metodoIdentidade" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "PerfilProfissional_unico_aprovado" ON "PerfilProfissional" ("situacao") WHERE "situacao" = 'APROVADO';
