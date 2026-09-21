import { generateKeyPairSync } from "node:crypto";

/** The platform's GitHub App as a test configuration answers it: the three env the schema requires
 *  of every installation (config.ts githubApp). A real PKCS#1 key, because the schema reads the PEM
 *  to refuse one this process cannot sign with. Spread into every env literal a test hands to
 *  parseConfig. */
export const GITHUB_APP_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }) as string;
export const GITHUB_APP_ENV = { GITHUB_APP_ID: "12345", GITHUB_APP_INSTALLATION_ID: "42", GITHUB_APP_PRIVATE_KEY: GITHUB_APP_PEM };
