import { describe, expect, it } from "vitest";
import {
  getImportChapterDisposition,
  recoverStagedImportChapter,
} from "../../app/server/imports/service";

describe("import chapter recovery", () => {
  it("turns a missing staged entry into an editable empty chapter", () => {
    expect(
      recoverStagedImportChapter(undefined, {
        title: "Chapter 447",
        volumeTitle: "??",
        warning: "content missing",
      })
    ).toEqual({
      title: "Chapter 447",
      paragraphs: [],
      charCount: 0,
      warning: "content missing",
      contentMissing: true,
      volumeTitle: "??",
    });
  });

  it("keeps valid staged content intact", () => {
    const entry = { title: "Chapter 1", paragraphs: ["text"], charCount: 4 };
    expect(
      recoverStagedImportChapter(entry, {
        title: "fallback",
        volumeTitle: "??",
        warning: "content missing",
      })
    ).toEqual({ ...entry, volumeTitle: "??" });
  });

  it("keeps a missing-content chapter editable without blocking the selected publish mode", () => {
    expect(getImportChapterDisposition("publish", true)).toEqual({
      status: "draft",
      isPublished: false,
      submitForReview: false,
    });
    expect(getImportChapterDisposition("review", true)).toEqual({
      status: "draft",
      isPublished: false,
      submitForReview: false,
    });
  });

  it("preserves the requested mode for normal chapters", () => {
    expect(getImportChapterDisposition("publish", false)).toEqual({
      status: "published",
      isPublished: true,
      submitForReview: false,
    });
    expect(getImportChapterDisposition("review", false)).toEqual({
      status: "pending_review",
      isPublished: false,
      submitForReview: true,
    });
  });
});
