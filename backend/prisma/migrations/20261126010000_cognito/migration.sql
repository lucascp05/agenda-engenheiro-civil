ALTER TABLE "Conta" ADD COLUMN "cognitoUsuario" TEXT, ADD COLUMN "cognitoSub" TEXT;
ALTER TABLE "Conta" ADD CONSTRAINT "Conta_cognito_par" CHECK (("cognitoUsuario" IS NULL) = ("cognitoSub" IS NULL));
CREATE UNIQUE INDEX "Conta_cognitoUsuario_key" ON "Conta"("cognitoUsuario");
CREATE UNIQUE INDEX "Conta_cognitoSub_key" ON "Conta"("cognitoSub");
