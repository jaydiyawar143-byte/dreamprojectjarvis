import { z } from "zod";

export const META_GRAPH_API_HOST = "graph.facebook.com";
export const META_DEFAULT_API_VERSION = "v21.0";

const metaConfigSchema = z.object({
  accessToken: z.string().min(1, "META_ACCESS_TOKEN is required"),
  adAccountId: z.string().min(1, "META_AD_ACCOUNT_ID is required"),
  apiVersion: z.string().min(1).default(META_DEFAULT_API_VERSION),
  baseUrl: z.string().url().optional(),
  timeoutMs: z.coerce.number().positive().default(30000),
  maxRetries: z.coerce.number().nonnegative().default(0),
});

export type MetaConfig = z.infer<typeof metaConfigSchema>;

export interface MetaConfigInput {
  accessToken?: string;
  adAccountId?: string;
  apiVersion?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export function createMetaConfig(input: MetaConfigInput = {}): MetaConfig {
  const raw = {
    accessToken: input.accessToken ?? process.env.META_ACCESS_TOKEN,
    adAccountId: input.adAccountId ?? process.env.META_AD_ACCOUNT_ID,
    apiVersion: input.apiVersion ?? process.env.META_GRAPH_API_VERSION,
    baseUrl: input.baseUrl,
    timeoutMs: input.timeoutMs,
    maxRetries: input.maxRetries,
  };

  const result = metaConfigSchema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.flatten().fieldErrors;
    const messages = Object.entries(errors)
      .map(([k, v]) => `${k}: ${v?.join(", ")}`)
      .join("; ");
    throw new Error(`Meta Graph API configuration error: ${messages}`);
  }

  return result.data;
}

export function normalizeAccountId(accountId: string): string {
  const trimmed = accountId.trim();
  if (/^act_\d+$/.test(trimmed)) return trimmed;
  if (/^\d+$/.test(trimmed)) return `act_${trimmed}`;
  throw new Error(`Invalid Meta account ID format: "${accountId}". Expected numeric ID or act_<ID>.`);
}

export function buildBaseUrl(config: MetaConfig): string {
  if (config.baseUrl) return config.baseUrl.replace(/\/+$/, "");
  return `https://${META_GRAPH_API_HOST}/${config.apiVersion}`;
}

/**
 * Phase 15 — whether this deployment may publish to a Facebook Page.
 *
 * Its own switch, and off unless an operator says otherwise. The credentials
 * that read the ad account are the same ones a Page publisher would use, so
 * without this a deployment that only ever asked to READ its ads would find
 * itself able to POST publicly the day it was upgraded. Being able to publish
 * is something a deployment asks for, never something it is handed — the
 * rule BROWSER_ENABLED follows for opening web pages.
 *
 * Exactly "true" switches it on. Anything else — absent, empty, "1", "yes" —
 * leaves it off.
 */
export function isPagePublishingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MARKETING_PUBLISH_ENABLED === "true";
}
