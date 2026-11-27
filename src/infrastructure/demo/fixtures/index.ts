import type { DemoPullRequest } from "../types.js";
import { catalogCacheFiles, catalogCacheScript } from "./catalogCache.js";
import { couponFiles } from "./couponFiles.js";
import { couponScript } from "./couponScript.js";
import { expressBumpFiles, expressBumpScript } from "./expressBump.js";

const repository = { provider: "demo", owner: "acme", repo: "storefront" } as const;

export const DEMO_PULL_REQUESTS: readonly DemoPullRequest[] = [
  {
    ref: { ...repository, number: 128 },
    title: "Add coupon support to checkout",
    description:
      "Customers can now enter a coupon code at checkout.\n\n- Percent, fixed and free-shipping coupons\n- Usage limit and expiry\n- New `coupons` table\n\nCloses SHOP-412.",
    author: "marina-dev",
    baseBranch: "main",
    headBranch: "feature/checkout-coupons",
    baseSha: "9f1c2aa4d0b7e6135c8a4f2e7d9b0c1a2e3f4a5b",
    headSha: "4be07d1c9a3f5e2b8d6c0a7f1e4d3b2c5a6f7e80",
    updatedMinutesAgo: 6,
    files: couponFiles,
    script: couponScript,
  },
  {
    ref: { ...repository, number: 131 },
    title: "Cache product lookups in the catalog client",
    description: "Adds a small TTL cache in front of the catalog API to cut p95 latency on product pages.",
    author: "joao-backend",
    baseBranch: "main",
    headBranch: "perf/catalog-cache",
    baseSha: "9f1c2aa4d0b7e6135c8a4f2e7d9b0c1a2e3f4a5b",
    headSha: "c3d91f0a7b2e4c6d8f1a3b5c7d9e0f2a4b6c8d0e",
    updatedMinutesAgo: 38,
    files: catalogCacheFiles,
    script: catalogCacheScript,
  },
  {
    ref: { ...repository, number: 133 },
    title: "Bump express from 4.18.2 to 4.21.2",
    description: "Bumps express from 4.18.2 to 4.21.2. Includes upstream security fixes.",
    author: "dependabot[bot]",
    baseBranch: "main",
    headBranch: "dependabot/npm_and_yarn/express-4.21.2",
    baseSha: "9f1c2aa4d0b7e6135c8a4f2e7d9b0c1a2e3f4a5b",
    headSha: "71a0e5d3c9b8f7a6e5d4c3b2a1f0e9d8c7b6a594",
    updatedMinutesAgo: 124,
    files: expressBumpFiles,
    script: expressBumpScript,
  },
];
