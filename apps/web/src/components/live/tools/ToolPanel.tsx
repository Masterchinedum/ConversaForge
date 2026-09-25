'use client';
import { Button } from '@/components/ui';
import { getToolDefinition, type PresentedTool } from '@cf/shared';
import type { ComponentType } from 'react';
import { DocumentUploadTool } from './DocumentUploadTool';
import { CardTool, MultipleChoiceTool, NotepadTool, TimerTool, type ToolProps } from './SimpleTools';
import { WhiteboardTool } from './WhiteboardTool';

const RENDERERS: Record<string, ComponentType<ToolProps>> = {
  cards: CardTool,
  notepad: NotepadTool,
  multiple_choice: MultipleChoiceTool,
  document_upload: DocumentUploadTool,
  timer: TimerTool,
  whiteboard: WhiteboardTool,
};

const OPEN_LABELS: Record<string, string> = {
  notepad: 'Open notepad',
  whiteboard: 'Open whiteboard',
  document_upload: 'Upload a document',
};

export function ToolPanel({
  tools,
  participantTools,
  sessionId,
  token,
  onOpen,
  onRespond,
  onUpdate,
  disabled,
}: {
  tools: PresentedTool[];
  participantTools: string[];
  sessionId: string;
  token: string;
  onOpen: (toolId: string) => void;
  onRespond: (toolCallId: string, result: Record<string, unknown>) => void;
  onUpdate: (toolCallId: string, data: Record<string, unknown>) => void;
  disabled?: boolean;
}) {
  const open = tools.filter((t) => !t.closed && RENDERERS[t.toolId]).reverse();
  const openable = participantTools.filter((id) => RENDERERS[id] && !open.some((t) => t.toolId === id));
  if (!open.length && !openable.length) return null;
  return (
    <section aria-label="Shared materials" className="space-y-3">
      {openable.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {openable.map((id) => (
            <Button key={id} variant="secondary" size="sm" onClick={() => onOpen(id)} disabled={disabled}>
              {OPEN_LABELS[id] ?? `Open ${getToolDefinition(id)?.name ?? id}`}
            </Button>
          ))}
        </div>
      )}
      {open.map((t) => {
        const R = RENDERERS[t.toolId]!;
        const heading = t.title || getToolDefinition(t.toolId)?.name || 'Shared item';
        return (
          <article
            key={t.toolCallId}
            data-tool={t.toolId}
            aria-label={heading}
            className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
          >
            {t.toolId !== 'cards' && <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{heading}</h3>}
            <R
              tool={t}
              sessionId={sessionId}
              token={token}
              respond={(result) => onRespond(t.toolCallId, result)}
              update={(data) => onUpdate(t.toolCallId, data)}
            />
          </article>
        );
      })}
    </section>
  );
}
