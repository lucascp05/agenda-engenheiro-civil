ALTER TABLE "Conta" ALTER COLUMN "celular" DROP NOT NULL, ADD COLUMN "email" TEXT;
CREATE UNIQUE INDEX "Conta_email_key" ON "Conta"("email");
ALTER TABLE "Pedido" ADD COLUMN "celular" TEXT;

CREATE TYPE "FinalidadeEmail" AS ENUM ('CADASTRO', 'VINCULO', 'RECUPERACAO', 'PROPRIETARIO');
CREATE TABLE "TokenEmail" (
    "hash" TEXT PRIMARY KEY,
    "finalidade" "FinalidadeEmail" NOT NULL,
    "email" TEXT NOT NULL,
    "nome" TEXT,
    "contaId" TEXT,
    "versao" INTEGER,
    "expiraEm" TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX "TokenEmail_expiraEm_idx" ON "TokenEmail"("expiraEm");
