import { useEffect, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { createRoutesStub, Outlet, useNavigate } from "react-router";
import ReaderPage from "~/routes/reader";
import SourceChapterPage from "~/routes/source-chapter";
import { encodeSourceRef } from "~/lib/source-ref";
import "~/app.css";

// 真实阅读组件 + 真实 Router 导航，只替换 loader，确定性模拟慢网与取消。
// 不读写开发数据库，也不依赖第三方书源的可用性。
declare global {
  interface Window {
    readerNavigationTest: {
      requests: number;
      aborted: number;
      hold: boolean;
      fail: boolean;
      release: () => void;
      back: () => void;
    };
  }
}

const options = new URLSearchParams(location.search);
const source = options.get("kind") === "source";
const longFirstChapter = options.has("long");
const bookUrl = "https://reader.test/book";
const chapterKey = (index: number) => `https://reader.test/chapter/${index}`;
const sourceHref = (index: number) =>
  `/source/test/chapter?key=${encodeSourceRef(chapterKey(index))}&book=${encodeSourceRef(bookUrl)}&title=测试书&i=${index}`;
const firstHref = source ? sourceHref(0) : "/read/test/0";
const releases = new Set<() => void>();
const state: Window["readerNavigationTest"] = (window.readerNavigationTest = {
  requests: 0,
  aborted: 0,
  hold: true,
  fail: false,
  release() {
    state.hold = false;
    for (const release of releases) release();
    releases.clear();
  },
  back() {},
});

export function Controls() {
  const navigate = useNavigate();
  useEffect(() => {
    state.back = () => void navigate(firstHref);
  }, [navigate]);
  return <Outlet />;
}

const Stub = createRoutesStub([
  {
    Component: Controls,
    children: [
      {
        path: source ? "/source/:sourceId/chapter" : "/read/:bookId/:chapterId",
        // createRoutesStub 会注入实际 Route.ComponentProps；这里仅收窄测试工厂的宽泛类型。
        Component: (source ? SourceChapterPage : ReaderPage) as unknown as ComponentType,
        ErrorBoundary: () => <h1>章节加载失败</h1>,
        async loader({ request, params }) {
          const index = source
            ? Number(new URL(request.url).searchParams.get("i"))
            : Number(params.chapterId);
          if (index > 0) {
            state.requests += 1;
            if (state.hold) {
              await new Promise<void>((resolve) => {
                const finish = () => {
                  releases.delete(finish);
                  request.signal.removeEventListener("abort", abort);
                  resolve();
                };
                const abort = () => {
                  state.aborted += 1;
                  finish();
                };
                releases.add(finish);
                request.signal.addEventListener("abort", abort, { once: true });
              });
            }
            if (state.fail) {
              if (source) {
                return { error: "模拟加载失败", chapter: null, sourceId: "test", bookUrl };
              }
              throw new Response("模拟加载失败", { status: 503 });
            }
          }
          const title = `第${index + 1}章`;
          const paragraphs = Array.from(
            { length: index > 0 || longFirstChapter ? 40 : 1 },
            (_, i) => `第${i + 1}段。这是用于验证阅读翻页和章节切换的测试正文。`.repeat(4)
          );
          const preferences = { paginationMode: "cover", theme: "paper" };
          if (source) {
            return {
              error: null,
              sourceId: "test",
              bookTitle: "测试书",
              bookUrl,
              chapter: { chapterKey: chapterKey(index), sourceName: "测试源", paragraphs },
              nav: {
                title,
                prev: index > 0 ? { key: chapterKey(index - 1), index: index - 1 } : null,
                next: { key: chapterKey(index + 1), index: index + 1 },
                currentIndex: index,
                totalChapters: 3,
                position: `${index + 1}/3`,
              },
              preferences,
              inShelf: false,
              resumePageIndex: 0,
            };
          }
          return {
            chapter: { id: String(index), bookId: "test", bookTitle: "测试书", title },
            content: { paragraphs: paragraphs.map((text, i) => ({ id: `c${index}-p${i}`, text })) },
            prev: index > 0 ? { id: String(index - 1) } : null,
            next: { id: String(index + 1) },
            progress: null,
            preferences,
            inShelf: false,
            currentIndex: index,
            totalChapters: 3,
          };
        },
      },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(<Stub initialEntries={[firstHref]} />);
