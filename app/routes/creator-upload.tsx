import { useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { Link } from "react-router";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileUp,
  FolderOpen,
  Loader2,
  Trash2,
  UploadCloud,
} from "lucide-react";
import type { Route } from "./+types/creator-upload";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Progress } from "~/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { EmptyState } from "~/components/state/empty-state";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { createAuth } from "~/server/auth";
import { getMaxUploadMb, getMaxUploadMbForFormat } from "~/server/settings/import-limits";
import { books, tags } from "drizzle/schema";
import { asc, desc, eq } from "drizzle-orm";
import { ensureAuthorProfile } from "~/server/creator/profile";
import { listEnabledCategories } from "~/server/repositories/categories";
import { listImportJobs, type ImportJobView } from "~/server/imports/service";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  const db = createDb(env.DB_APP);
  const maxUploadBytes = (await getMaxUploadMb(db)) * 1024 * 1024;
  const formatLimits = Object.fromEntries(
    await Promise.all(
      (["txt", "epub", "mobi", "pdf"] as const).map(async (ext) => [
        ext,
        (await getMaxUploadMbForFormat(db, ext)) * 1024 * 1024,
      ])
    )
  ) as Record<string, number>;
  if (!session?.user) {
    return {
      user: null,
      isAuthor: false,
      books: [],
      jobs: [],
      categories: [],
      availableTags: [],
      maxUploadBytes,
      formatLimits,
    };
  }
  const author = await ensureAuthorProfile(db, session.user.id);
  if (!author) {
    return {
      user: session.user,
      isAuthor: false,
      books: [],
      jobs: [],
      categories: [],
      availableTags: [],
      maxUploadBytes,
      formatLimits,
    };
  }
  const [bookRows, categories, tagRows] = await Promise.all([
    db
      .select({ id: books.id, title: books.title, status: books.status })
      .from(books)
      .where(eq(books.authorId, author.id))
      .orderBy(desc(books.updatedAt))
      .limit(50),
    listEnabledCategories(db),
    db
      .select({ id: tags.id, name: tags.name })
      .from(tags)
      .where(eq(tags.enabled, true))
      .orderBy(asc(tags.name))
      .limit(100),
  ]);
  const jobs = await listImportJobs(db, env.R2_CONTENT, session.user.id);
  return {
    user: session.user,
    isAuthor: true,
    books: bookRows,
    jobs,
    categories,
    availableTags: tagRows,
    maxUploadBytes,
    formatLimits,
  };
}

interface SelectedFile {
  file: File;
  path: string;
}

interface JobMetadataDraft {
  categoryId: string;
  categoryName: string;
  serialStatus: "ongoing" | "completed";
  tagsText: string;
  authorName: string;
}

const supportedExtensions = new Set(["txt", "epub", "mobi", "pdf"]);

function isSupported(file: File): boolean {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return supportedExtensions.has(ext);
}

function baseNameWithoutExtension(pathOrName: string) {
  const name = pathOrName.split(/[\\/]/).pop() ?? pathOrName;
  return name.replace(/\.[^.]+$/, "");
}

function parseApiJson<T extends { error?: string }>(raw: string, status: number): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return { error: raw.trim().slice(0, 200) || `HTTP ${status}` } as T;
  }
}
const capacityLimitMessage =
  "当前操作已触发并发或 Worker 资源上限（Error 1102），已立即停止，不会自动等待后继续。请减少同时导入的任务数，或拆分文件后手动重试。";

function isCapacityLimitResponse(status: number, raw: string) {
  return (
    status === 429 ||
    status >= 500 ||
    /(?:error\s*1102|worker exceeded resource limits|too many requests|concurren|cpu time limit)/i.test(
      raw
    )
  );
}

function responseErrorMessage(status: number, raw: string, fallback: string) {
  if (isCapacityLimitResponse(status, raw)) return capacityLimitMessage;
  return parseApiJson<{ error?: string }>(raw, status).error ?? fallback;
}

function statusText(status: string) {
  const map: Record<string, string> = {
    uploading: "上传中",
    uploaded: "已上传",
    parsing: "解析中",
    awaiting_confirmation: "待确认",
    importing: "导入中",
    completed: "已完成",
    failed: "失败",
  };
  return map[status] ?? status;
}

