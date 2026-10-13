import { createFileRoute } from "@tanstack/react-router";
import { AquaFeaturesSettingsPanel } from "../aqua/AquaFeaturesSettings";

export const Route = createFileRoute("/settings/my-features")({
  component: AquaFeaturesSettingsPanel,
});
