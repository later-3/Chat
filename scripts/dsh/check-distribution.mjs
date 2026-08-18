import { resolve } from "node:path";

import { assertDshPluginRegistry } from "./plugin-registry.mjs";
import { assertDshDistribution } from "./profile-runtime.mjs";

const root = resolve(import.meta.dirname, "../..");
assertDshPluginRegistry(root);
const distribution = assertDshDistribution(root);
console.log(`[dsh] distribution ready: dsh=0.1.0-rc.6, bridge=${distribution.bridgeBundlePath}`);
