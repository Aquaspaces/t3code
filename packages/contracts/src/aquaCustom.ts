/**
 * Aqua's custom build: what the running app was built from, and the state of
 * the local clone it updates from. Settings > My features renders these.
 */
import * as Schema from "effect/Schema";

export const AquaCommit = Schema.Struct({
  sha: Schema.String,
  subject: Schema.String,
});
export type AquaCommit = typeof AquaCommit.Type;

/** One entry in apps/web/src/aqua/features.json. */
export const AquaFeatureDefinition = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  defaultEnabled: Schema.Boolean,
  /** Always on; shown without a toggle. */
  locked: Schema.optionalKey(Schema.Boolean),
});
export type AquaFeatureDefinition = typeof AquaFeatureDefinition.Type;

/** Embedded in the packaged app's package.json by aqua/t3code-custom.ps1. */
export const AquaBuildInfo = Schema.Struct({
  repo: Schema.String,
  branch: Schema.String,
  baseTag: Schema.String,
  commit: Schema.String,
  builtAt: Schema.String,
  commits: Schema.Array(AquaCommit),
});
export type AquaBuildInfo = typeof AquaBuildInfo.Type;

export const AquaCloneStatus = Schema.Struct({
  checkedAt: Schema.String,
  repo: Schema.String,
  repoFound: Schema.Boolean,
  branch: Schema.NullOr(Schema.String),
  head: Schema.NullOr(Schema.String),
  dirty: Schema.Boolean,
  /** The nightly tag the custom branch sits on. */
  baseTag: Schema.NullOr(Schema.String),
  newestNightlyTag: Schema.NullOr(Schema.String),
  /** The fork on GitHub has the same custom branch commit as the clone. */
  pushed: Schema.Boolean,
  customCommits: Schema.Array(AquaCommit),
  features: Schema.Array(AquaFeatureDefinition),
  scheduledTask: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
export type AquaCloneStatus = typeof AquaCloneStatus.Type;

export const AquaCustomStatus = Schema.Struct({
  /** Null when the running app wasn't built by the custom build script. */
  build: Schema.NullOr(AquaBuildInfo),
  /** Null when there is no clone to check (not a custom build, or not Windows). */
  clone: Schema.NullOr(AquaCloneStatus),
});
export type AquaCustomStatus = typeof AquaCustomStatus.Type;

export interface AquaCustomBridge {
  /** Reads the clone's state. `fetch` also fetches GitHub first. */
  getStatus: (options: { readonly fetch: boolean }) => Promise<AquaCustomStatus>;
  openClone: () => Promise<void>;
  openLog: () => Promise<void>;
}
