import { useState, type FormEvent } from "react";
import type { PackagesReaderView } from "../../../shared/apps-manifest.ts";

interface Props {
  /** The reader the build needs, as the server measured it; rendered only while none is recorded. */
  reader: PackagesReaderView;
  /** Records the token as the owner's (measured and sealed server-side); the caller reads the
   *  measurement again afterwards, so this step disappears once the reader stands. */
  onRecord: (owner: string, token: string) => Promise<void>;
  /** What is being onboarded, for the sentence: "the bundle" or "the repository". */
  subject: string;
}

/** THE ONE STEP THAT ASKS FOR A PACKAGES READER — in the tenant's Add app form (#233) and in the
 *  consumer wizard (#237) alike: shown only while the repository routes a scope to GitHub Packages
 *  and the owner records no token that reads it; asked once per owner, shown and replaced under
 *  Settings afterwards. The token goes to the record call and nowhere else. */
export function PackagesReaderStep({ reader, onRecord, subject }: Props) {
  const [token, setToken] = useState("");
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const record = async (e: FormEvent) => {
    e.preventDefault();
    setRecording(true);
    setError(null);
    try {
      await onRecord(reader.owner, token);
      setToken("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRecording(false);
    }
  };

  return (
    <form className="field" onSubmit={record}>
      <label className="field__label" htmlFor="packages-reader-token">
        Packages reader of {reader.owner}
      </label>
      <span className="field__hint">
        {subject} installs private npm packages of {reader.scopes.map((s) => `@${s}`).join(", ")} from GitHub Packages, and {reader.owner} records no token that
        reads them yet. Asked once, here: a classic PAT with read:packages, or a fine-grained PAT with Packages: Read for {reader.owner}. Measured against GitHub
        before it is sealed; only its fingerprint is kept, and it is shown and replaced under Settings afterwards.
      </span>
      <input id="packages-reader-token" className="input" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="ghp_… or github_pat_…" disabled={recording} />
      {error && (
        <p role="alert" className="alert alert--danger">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="btn btn--primary" disabled={recording || token.trim() === ""}>
          Record
        </button>
      </div>
    </form>
  );
}
