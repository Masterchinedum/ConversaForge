'use client';
import { Alert, Button } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { uploadFile } from '@/lib/live/runtime-api';
import { UPLOAD_LIMITS } from '@cf/shared';
import { useId, useRef, useState } from 'react';
import type { ToolProps } from './SimpleTools';

const LIMIT = UPLOAD_LIMITS.toolDocument;
const EXT: Record<string, string> = { 'application/pdf': '.pdf', 'text/plain': '.txt', 'text/markdown': '.md' };

function mimeOf(file: File): string {
  if (file.type) return file.type;
  const n = file.name.toLowerCase();
  if (n.endsWith('.md') || n.endsWith('.markdown')) return 'text/markdown';
  if (n.endsWith('.txt')) return 'text/plain';
  if (n.endsWith('.pdf')) return 'application/pdf';
  return '';
}

export function DocumentUploadTool({ tool, sessionId, token }: ToolProps) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(typeof tool.data?.fileName === 'string' ? (tool.data.fileName as string) : null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const prompt = typeof tool.args.prompt === 'string' ? tool.args.prompt : 'Please upload your document.';
  const maxMb = Math.round(LIMIT.maxBytes / 1024 / 1024);

  const pick = (f: File | null) => {
    setError(null);
    if (!f) return setFile(null);
    const mime = mimeOf(f);
    if (!(LIMIT.mimeTypes as readonly string[]).includes(mime)) {
      setFile(null);
      return setError('Please choose a PDF, plain-text or Markdown file.');
    }
    if (f.size > LIMIT.maxBytes) {
      setFile(null);
      return setError(`That file is too large (max ${maxMb} MB).`);
    }
    if (f.size === 0) {
      setFile(null);
      return setError('That file is empty.');
    }
    setFile(f);
  };

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const mime = mimeOf(file);
      const blob = file.type ? file : new File([file], file.name, { type: mime });
      // The upload itself answers the tool server-side (the agent receives the extracted text).
      const res = await uploadFile(sessionId, token, blob, file.name, { toolCallId: tool.toolCallId });
      setDone(res.fileName ?? file.name);
      if (typeof res.warning === 'string') setError(res.warning);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const finished = done ?? (tool.data?.answered && typeof tool.data?.fileName === 'string' ? (tool.data.fileName as string) : null);
  if (finished) {
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium text-emerald-700" role="status">
          ✓ Uploaded {finished}. The agent can now review it.
        </p>
        {error && <Alert tone="warning">{error}</Alert>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-700">{prompt}</p>
      <div>
        <label htmlFor={id} className="block text-sm font-medium text-slate-700">
          Choose a file
        </label>
        <input
          ref={input}
          id={id}
          type="file"
          accept={[...LIMIT.mimeTypes, ...Object.values(EXT), '.markdown'].join(',')}
          onChange={(e) => pick(e.target.files?.[0] ?? null)}
          className="mt-1 block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-brand-700 hover:file:bg-brand-100"
          aria-describedby={`${id}-hint`}
        />
        <p id={`${id}-hint`} className="mt-1 text-xs text-slate-500">
          PDF, TXT or Markdown, up to {maxMb} MB.
        </p>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      <Button onClick={upload} disabled={!file} loading={busy}>
        Upload
      </Button>
    </div>
  );
}
