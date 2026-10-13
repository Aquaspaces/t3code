/**
 * Aqua's custom features. Add an entry to features.json for each feature, then
 * gate it with `useAquaFeature("<id>")`. Settings > My features lists them and
 * stores the on/off choice in client settings (`customFeatures`).
 */
import { AquaFeatureDefinition, type ClientSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { useClientSettings } from "../hooks/useSettings";
import rawFeatures from "./features.json";

export const AQUA_FEATURES: ReadonlyArray<AquaFeatureDefinition> = Schema.decodeUnknownSync(
  Schema.Array(AquaFeatureDefinition),
)(rawFeatures);

const featuresById = new Map(AQUA_FEATURES.map((feature) => [feature.id, feature]));

export function isAquaFeatureEnabled(
  customFeatures: ClientSettings["customFeatures"],
  id: string,
): boolean {
  const feature = featuresById.get(id);
  if (!feature) return false;
  if (feature.locked) return true;
  return customFeatures[id] ?? feature.defaultEnabled;
}

export function useAquaFeature(id: string): boolean {
  const customFeatures = useClientSettings((settings) => settings.customFeatures);
  return isAquaFeatureEnabled(customFeatures, id);
}
