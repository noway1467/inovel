import { describe, expect, it } from "vitest";
import { statusLabel } from "../../app/components/book/book-card";

describe("作品状态文案", () => {
  it("已发布且完结时显示已完结", () => {
    expect(statusLabel("published", "completed")).toBe("已完结");
  });

  it("已发布且连载时显示连载中", () => {
    expect(statusLabel("published", "ongoing")).toBe("连载中");
  });

  it("非发布状态优先显示审核或管理状态", () => {
    expect(statusLabel("draft", "completed")).toBe("草稿");
    expect(statusLabel("suspended", "completed")).toBe("已下架");
  });
});
