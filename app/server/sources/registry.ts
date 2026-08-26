import { feedAdapter } from "~/server/sources/adapters/feed";
import { gutendexAdapter } from "~/server/sources/adapters/gutendex";
import { opdsAdapter } from "~/server/sources/adapters/opds";
import { rulesAdapter } from "~/server/sources/adapters/rules";
import type { SourceAdapter } from "~/server/sources/types";

const adapters: SourceAdapter[] = [opdsAdapter, feedAdapter, gutendexAdapter, rulesAdapter];

const byKind = new Map(adapters.map((adapter) => [adapter.kind, adapter]));

export function getAdapter(kind: string): SourceAdapter {
  const adapter = byKind.get(kind);
  if (!adapter) throw new Error(`未知的源类型：${kind}`);
  return adapter;
}

export function listAdapters(): { kind: string; label: string; supportsSearch: boolean }[] {
  return adapters.map((adapter) => ({
    kind: adapter.kind,
    label: adapter.label,
    supportsSearch: typeof adapter.search === "function",
  }));
}
