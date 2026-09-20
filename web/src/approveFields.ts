// WHAT A CREDENTIAL FIELD ON AN APPROVE CARD IS CALLED. A pure module beside passwordLoginState.ts,
// tailnetState.ts and machineIdentity.ts, for the reason those are: vitest runs with environment
// "node" and includes no .tsx, so wording left inside a form cannot be tested — and wording is the
// whole substance here.
//
// A PLAN ASKS FOR A CREDENTIAL BY KEY, and a key is addressed to the executor. `ansiwise-elevation`
// names the engine that the value is handed to (shared/approve.ts MACHINE_PASSWORD_SECRET); the
// person reading the card is being asked for the password of an account on a machine, and those two
// facts are not the same sentence. So the key stays the key on the wire and this is what the person
// reads above the box.
//
// WHAT THE PASSWORD IS SPENT ON IS THE RUN'S OWN ACCOUNT AND NOT THIS ONE. Four families of run kind
// ask for this credential and each spends it differently — a deployment also opens the first login
// with it and installs a key where this manager holds none, a redeploy re-establishes the states a
// deployed slave stands in, the password-login and tailnet kinds only raise their own commands — so
// the sentence common to all of them is here, and the rest is in each plan's summary, which the card
// renders above these fields.
import { MACHINE_PASSWORD_SECRET, BUILD_REPO_PAT_PREFIX } from "../../shared/approve.ts";

/** What the person reads under an OPTIONAL box: why they may leave it empty, and why they may not
 *  want to. Only a build unit's PAT is ever optional — the platform's GitHub App reaches the
 *  repository and stands in where no PAT is given (its token reads the organisation's private npm
 *  packages too, hostyour-cloud#235); a PAT is for packages of another organisation. */
export function optionalSecretFieldHint(key: string): string {
  if (key.startsWith(BUILD_REPO_PAT_PREFIX)) {
    return "Optional: the platform's GitHub App reaches this repository and is its identity where you leave this empty — leave it empty. Give a PAT only where the unit installs private npm packages of ANOTHER organisation, which the App's token cannot read.";
  }
  return "Optional: the run goes on without it.";
}

/** The prefix a consumer's own declared secret rides under. Stripped, because the name that follows
 *  it is the one the consumer's manifest declares and the one its author knows the value by. */
const CONSUMER_SECRET_PREFIX = "consumer-secret:";

/** What the person reads above the box. Total: a key this module has nothing to add to is shown as
 *  it is, which is a name the plan chose rather than a word invented here. */
export function secretFieldLabel(key: string): string {
  if (key === MACHINE_PASSWORD_SECRET) return "The password of the machine account this manager logs in as";
  if (key.startsWith(BUILD_REPO_PAT_PREFIX)) {
    return `A classic GitHub PAT for the repository of build unit "${key.slice(BUILD_REPO_PAT_PREFIX.length)}" (repo + workflow + admin:repo_hook + read:packages)`;
  }
  return key.startsWith(CONSUMER_SECRET_PREFIX) ? key.slice(CONSUMER_SECRET_PREFIX.length) : key;
}

/** What the person reads under the box, or null where the key says the whole of it. It states what
 *  the credential is used for and nothing about how long it lives: both forms already carry that
 *  sentence once, under the fields, for every credential on the card at once. */
export function secretFieldHint(key: string): string | null {
  if (key === MACHINE_PASSWORD_SECRET) return "Every command this run sends to root is raised with it, and the run stops rather than going on without it.";
  if (key.startsWith(BUILD_REPO_PAT_PREFIX)) return "Asked once: this run registers the unit and seeds the PAT into the build plane, and the next tenant asks for nothing.";
  return null;
}
