ALTER TABLE "Conta"
  ADD COLUMN "emailVerificado" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "recuperacaoHash" TEXT;

-- Before direct registration, clients obtained email only through a confirmation link.
UPDATE "Conta" SET "emailVerificado" = true
WHERE "papel" = 'CLIENTE' AND "email" IS NOT NULL;

CREATE UNIQUE INDEX "Conta_recuperacaoHash_key" ON "Conta"("recuperacaoHash");
