import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { credentials } from "../db/schema/credentials.ts";
import type { CredentialKind, CredentialPurpose, CredentialSubjectKind } from "../../shared/enums.ts";

/** A credential ROW with an id the test names, sealed the plaintext way (the pass-through prefix
 *  the store reads in every keystore mode), so a test can point registrations, fakes and readers
 *  at a stable id and a real store still opens it to `plaintext`. This file lives beside the store
 *  because the store is the one importer of the credentials table (the boundary law). */
export function seedCredentialRow(db: Db, row: {
  id: string;
  kind: CredentialKind;
  label: string;
  subject: { kind: CredentialSubjectKind; id: string };
  purpose: CredentialPurpose;
  plaintext?: string;
  fingerprint?: string;
}): void {
  db.insert(credentials).values({
    id: row.id,
    kind: row.kind,
    label: row.label,
    subjectKind: row.subject.kind,
    subjectId: row.subject.id,
    purpose: row.purpose,
    encryptedBlob: `plain:v0:${Buffer.from(row.plaintext ?? `token-of-${row.id}`, "utf8").toString("base64")}`,
    fingerprint: row.fingerprint ?? `sha256:${row.id}`,
  }).run();
}

/** Takes every row of one subject away — what a test does to say "this owner records
 *  nothing" or "this server holds no key". */
export function dropCredentialRows(db: Db, subject: { kind: CredentialSubjectKind; id: string }): void {
  db.delete(credentials).where(and(eq(credentials.subjectKind, subject.kind), eq(credentials.subjectId, subject.id))).run();
}
