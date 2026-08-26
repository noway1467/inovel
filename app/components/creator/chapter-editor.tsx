import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import TextAlign from "@tiptap/extension-text-align";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Italic,
  Loader2,
  Save,
  Send,
  Underline as UnderlineIcon,
  Wand2,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import type { ChapterEditView } from "~/server/creator/service";

export default function ChapterEditor({
  chapter,
  initialTitle,
  initialParagraphs,
}: {
  chapter: ChapterEditView;
  initialTitle: string;
  initialParagraphs: { id: string; text: string }[];
}) {
  const navigate = useNavigate();
  const [title, setTitle] = useState(initialTitle);
  const [saveState, setSaveState] = useState<"idle" | "dirty" | "saving" | "saved" | "error">(
    "idle"
  );
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const initialHtml = useMemo(
    () => initialParagraphs.map((p) => `<p>${p.text}</p>`).join(""),
    [initialParagraphs]
  );

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        orderedList: false,
        bulletList: false,
        listItem: false,
        code: false,
      }),
      Underline,
      TextAlign.configure({
        types: ["paragraph"],
        alignments: ["left", "center", "right", "justify"],
      }),
    ],
    content: initialHtml || "<p></p>",
    onUpdate: () =>
      setSaveState((state) => (state === "saved" ? "dirty" : state === "idle" ? "dirty" : state)),
    editorProps: {
      attributes: {
        class: "prose prose-sm max-w-none min-h-[55vh] p-4 text-foreground outline-none",
      },
    },
  });

  const paragraphsFromEditor = useCallback(() => {
    if (!editor) return [];
    return editor
      .getText({ blockSeparator: "\n" })
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }, [editor]);

  const wordCount = useMemo(
    () => (editor ? editor.getText().replace(/\s/g, "").length : 0),
    [editor, saveState]
  );

  async function save() {
    if (!editor) return;
    setSaveState("saving");
    setMessage("");
    try {
      const response = await fetch(`/api/creator/chapters/${chapter.id}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, paragraphs: paragraphsFromEditor() }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setSaveState("error");
        setMessage(data.error ?? "保存失败");
        return;
      }
      setSaveState("saved");
      setMessage("已保存");
    } catch {
      setSaveState("error");
      setMessage("网络异常，请重试");
    }
  }

  async function submit() {
    setSubmitting(true);
    setMessage("");
    try {
      const response = await fetch(`/api/creator/chapters/${chapter.id}/submit`, {
        method: "POST",
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setMessage(data.error ?? "提交失败");
        return;
      }
      setMessage("已提交审核");
      navigate(`/creator/books/${chapter.bookId}/chapters/${chapter.id}`, { replace: true });
      window.location.reload();
    } finally {
      setSubmitting(false);
    }
  }

  function autoFormat() {
    if (!editor) return;
    const lines = paragraphsFromEditor().map((line) => line.replace(/^\s*/, ""));
    editor.commands.setContent(lines.map((line) => `<p>${line}</p>`).join(""));
    setSaveState("dirty");
  }

  const canEdit = ["draft", "rejected", "published"].includes(chapter.status);
  const canSubmit =
    (chapter.status === "draft" || chapter.status === "rejected") && saveState !== "dirty";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border p-3">
        <Input
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            if (saveState === "saved") setSaveState("dirty");
          }}
          placeholder="章节标题"
          maxLength={60}
          disabled={!canEdit}
          aria-label="章节标题"
          className="h-9 text-base font-medium"
        />
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="加粗"
            disabled={!canEdit}
            onClick={() => editor?.chain().focus().toggleBold().run()}
          >
            <Bold className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="斜体"
            disabled={!canEdit}
            onClick={() => editor?.chain().focus().toggleItalic().run()}
          >
            <Italic className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="下划线"
            disabled={!canEdit}
            onClick={() => editor?.chain().focus().toggleUnderline().run()}
          >
            <UnderlineIcon className="size-4" />
          </Button>
          <span className="mx-1 h-5 w-px bg-border" />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="左对齐"
            disabled={!canEdit}
            onClick={() => editor?.chain().focus().setTextAlign("left").run()}
          >
            <AlignLeft className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="居中"
            disabled={!canEdit}
            onClick={() => editor?.chain().focus().setTextAlign("center").run()}
          >
            <AlignCenter className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="右对齐"
            disabled={!canEdit}
            onClick={() => editor?.chain().focus().setTextAlign("right").run()}
          >
            <AlignRight className="size-4" />
          </Button>
          <span className="mx-1 h-5 w-px bg-border" />
          <Button variant="ghost" size="sm" disabled={!canEdit} onClick={autoFormat}>
            <Wand2 className="size-4" />
            自动排版
          </Button>
          <span className="ml-auto text-xs text-muted-foreground">
            {wordCount.toLocaleString()} 字
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <EditorContent editor={editor} />
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border p-3">
        {saveState === "saving" && (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        )}
        {saveState === "saved" && (
          <span className="text-xs text-muted-foreground">{message || "已保存"}</span>
        )}
        {saveState === "error" && <span className="text-xs text-danger">{message}</span>}
        {!canEdit && (
          <span className="text-xs text-muted-foreground">
            {chapter.status === "pending_review" ? "审核中，暂不能编辑" : "当前状态不可编辑"}
          </span>
        )}
        {chapter.status === "published" && (
          <span className="text-xs text-warning">已发布章节，修改后需重新提交审核</span>
        )}
        <div className="ml-auto flex gap-2">
          <Button size="sm" onClick={save} disabled={saveState === "saving" || !canEdit}>
            <Save className="size-4" />
            {chapter.status === "published" ? "保存修改" : "保存"}
          </Button>
          {chapter.status !== "published" && (
            <Button
              variant="accent"
              size="sm"
              onClick={submit}
              disabled={submitting || !canSubmit}
              title={canSubmit ? "" : "请先填写标题和正文后再提交"}
            >
              {submitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              提交审核
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
