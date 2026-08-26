import type { R2Bucket } from "@cloudflare/workers-types";

export interface ChapterParagraph {
  id: string;
  text: string;
}

export interface ChapterContentDocument {
  version: number;
  bookId: string;
  chapterId: string;
  title: string;
  paragraphs: ChapterParagraph[];
  contentHash: string;
  wordCount: number;
}

export async function putChapterContent(
  bucket: R2Bucket,
  key: string,
  doc: ChapterContentDocument
): Promise<void> {
  const body = JSON.stringify(doc);
  await bucket.put(key, body, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { contentHash: doc.contentHash },
  });
}

export async function getChapterContent(
  bucket: R2Bucket,
  key: string
): Promise<ChapterContentDocument | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  const body = await object.text();
  return JSON.parse(body) as ChapterContentDocument;
}

export type R2PutBody = Parameters<R2Bucket["put"]>[1];

export async function putStream(bucket: R2Bucket, key: string, body: R2PutBody, contentType: string) {
  await bucket.put(key, body, { httpMetadata: { contentType } });
}
