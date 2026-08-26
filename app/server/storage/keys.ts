export function chapterVersionKey(bookId: string, chapterId: string, versionId: string) {
  return `books/${bookId}/chapters/${chapterId}/versions/${versionId}.json`;
}

export function importSourceKey(bookId: string, jobId: string) {
  return `books/${bookId}/imports/${jobId}/source.txt`;
}

export function importReportKey(bookId: string, jobId: string) {
  return `books/${bookId}/imports/${jobId}/report.json`;
}

export function importConfirmPayloadKey(bookId: string, jobId: string) {
  return `books/${bookId}/imports/${jobId}/confirm-payload.json`;
}

export function importChapterKey(bookId: string, jobId: string, index: number) {
  return `books/${bookId}/imports/${jobId}/chapters/${index}.json`;
}

export function importChapterBatchKey(bookId: string, jobId: string, batchIndex: number) {
  return `books/${bookId}/imports/${jobId}/chapter-batches/${batchIndex}.json`;
}

export function coverKey(bookId: string, assetHash: string, width: "original" | "w320" | "w640") {
  return `covers/${bookId}/${assetHash}/${width}.webp`;
}
