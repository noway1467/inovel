import { createContext, RouterContextProvider } from "react-router";
import type { Env } from "~/types/env";

export interface CloudflareContextValue {
  env: Env;
  ctx: ExecutionContext;
}

export const cloudflareContext = createContext<CloudflareContextValue>();

export function createRequestContext(value: CloudflareContextValue) {
  const provider = new RouterContextProvider();
  provider.set(cloudflareContext, value);
  return provider;
}