export default function CreatorUploadPage({ loaderData }: Route.ComponentProps) {
  const [mode, setMode] = useState<"existing" | "new">("new");
  const [bookId, setBookId] = useState("");
  const [title, setTitle] = useState("");
  const [splitChars, setSplitChars] = useState(0);
  const [selectedFiles, setSelectedFiles] = useState<SelectedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadIndex, setUploadIndex] = useState(0);
  const [uploadingDetail, setUploadingDetail] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [jobs, setJobs] = useState<ImportJobView[]>(loaderData.jobs ?? []);
  const jobsRef = useRef(jobs);
  const pausedPollingIdsRef = useRef(new Set<string>());
  const [renames, setRenames] = useState<Record<string, Record<number, string>>>({});
  const [ignored, setIgnored] = useState<Record<string, Set<number>>>({});
  const [confirmingId, setConfirmingId] = useState("");
  const [retryingId, setRetryingId] = useState("");
  const [confirmingDetail, setConfirmingDetail] = useState("");
  const [deletingBookId, setDeletingBookId] = useState("");
  const [expandedJobs, setExpandedJobs] = useState<Set<string>>(new Set());
  const [confirmingProgress, setConfirmingProgress] = useState({ imported: 0, total: 0 });
  const [metadataDrafts, setMetadataDrafts] = useState<Record<string, JobMetadataDraft>>({});
  const [skipReview, setSkipReview] = useState(false);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [confirmDialogJob, setConfirmDialogJob] = useState<ImportJobView | null>(null);
  const [confirmTitle, setConfirmTitle] = useState("");
  const [confirmReparse, setConfirmReparse] = useState(false);
  const [reparsing, setReparsing] = useState(false);
  const dragDepthRef = useRef(0);

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  useEffect(() => {
    setJobs(loaderData.jobs ?? []);
  }, [loaderData.jobs]);

  // 刷新后仍在解析的任务继续轮询，解析完成自动进入待导入池
  useEffect(() => {
    let cancelled = false;
    const timer = setInterval(async () => {
      const pending = jobsRef.current.filter(
        (job) =>
          (job.status === "uploaded" || job.status === "parsing") &&
          !pausedPollingIdsRef.current.has(job.id)
      );
      const importing = jobsRef.current.filter(
        (job) => job.status === "importing" && !pausedPollingIdsRef.current.has(job.id)
      );
      if ((pending.length === 0 && importing.length === 0) || cancelled) return;

      const updated: ImportJobView[] = [];
      for (const job of pending) {
        try {
          const response = await fetch(`/api/creator/imports/${job.id}`, { cache: "no-store" });
          const raw = await response.text();
          if (!response.ok) {
            pausedPollingIdsRef.current.add(job.id);
            setError(
              responseErrorMessage(
                response.status,
                raw,
                "读取导入任务失败，已停止自动轮询，不会自动继续。请手动点击重试解析。"
              )
            );
            break;
          }
          const data = parseApiJson<{ error?: string; job?: ImportJobView }>(raw, response.status);
          if (!data.job) {
            pausedPollingIdsRef.current.add(job.id);
            setError("读取导入任务失败，已停止自动轮询，不会自动继续。请手动点击重试解析。");
            break;
          }
          updated.push(data.job);
        } catch {
          pausedPollingIdsRef.current.add(job.id);
          setError("网络连接中断，当前操作已停止，不会自动继续。");
          break;
        }
      }
      const removedIds = new Set<string>();
      for (const job of importing) {
        try {
          const response = await fetch(`/api/creator/imports/${job.id}?progress=1`, {
            cache: "no-store",
          });
          const raw = await response.text();
          if (!response.ok) {
            pausedPollingIdsRef.current.add(job.id);
            continue;
          }
          const data = parseApiJson<{ error?: string; job?: ImportJobView }>(raw, response.status);
          if (!data.job) {
            pausedPollingIdsRef.current.add(job.id);
            continue;
          }
          const current = data.job;
          if (current.status === "completed") {
            removedIds.add(job.id);
            setNotice(`《${job.bookTitle || job.sourceName}》导入完成`);
          } else if (current.status === "failed") {
            pausedPollingIdsRef.current.add(job.id);
            setError(current.errorMessage ?? "导入失败，请稍后重试");
          } else if (current.status === "importing") {
            updated.push({
              ...job,
              status: current.status,
              commitCursor: current.commitCursor,
              errorMessage: current.errorMessage,
            });
          }
        } catch {
          pausedPollingIdsRef.current.add(job.id);
        }
      }
      if (cancelled) return;
      if (removedIds.size > 0) {
        setJobs((prev) => prev.filter((item) => !removedIds.has(item.id)));
      }
      if (updated.length > 0) {
        setJobs((prev) =>
          prev.map((item) => updated.find((candidate) => candidate.id === item.id) ?? item)
        );
      }
    }, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!loaderData.user) {
    return (
      <div className="mx-auto max-w-md">
        <EmptyState
          title="登录后上传小说"
          description="支持 TXT、EPUB、MOBI、PDF，可多选或选择文件夹批量导入。"
          action={
            <Button asChild>
              <Link to="/login?redirect=/creator/upload">去登录</Link>
            </Button>
          }
        />
      </div>
    );
  }

  if (!loaderData.isAuthor) {
    return (
      <div className="mx-auto max-w-md">
        <EmptyState
          title="需要作者权限"
          description="发布和编辑入口仅向作者开放，请联系管理员为账号添加作者角色。"
          action={
            <Button variant="outline" asChild>
              <Link to="/library">返回书架</Link>
            </Button>
          }
        />
      </div>
    );
  }

  function addFiles(fileList: FileList | null) {
    if (!fileList) return;
    const next: SelectedFile[] = [];
    for (const file of Array.from(fileList)) {
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      if (!isSupported(file)) {
        setError(`${file.name} 不是支持的格式（TXT/EPUB/MOBI/PDF）`);
        continue;
      }
      const formatLimit = loaderData.formatLimits[ext] ?? loaderData.maxUploadBytes;
      if (file.size > formatLimit) {
        setError(
          `${file.name} 超过 ${Math.round(formatLimit / 1024 / 1024)}MB 上传上限（${ext.toUpperCase()}）`
        );
        continue;
      }
      next.push({ file, path: file.webkitRelativePath || file.name });
    }
    if (next.length > 0) {
      setError("");
      setSelectedFiles((prev) => [...prev, ...next]);
    }
  }

  function onDragEnter(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingFiles(true);
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDraggingFiles(false);
  }

  function onDropFiles(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingFiles(false);
    addFiles(event.dataTransfer.files);
  }

  const chunkedThreshold = Math.min(loaderData.maxUploadBytes, 8 * 1024 * 1024);

  async function waitForParsed(job: ImportJobView): Promise<ImportJobView> {
    let current = job;
    if (["awaiting_confirmation", "completed", "failed"].includes(current.status)) return current;
    for (let attempt = 0; attempt < 200; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      setUploadingDetail("正在等待解析完成…");
      let response: Response;
      try {
        response = await fetch(`/api/creator/imports/${current.id}`, { cache: "no-store" });
      } catch {
        pausedPollingIdsRef.current.add(current.id);
        throw new Error("网络连接中断，当前操作已停止，不会自动继续。");
      }
      const raw = await response.text();
      if (!response.ok) {
        pausedPollingIdsRef.current.add(current.id);
        throw new Error(
          responseErrorMessage(
            response.status,
            raw,
            "读取导入任务失败，已停止自动轮询，不会自动继续。请手动点击重试解析。"
          )
        );
      }
      const data = parseApiJson<{ error?: string; job?: ImportJobView }>(raw, response.status);
      if (!data.job) {
        pausedPollingIdsRef.current.add(current.id);
        throw new Error("读取导入任务失败，已停止自动轮询，不会自动继续。请手动点击重试解析。");
      }
      current = data.job;
      if (["awaiting_confirmation", "completed", "failed"].includes(current.status)) return current;
    }
    return current;
  }

  async function uploadDirect(selected: SelectedFile, bookTitle: string): Promise<ImportJobView> {
    const formData = new FormData();
    formData.set("file", selected.file, selected.path);
    formData.set("splitChars", String(splitChars));
    if (mode === "existing") formData.set("bookId", bookId);
    if (mode === "new") formData.set("title", bookTitle);
    const response = await fetch("/api/creator/imports", { method: "POST", body: formData });
    const raw = await response.text();
    const data = parseApiJson<{ error?: string; job?: ImportJobView }>(raw, response.status);
    if (!response.ok || !data.job) throw new Error(data.error ?? "上传失败");
    return waitForParsed(data.job);
  }

  async function uploadChunked(selected: SelectedFile, bookTitle: string): Promise<ImportJobView> {
    const initResponse = await fetch("/api/creator/imports/chunked", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: mode === "new" ? bookTitle : undefined,
        bookId: mode === "existing" ? bookId : undefined,
        fileName: selected.path,
        fileSize: selected.file.size,
        splitChars,
      }),
    });
    const initRaw = await initResponse.text();
    const initData = parseApiJson<{ error?: string; jobId?: string; partSize?: number }>(
      initRaw,
      initResponse.status
    );
    if (!initResponse.ok || !initData.jobId || !initData.partSize) {
      throw new Error(initData.error ?? "初始化上传失败");
    }

    const { jobId, partSize } = initData;
    const parts: { partNumber: number; etag: string }[] = [];
    const totalParts = Math.max(1, Math.ceil(selected.file.size / partSize));
    let uploadedParts = 0;
    try {
      // 两片并发能明显缩短大文件上传时间，同时把单请求控制在 8MB，避免 50MB multipart
      // 在 Worker 里被 formData + arrayBuffer 再复制一遍。
      await runWithConcurrency(
        Array.from({ length: totalParts }, (_, index) => index + 1),
        1,
        async (partNumber) => {
          const start = (partNumber - 1) * partSize;
          const blob = selected.file.slice(start, start + partSize);
          const partResponse = await fetch(
            `/api/creator/imports/chunked/${jobId}/part/${partNumber}`,
            { method: "PUT", body: blob }
          );
          const partRaw = await partResponse.text();
          const partData = parseApiJson<{
            error?: string;
            part?: { partNumber: number; etag: string };
          }>(partRaw, partResponse.status);
          if (!partResponse.ok || !partData.part) {
            throw new Error(partData.error ?? `分片 ${partNumber} 上传失败`);
          }
          parts.push(partData.part);
          uploadedParts += 1;
          setUploadingDetail(`上传中 ${uploadedParts}/${totalParts}`);
        }
      );
    } catch (error) {
      await fetch(`/api/creator/imports/chunked/${jobId}/abort`, { method: "POST" }).catch(
        () => {}
      );
      throw error;
    }

    setUploadingDetail("合并解析中…");
    const completeResponse = await fetch(`/api/creator/imports/chunked/${jobId}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts, splitChars }),
    });
    const completeRaw = await completeResponse.text();
    const completeData = parseApiJson<{ error?: string; job?: ImportJobView }>(
      completeRaw,
      completeResponse.status
    );
    if (!completeResponse.ok || !completeData.job)
      throw new Error(completeData.error ?? "完成上传失败");
    return waitForParsed(completeData.job);
  }

  async function runWithConcurrency<T>(
    items: T[],
    limit: number,
    task: (item: T, index: number) => Promise<void>
  ) {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        const item = items[index];
        if (item) await task(item, index);
      }
    });
    await Promise.all(workers);
  }

  async function uploadOne(selected: SelectedFile, index: number) {
    const placeholderId = `pending-${Date.now()}-${index}`;
    const ext = selected.file.name.split(".").pop()?.toLowerCase() ?? "";
    const placeholder: ImportJobView = {
      id: placeholderId,
      bookId: "",
      commitCursor: null,
      bookTitle: "",
      bookAuthorName: "",
      sourceAuthorName: null,
      bookCategoryId: null,
      bookSerialStatus: "ongoing",
      bookTags: [],
      sourceName: selected.path,
      sourceSize: selected.file.size,
      encoding: null,
      format: ext,
      status: "uploading",
      reportKey: null,
      errorMessage: null,
      candidates: [],
      warnings: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setJobs((prev) => [...prev, placeholder]);
    setUploadIndex(index + 1);
    try {
      const bookTitle =
        mode === "new"
          ? selectedFiles.length === 1 && title.trim()
            ? title.trim()
            : baseNameWithoutExtension(selected.path)
          : "";
      const job =
        selected.file.size > chunkedThreshold
          ? await uploadChunked(selected, bookTitle)
          : await uploadDirect(selected, bookTitle);
      setJobs((prev) => [
        ...prev.filter((item) => item.id !== placeholderId && item.id !== job.id),
        job,
      ]);
      if (job.status === "failed") {
        setError(`${selected.path}：${job.errorMessage ?? "解析失败"}`);
      } else if (job.status === "uploaded" || job.status === "parsing") {
        setNotice(`${selected.path} 解析仍在进行，完成后会自动进入待导入池`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const failed: ImportJobView = { ...placeholder, status: "failed", errorMessage: detail };
      setJobs((prev) => prev.map((item) => (item.id === placeholderId ? failed : item)));
      setError(`${selected.path}：${detail}`);
    } finally {
      setUploadingDetail("");
    }
  }

  async function uploadAll() {
    setError("");
    setNotice("");
    if (selectedFiles.length === 0) {
      setError("请选择要上传的小说文件或文件夹");
      return;
    }
    if (mode === "existing" && !bookId) {
      setError("请选择已有作品");
      return;
    }

    setUploading(true);
    try {
      // 重型解析任务逐本排队，避免多个文件同时抢占 Worker CPU、R2 与 D1。
      // 慢一点但稳定完成，比把三本一起塞进去然后收获 1102 乖多了。
      await runWithConcurrency(selectedFiles, 1, async (selected, index) => {
        setUploadingDetail(`正在处理第 ${index + 1}/${selectedFiles.length} 本`);
        await uploadOne(selected, index);
      });
      setSelectedFiles([]);
    } finally {
      setUploadingDetail("");
      setUploading(false);
    }
  }

  function metadataFor(job: ImportJobView): JobMetadataDraft {
    return (
      metadataDrafts[job.id] ?? {
        categoryId: job.bookCategoryId ?? "",
        categoryName: "",
        serialStatus: job.bookSerialStatus,
        tagsText: job.bookTags.join("，"),
        authorName: "",
      }
    );
  }

  function updateMetadata(job: ImportJobView, patch: Partial<JobMetadataDraft>) {
    const fallback: JobMetadataDraft = {
      categoryId: job.bookCategoryId ?? "",
      categoryName: "",
      serialStatus: job.bookSerialStatus,
      tagsText: job.bookTags.join("，"),
      authorName: "",
    };
    setMetadataDrafts((prev) => ({
      ...prev,
      [job.id]: { ...fallback, ...prev[job.id], ...patch },
    }));
  }

  function parseTagNames(value: string) {
    return [
      ...new Set(
        value
          .split(/[,，、\s]+/)
          .map((name) => name.trim())
          .filter(Boolean)
      ),
    ].slice(0, 10);
  }

  function toggleMetadataTag(job: ImportJobView, tagName: string) {
    const current = metadataFor(job);
    const names = parseTagNames(current.tagsText);
    const next = names.includes(tagName)
      ? names.filter((name) => name !== tagName)
      : [...names, tagName].slice(0, 10);
    updateMetadata(job, { tagsText: next.join("，") });
  }

  async function confirmJob(job: ImportJobView, titleOverride?: string) {
    if (confirmingId) return;
    const total = job.candidates.filter(
      (candidate) => !(ignored[job.id]?.has(candidate.index) ?? false)
    ).length;
    if (total === 0) {
      setError("请至少保留一个章节再确认导入");
      return;
    }

    const metadata = metadataFor(job);
    const initialImported = Math.min(total, job.commitCursor ?? 0);
    setConfirmingId(job.id);
    setConfirmingProgress({ imported: initialImported, total });
    setConfirmingDetail(
      initialImported > 0 ? `继续导入 ${initialImported}/${total} 章…` : `准备导入 0/${total} 章…`
    );
    setError("");
    const actions = job.candidates.flatMap((candidate) => {
      const isIgnored = ignored[job.id]?.has(candidate.index) ?? false;
      const renamedTitle = renames[job.id]?.[candidate.index]?.trim();
      if (!isIgnored && (!renamedTitle || renamedTitle === candidate.title)) return [];
      return [
        {
          index: candidate.index,
          action: (isIgnored ? "ignore" : "keep") as "keep" | "ignore",
          title: renamedTitle,
        },
      ];
    });

    const buildBody = () =>
      JSON.stringify({
        actions,
        title: titleOverride?.trim() || undefined,
        publishMode: skipReview ? "publish" : "review",
        categoryId: metadata.categoryId || null,
        categoryName: metadata.categoryName.trim() || undefined,
        tags: parseTagNames(metadata.tagsText),
        serialStatus: metadata.serialStatus,
        authorName: metadata.authorName.trim() || null,
      });

    const finishJob = async (imported: number, importWarnings: string[]) => {
      const warningSuffix = importWarnings.length
        ? ` \u5176\u4e2d ${importWarnings.join("\uff1b")}\uff0c\u8bf7\u5230\u7ae0\u8282\u7f16\u8f91\u5668\u8865\u6b63\u6587\u3002`
        : "";
      setNotice(
        `\u5df2\u5bfc\u5165 ${imported} \u4e2a\u7ae0\u8282${skipReview ? "\u5e76\u76f4\u63a5\u53d1\u5e03" : "\u5e76\u63d0\u4ea4\u5ba1\u6838"}\u3002${warningSuffix}`
      );
      setJobs((prev) => prev.filter((item) => item.id !== job.id));
      setRenames((prev) => {
        const next = { ...prev };
        delete next[job.id];
        return next;
      });
      setIgnored((prev) => {
        const next = { ...prev };
        delete next[job.id];
        return next;
      });
      setMetadataDrafts((prev) => {
        const next = { ...prev };
        delete next[job.id];
        return next;
      });
      const refreshResponse = await fetch("/api/creator/imports", { cache: "no-store" });
      if (refreshResponse.ok) {
        const refreshData = (await refreshResponse.json()) as { jobs?: ImportJobView[] };
        setJobs(refreshData.jobs ?? []);
      }
    };

    try {
      // 先让浏览器完成一次绘制，确保用户立即看到进度已启动。
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const response = await fetch(`/api/creator/imports/${job.id}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: buildBody(),
      });
      const raw = await response.text();
      if (!response.ok) {
        setError(responseErrorMessage(response.status, raw, "启动导入失败，请稍后重试。"));
        return;
      }
      const data = parseApiJson<{
        error?: string;
        imported?: number;
        done?: boolean;
        warnings?: string[];
      }>(raw, response.status);
      if (data.done) {
        await finishJob(total, data.warnings ?? []);
        return;
      }
      setJobs((prev) =>
        prev.map((item) =>
          item.id === job.id
            ? {
                ...item,
                status: "importing",
                commitCursor: data.imported ?? job.commitCursor ?? 0,
              }
            : item
        )
      );
      let imported = Math.min(total, data.imported ?? job.commitCursor ?? 0);
      setConfirmingProgress({ imported, total });
      const importWarnings: string[] = [...(data.warnings ?? [])];
      let stalledCount = 0;
      let lastImported = imported;
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        let progressResponse: Response;
        try {
          progressResponse = await fetch(`/api/creator/imports/${job.id}?progress=1`, {
            cache: "no-store",
          });
        } catch {
          throw new Error("网络连接中断，当前操作已停止，不会自动继续。");
        }
        const progressRaw = await progressResponse.text();
        if (!progressResponse.ok) {
          setError(
            responseErrorMessage(
              progressResponse.status,
              progressRaw,
              "读取导入进度失败，已停止轮询。"
            )
          );
          if (isCapacityLimitResponse(progressResponse.status, progressRaw)) {
            pausedPollingIdsRef.current.add(job.id);
          }
          return;
        }
        const progressData = parseApiJson<{ error?: string; job?: ImportJobView }>(
          progressRaw,
          progressResponse.status
        );
        const current = progressData.job;
        if (!current) {
          setError("读取导入进度失败，已停止轮询。");
          return;
        }
        imported = Math.min(total, current.commitCursor ?? imported);
        setConfirmingProgress({ imported, total });
        if (current.status === "completed") {
          setConfirmingDetail(`导入完成 ${imported}/${total} 章`);
          await finishJob(imported, importWarnings);
          return;
        }
        if (current.status === "failed") {
          setError(current.errorMessage ?? "导入失败，请稍后重试");
          setJobs((prev) =>
            prev.map((item) =>
              item.id === job.id
                ? { ...item, status: "failed", errorMessage: current.errorMessage }
                : item
            )
          );
          return;
        }
        if (current.status !== "importing") {
          setError(`导入状态异常（${current.status}），已停止轮询。`);
          return;
        }
        setConfirmingDetail(`正在导入 ${imported}/${total} 章…`);
        if (imported === lastImported) {
          stalledCount += 1;
        } else {
          stalledCount = 0;
          lastImported = imported;
        }
        if (stalledCount >= 10) {
          // 队列消息可能丢失，重新入队续传；失败则下一轮再试。
          stalledCount = 0;
          try {
            await fetch(`/api/creator/imports/${job.id}/confirm`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              cache: "no-store",
              body: buildBody(),
            });
          } catch {
            // 忽略，等待下一轮轮询
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      setError(`${message}，操作已停止，不会自动继续；已完成的进度会保留。`);
    } finally {
      setConfirmingId("");
      setConfirmingDetail("");
    }
  }

  function openConfirmDialog(job: ImportJobView) {
    setConfirmTitle(job.bookTitle || baseNameWithoutExtension(job.sourceName));
    setConfirmReparse(false);
    setConfirmDialogJob(job);
    setError("");
  }

  async function reparseWithChars(job: ImportJobView, chars: number) {
    const response = await fetch(`/api/creator/imports/${job.id}/reparse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ splitChars: chars }),
    });
    const raw = await response.text();
    const data = parseApiJson<{ error?: string; job?: ImportJobView }>(raw, response.status);
    if (!response.ok || !data.job) throw new Error(data.error ?? "重新划分章节失败");
    const parsed = await waitForParsed(data.job);
    if (parsed.status === "failed") {
      throw new Error(parsed.errorMessage ?? "重新划分章节失败");
    }
    setJobs((prev) => prev.map((item) => (item.id === job.id ? parsed : item)));
    setRenames((prev) => {
      const next = { ...prev };
      delete next[job.id];
      return next;
    });
    setIgnored((prev) => {
      const next = { ...prev };
      delete next[job.id];
      return next;
    });
    return parsed;
  }

  async function handleConfirmDialog() {
    if (!confirmDialogJob || confirmingId || reparsing) return;
    const title = confirmTitle.trim();
    if (!title) {
      setError("书名不能为空");
      return;
    }
    setError("");
    let job = confirmDialogJob;
    if (confirmReparse) {
      setReparsing(true);
      try {
        job = await reparseWithChars(job, 5000);
        setConfirmDialogJob(job);
      } catch (error) {
        setError(error instanceof Error ? error.message : "重新划分章节失败");
        return;
      } finally {
        setReparsing(false);
      }
    }
    setConfirmDialogJob(null);
    await confirmJob(job, title);
  }

  async function deleteWholeBook(job: ImportJobView) {
    if (confirmingId || deletingBookId) return;
    const confirmed = window.confirm(
      `确定删除《${job.bookTitle || job.sourceName}》整本书吗？章节、导入任务和作品信息都会删除，且无法恢复。`
    );
    if (!confirmed) return;
    setDeletingBookId(job.bookId);
    setError("");
    try {
      const response = await fetch(`/api/creator/books/${job.bookId}`, {
        method: "DELETE",
        cache: "no-store",
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "删除整本书失败");
      setJobs((prev) => prev.filter((item) => item.bookId !== job.bookId));
      setMetadataDrafts((prev) => {
        const next = { ...prev };
        for (const item of jobsRef.current) {
          if (item.bookId === job.bookId) delete next[item.id];
        }
        return next;
      });
      setNotice(`《${job.bookTitle || job.sourceName}》已整本删除`);
    } catch (error) {
      setError(error instanceof Error ? error.message : "删除整本书失败");
    } finally {
      setDeletingBookId("");
    }
  }

  async function retryJob(job: ImportJobView) {
    pausedPollingIdsRef.current.delete(job.id);
    setRetryingId(job.id);
    setError("");
    try {
      const response = await fetch(`/api/creator/imports/${job.id}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ splitChars }),
      });
      const data = (await response.json()) as { error?: string; job?: ImportJobView };
      if (!response.ok || !data.job) {
        setError(data.error ?? "重试失败");
        return;
      }
      const parsed = await waitForParsed(data.job);
      setJobs((prev) => prev.map((item) => (item.id === job.id ? parsed : item)));
      if (parsed.status === "failed") {
        setError(parsed.errorMessage ?? "解析仍然失败，请检查文件内容");
      } else if (parsed.status === "uploaded" || parsed.status === "parsing") {
        setNotice(`${job.sourceName} 解析仍在进行，完成后会自动进入待导入池`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "重试失败");
    } finally {
      setRetryingId("");
    }
  }

  function toggleIgnore(jobId: string, index: number) {
    setIgnored((prev) => {
      const next = new Set(prev[jobId] ?? []);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return { ...prev, [jobId]: next };
    });
  }

  function rename(jobId: string, index: number, value: string) {
    setRenames((prev) => ({ ...prev, [jobId]: { ...(prev[jobId] ?? {}), [index]: value } }));
  }

  function toggleJobExpanded(jobId: string) {
    setExpandedJobs((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }

  const parsingJobs = jobs.filter(
    (job) => job.status === "uploaded" || job.status === "parsing" || job.status === "failed"
  );
  const pendingImportJobs = jobs.filter(
    (job) => job.status === "awaiting_confirmation" || job.status === "importing"
  );

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold tracking-[0.2em] text-primary">书籍导入</p>
            <h1 className="mt-1 font-serif text-2xl font-semibold">导入小说</h1>
          </div>
          <Badge variant="secondary">TXT · EPUB · MOBI · PDF</Badge>
        </div>
      </header>

      <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm sm:p-6">
        <div className="mb-4 flex items-start gap-3">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
            1
          </span>
          <div>
            <h2 className="text-base font-semibold">导入设置</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              选择新建或追加到已有作品，并设置拆章与审核方式。
            </p>
          </div>
        </div>
        <div className="grid gap-4 rounded-xl border border-border/70 bg-muted/20 p-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>导入到</Label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={mode === "new" ? "default" : "outline"}
                size="sm"
                onClick={() => setMode("new")}
              >
                新建作品
              </Button>
              <Button
                type="button"
                variant={mode === "existing" ? "default" : "outline"}
                size="sm"
                disabled={loaderData.books.length === 0}
                onClick={() => setMode("existing")}
              >
                已有作品
              </Button>
            </div>
          </div>
          {mode === "existing" && loaderData.books.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="book">作品</Label>
              <Select value={bookId} onValueChange={setBookId}>
                <SelectTrigger id="book">
                  <SelectValue placeholder="选择作品" />
                </SelectTrigger>
                <SelectContent>
                  {loaderData.books.map((book) => (
                    <SelectItem key={book.id} value={book.id}>
                      {book.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {mode === "new" && (
            <div className="space-y-1.5">
              <Label htmlFor="title">作品标题（可选）</Label>
              <Input
                id="title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="留空自动使用文件名作为书名"
                maxLength={60}
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="split-chars">无目录时按字数拆章（0 关闭）</Label>
            <Input
              id="split-chars"
              type="number"
              min={0}
              max={20000}
              value={splitChars}
              onChange={(event) => setSplitChars(Number(event.target.value) || 0)}
            />
          </div>
          <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-background p-4 sm:col-span-2">
            <div className="min-w-0">
              <Label htmlFor="skip-review" className="text-sm font-semibold">
                无需审核，直接发布
              </Label>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">开启后导入即公开。</p>
            </div>
            <Switch
              id="skip-review"
              checked={skipReview}
              onCheckedChange={setSkipReview}
              aria-label="无需审核，直接发布"
            />
          </div>
        </div>

        <div className="mt-4 space-y-2">
          <Label>小说文件（可拖入 / 多选 / 文件夹）</Label>
          <div className="relative">
            <div
              data-dropzone
              onDragEnter={onDragEnter}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDropFiles}
              className={`grid gap-2 rounded-xl p-1 transition-all sm:grid-cols-2 ${
                isDraggingFiles ? "bg-primary/10 ring-2 ring-primary/60 ring-offset-2" : ""
              }`}
            >
            <label
              htmlFor="files"
              className="flex min-h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-primary/40 bg-primary/5 p-4 text-center transition-all hover:border-primary/70 hover:bg-primary/10 sm:min-h-48"
            >
              <UploadCloud className="size-10 text-muted-foreground" />
              <span className="text-base font-semibold">选择文件</span>
              <span className="text-sm text-muted-foreground">
                多选 TXT / EPUB / MOBI / PDF，或直接拖入
              </span>
              <input
                id="files"
                type="file"
                multiple
                accept=".txt,.epub,.mobi,.pdf"
                className="sr-only"
                onChange={(event) => {
                  addFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            </label>
            <label
              htmlFor="folder"
              className="flex min-h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted/30 p-4 text-center transition-all hover:border-primary/50 hover:bg-muted/60 sm:min-h-48"
            >
              <FolderOpen className="size-10 text-muted-foreground" />
              <span className="text-base font-semibold">选择文件夹</span>
              <span className="text-sm text-muted-foreground">批量导入整个目录</span>
              <input
                id="folder"
                type="file"
                multiple
                className="sr-only"
                onChange={(event) => {
                  addFiles(event.target.files);
                  event.target.value = "";
                }}
                {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              />
            </label>
            </div>
            {isDraggingFiles && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-primary/10 text-sm font-semibold text-primary">
                松开鼠标导入文件
              </div>
            )}
          </div>

          {selectedFiles.length > 0 && (
            <div className="mt-3 max-h-64 space-y-1 overflow-y-auto rounded-md border border-border bg-background p-2">
              {selectedFiles.map((selected, index) => (
                <div key={`${selected.path}-${index}`} className="flex items-center gap-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate">{selected.path}</p>
                    {mode === "new" && (
                      <p className="truncate text-xs text-muted-foreground">
                        书名：{baseNameWithoutExtension(selected.path)}
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {(selected.file.size / 1024).toFixed(0)} KB
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`移除 ${selected.path}`}
                    onClick={() => setSelectedFiles((prev) => prev.filter((_, i) => i !== index))}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        {error && (
          <p className="mt-3 flex items-start gap-2 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        )}

        {notice && (
          <p className="mt-3 flex items-start gap-2 rounded-md bg-success/10 px-3 py-2 text-sm text-success">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            {notice}
          </p>
        )}

        <Button
          className="mt-5 h-11 w-full text-sm font-semibold"
          onClick={uploadAll}
          disabled={uploading}
        >
          {uploading ? <Loader2 className="size-4 animate-spin" /> : <FileUp className="size-4" />}
          {uploading
            ? uploadingDetail || `上传解析中 ${uploadIndex}/${selectedFiles.length}…`
            : `加入导入队列（${selectedFiles.length} 个文件）`}
        </Button>
      </section>

      {parsingJobs.length > 0 && (
        <section className="max-h-[48vh] space-y-4 overflow-y-auto pr-1">
          <h2 className="sticky top-0 z-10 rounded-lg bg-background/95 py-2 text-base font-semibold backdrop-blur">
            导入任务（{parsingJobs.length}）
          </h2>
          {parsingJobs.map((job) => (
            <div key={job.id} className="paper-panel rounded-2xl p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{job.sourceName}</p>
                  <p className="truncate text-xs text-muted-foreground">{job.bookTitle}</p>
                </div>
                <Badge variant={job.status === "failed" ? "danger" : "secondary"}>
                  {statusText(job.status)}
                </Badge>
              </div>
              {job.errorMessage && (
                <p className="mt-2 rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">
                  {job.errorMessage}
                </p>
              )}
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                disabled={retryingId !== ""}
                onClick={() => retryJob(job)}
              >
                {retryingId === job.id ? "重试解析中…" : "重试解析"}
              </Button>
            </div>
          ))}
        </section>
      )}

      {pendingImportJobs.length > 0 && (
        <section className="max-h-[78vh] space-y-4 overflow-y-auto pr-1">
          <h2 className="sticky top-0 z-10 rounded-lg bg-background/95 py-2 text-base font-semibold backdrop-blur">
            章节确认（{pendingImportJobs.length}）
          </h2>
          {pendingImportJobs.map((job) => {
            const expanded = expandedJobs.has(job.id);
            return (
              <div key={job.id} className="paper-panel rounded-2xl">
                <div className="flex flex-wrap items-center gap-3 p-4">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="min-w-0 flex-1 justify-start px-1 text-left"
                    aria-expanded={expanded}
                    onClick={() => toggleJobExpanded(job.id)}
                  >
                    {expanded ? (
                      <ChevronDown className="size-4 shrink-0" />
                    ) : (
                      <ChevronRight className="size-4 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {job.bookTitle || job.sourceName}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {job.sourceName} · {job.candidates.length} 个候选章节
                        {job.encoding ? ` · ${job.encoding.toUpperCase()}` : ""}
                      </span>
                    </span>
                  </Button>
                  <Badge variant="warning">{statusText(job.status)}</Badge>
                  <Button
                    type="button"
                    variant="outline"
                    className="shrink-0 border-danger/40 text-danger hover:bg-danger/10 hover:text-danger"
                    onClick={() => deleteWholeBook(job)}
                    disabled={confirmingId !== "" || deletingBookId !== ""}
                  >
                    {deletingBookId === job.bookId ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className="size-4" />
                    )}
                    {deletingBookId === job.bookId ? "正在删除整本书…" : "删除整本书"}
                  </Button>
                </div>

                {expanded && (
                  <div className="border-t border-border p-4">
                    <p className="text-xs text-muted-foreground">
                      作者：{job.bookAuthorName || job.sourceAuthorName || "未填写"}
                    </p>

                    {job.warnings.length > 0 && (
                      <div className="mt-3 space-y-1 rounded-md bg-warning/10 p-3">
                        {job.warnings.map((warning, index) => (
                          <p key={index} className="text-xs text-warning">
                            · {warning}
                          </p>
                        ))}
                      </div>
                    )}

                    <div className="mt-4 grid gap-3 rounded-xl border border-border bg-muted/25 p-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor={`job-category-${job.id}`}>分类</Label>
                        <Select
                          value={metadataFor(job).categoryId || "__none__"}
                          onValueChange={(value) =>
                            updateMetadata(job, {
                              categoryId: value === "__none__" ? "" : value,
                              categoryName: "",
                            })
                          }
                        >
                          <SelectTrigger id={`job-category-${job.id}`}>
                            <SelectValue placeholder="选择已有分类" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">暂不分类</SelectItem>
                            {loaderData.categories.map((category) => (
                              <SelectItem key={category.id} value={category.id}>
                                {category.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Input
                          aria-label={`自定义分类 ${job.id}`}
                          value={metadataFor(job).categoryName}
                          onChange={(event) =>
                            updateMetadata(job, {
                              categoryId: "",
                              categoryName: event.target.value,
                            })
                          }
                          placeholder="没有合适分类？输入后自动创建，如：西幻、架空"
                          maxLength={20}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`job-author-${job.id}`}>作者</Label>
                        <Input
                          id={`job-author-${job.id}`}
                          value={metadataFor(job).authorName}
                          onChange={(event) =>
                            updateMetadata(job, { authorName: event.target.value })
                          }
                          placeholder="填写作者名"
                          maxLength={30}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`job-serial-${job.id}`}>连载状态</Label>
                        <Select
                          value={metadataFor(job).serialStatus}
                          onValueChange={(value) =>
                            updateMetadata(job, { serialStatus: value as "ongoing" | "completed" })
                          }
                        >
                          <SelectTrigger id={`job-serial-${job.id}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="ongoing">连载中</SelectItem>
                            <SelectItem value="completed">已完结</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2 sm:col-span-2">
                        <Label htmlFor={`job-tags-${job.id}`}>
                          标签（最多 10 个，可输入或点选）
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          输入内置列表没有的标签，确认导入后会自动创建。
                        </p>
                        <Input
                          id={`job-tags-${job.id}`}
                          value={metadataFor(job).tagsText}
                          onChange={(event) =>
                            updateMetadata(job, { tagsText: event.target.value })
                          }
                          placeholder="例如：玄幻、热血、成长"
                          maxLength={200}
                        />
                        {loaderData.availableTags.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {loaderData.availableTags.slice(0, 20).map((tag) => {
                              const selected = parseTagNames(metadataFor(job).tagsText).includes(
                                tag.name
                              );
                              return (
                                <Button
                                  key={tag.id}
                                  type="button"
                                  variant={selected ? "secondary" : "ghost"}
                                  size="sm"
                                  className="h-7 rounded-full px-2.5 text-xs"
                                  onClick={() => toggleMetadataTag(job, tag.name)}
                                >
                                  {tag.name}
                                </Button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>

                    <CandidateEditor
                      job={job}
                      renames={renames[job.id]}
                      ignored={ignored[job.id]}
                      onRename={(index, value) => rename(job.id, index, value)}
                      onToggleIgnore={(index) => toggleIgnore(job.id, index)}
                    />

                    {(confirmingId === job.id || job.status === "importing") && (
                      <div className="mt-3 rounded-xl border border-primary/20 bg-primary/5 p-3">
                        <Progress
                          value={
                            confirmingProgress.total > 0
                              ? (confirmingProgress.imported / confirmingProgress.total) * 100
                              : 0
                          }
                        />
                        <p
                          className="mt-2 text-center text-xs font-medium text-primary"
                          aria-live="polite"
                        >
                          {confirmingDetail || "正在启动导入…"}
                        </p>
                      </div>
                    )}
                    <Button
                      className="mt-3 w-full"
                      onClick={() => openConfirmDialog(job)}
                      disabled={
                        confirmingId !== "" ||
                        job.status === "importing" ||
                        job.candidates.every((candidate) => ignored[job.id]?.has(candidate.index))
                      }
                    >
                      {confirmingId === job.id || job.status === "importing" ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <CheckCircle2 className="size-4" />
                      )}
                      {confirmingId === job.id || job.status === "importing"
                        ? "导入中"
                        : "确认导入"}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}

      <Dialog
        open={confirmDialogJob !== null}
        onOpenChange={(open) => {
          if (!open && !confirmingId && !reparsing) setConfirmDialogJob(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认导入</DialogTitle>
            <DialogDescription>
              {confirmDialogJob
                ? `${confirmDialogJob.sourceName} · ${confirmDialogJob.candidates.length} 个章节`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {confirmDialogJob && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="confirm-book-title">书名</Label>
                <Input
                  id="confirm-book-title"
                  value={confirmTitle}
                  onChange={(event) => setConfirmTitle(event.target.value)}
                  maxLength={120}
                  placeholder="输入书名"
                />
              </div>
              {confirmDialogJob.format === "txt" ? (
                <div className="flex items-start gap-3 rounded-xl border border-border bg-muted/25 p-3">
                  <Checkbox
                    id="confirm-reparse"
                    checked={confirmReparse}
                    onCheckedChange={(checked) => setConfirmReparse(checked === true)}
                    disabled={reparsing}
                  />
                  <div className="min-w-0 space-y-1">
                    <Label htmlFor="confirm-reparse" className="text-sm font-semibold">
                      按 5000 字重新划分章节
                    </Label>
                    <p className="text-xs leading-5 text-muted-foreground">
                      超过 5000 字的章节会拆分为多章后再导入。
                    </p>
                  </div>
                </div>
              ) : (
                <p className="rounded-xl border border-border bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
                  当前格式不支持按字数重新划分章节。
                </p>
              )}
              {error && (
                <p className="flex items-start gap-2 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={confirmingId !== "" || reparsing}
                  onClick={() => setConfirmDialogJob(null)}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  onClick={handleConfirmDialog}
                  disabled={confirmingId !== "" || reparsing || confirmTitle.trim() === ""}
                >
                  {reparsing ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="size-4" />
                  )}
                  {reparsing ? "重新划分章节中…" : "确认导入"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
function CandidateEditor({
  job,
  renames,
  ignored,
  onRename,
  onToggleIgnore,
}: {
  job: ImportJobView;
  renames?: Record<number, string>;
  ignored?: Set<number>;
  onRename: (index: number, value: string) => void;
  onToggleIgnore: (index: number) => void;
}) {
  const pageSize = 40;
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(job.candidates.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const start = currentPage * pageSize;
  const visibleCandidates = job.candidates.slice(start, start + pageSize);

  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/60 px-3 py-2">
        <span className="text-xs text-muted-foreground">
          第 {start + 1}-{Math.min(start + pageSize, job.candidates.length)} 章 / 共{" "}
          {job.candidates.length} 章
          {ignored && ignored.size > 0 ? ` · 已删除 ${ignored.size} 章` : ""}
        </span>
        {pageCount > 1 && (
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={currentPage === 0}
              onClick={() => setPage(0)}
            >
              首页
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              上一页
            </Button>
            <span className="min-w-16 text-center text-xs text-muted-foreground">
              {currentPage + 1} / {pageCount}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={currentPage >= pageCount - 1}
              onClick={() => setPage(currentPage + 1)}
            >
              下一页
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={currentPage >= pageCount - 1}
              onClick={() => setPage(pageCount - 1)}
            >
              末页
            </Button>
          </div>
        )}
      </div>
      <div className="max-h-96 space-y-2 overflow-y-auto">
        {visibleCandidates.map((candidate) => {
          const isIgnored = ignored?.has(candidate.index);
          return (
            <div
              key={candidate.index}
              className={`rounded-md border p-3 transition-colors ${
                isIgnored ? "border-border bg-muted/40 opacity-60" : "border-border bg-background"
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-8 text-sm font-semibold text-muted-foreground">
                  {candidate.index + 1}
                </span>
                <Input
                  className="h-9 min-w-40 flex-1"
                  value={renames?.[candidate.index] ?? candidate.title}
                  onChange={(event) => onRename(candidate.index, event.target.value)}
                  aria-label={`${job.sourceName} 章节 ${candidate.index + 1} 标题`}
                />
                {candidate.volumeTitle !== "正文" && (
                  <Badge variant="secondary">{candidate.volumeTitle}</Badge>
                )}
                <Badge variant={isIgnored ? "outline" : "success"}>
                  {isIgnored ? "已删除" : `${candidate.charCount.toLocaleString()} 字`}
                </Badge>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={isIgnored ? "" : "text-danger hover:bg-danger/10 hover:text-danger"}
                  aria-label={
                    isIgnored
                      ? `恢复第 ${candidate.index + 1} 章`
                      : `删除第 ${candidate.index + 1} 章`
                  }
                  onClick={() => onToggleIgnore(candidate.index)}
                >
                  {!isIgnored && <Trash2 className="size-4" />}
                  {isIgnored ? "撤销删除" : "删除"}
                </Button>
              </div>
              {candidate.warning && (
                <p className="mt-2 text-xs text-warning">{candidate.warning}</p>
              )}
              {candidate.preview && (
                <p className="mt-2 line-clamp-1 text-xs text-muted-foreground">
                  {candidate.preview}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
