'use client';
import { Alert, Button } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { submitConsent, type ConsentChoice, type LiveBootstrap } from '@/lib/live/runtime-api';
import { useId, useState } from 'react';

function ConsentCheck({
  checked,
  onChange,
  required,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  required?: boolean;
  label: string;
  description?: string;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3 rounded-lg border border-slate-200 p-3">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 h-5 w-5 shrink-0 rounded border-slate-300 text-brand-600 focus:ring-2 focus:ring-brand-500"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-required={required || undefined}
        aria-describedby={description ? `${id}-d` : undefined}
      />
      <label htmlFor={id} className="text-sm text-slate-800">
        <span className="font-medium">{label}</span>{' '}
        {required ? (
          <span className="ml-1 rounded bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-700">Required</span>
        ) : (
          <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">Optional</span>
        )}
        {description && (
          <span id={`${id}-d`} className="mt-1 block text-xs leading-relaxed text-slate-600">
            {description}
          </span>
        )}
      </label>
    </div>
  );
}

export function ConsentScreen({
  boot,
  token,
  browserSpeech,
  onDone,
  onBack,
}: {
  boot: LiveBootstrap;
  token: string;
  /** Browser speech recognition will likely be used (its speech service may process audio). */
  browserSpeech: boolean;
  onDone: (choice: ConsentChoice) => void;
  onBack: () => void;
}) {
  const c = boot.consent;
  const analysisRequired = c.analysisRequired;
  const [ack, setAck] = useState(false);
  const [recordAudio, setRecordAudio] = useState(c.recordAudio);
  const [recordVideo, setRecordVideo] = useState(false);
  const [analysis, setAnalysis] = useState(c.analysis);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = ack && (!analysisRequired || analysis);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const choice: ConsentChoice = {
      recordAudio: c.recordAudio && recordAudio,
      recordVideo: c.recordVideo && recordVideo,
      analysis: c.analysis && analysis,
    };
    try {
      await submitConsent(boot.sessionId, token, choice);
      onDone(choice);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Before we start</h1>
        <p className="mt-1 text-sm text-slate-600">Here is exactly what happens with this conversation.</p>
      </div>

      <ul className="space-y-2 text-sm text-slate-700">
        <li>
          • You’ll talk with an <strong>AI agent</strong>. What you say is transcribed to text so the agent can respond; the
          transcript is saved with this session.
        </li>
        {c.recordAudio && (
          <li>
            • If you agree, an <strong>audio recording</strong> of the call{c.recordVideo ? ' (and optionally video from your camera)' : ''} is
            stored.
          </li>
        )}
        {c.analysis && (
          <li>
            • If you agree, the transcript is <strong>analyzed by AI</strong> to produce feedback, scores and a summary that
            reviewers{boot.participantCanSeeFeedback ? ' and you' : ''} can see.
          </li>
        )}
        {c.retentionDays ? (
          <li>
            • Recordings and transcripts are kept for up to <strong>{c.retentionDays} days</strong>, then deleted.
          </li>
        ) : null}
        {browserSpeech && (
          <li>
            • Speech recognition uses your <strong>browser’s speech service</strong>, which may send audio to the browser
            vendor (e.g. Google for Chrome) for processing.
          </li>
        )}
      </ul>

      {c.notice && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Notice from the organizer</p>
          <p className="whitespace-pre-line">{c.notice}</p>
        </div>
      )}

      <fieldset className="space-y-2">
        <legend className="sr-only">Consent choices</legend>
        <ConsentCheck
          checked={ack}
          onChange={setAck}
          required
          label="I understand I’m talking with an AI and my speech will be transcribed."
        />
        {c.recordAudio && (
          <ConsentCheck
            checked={recordAudio}
            onChange={setRecordAudio}
            label="Record audio of this call"
            description="You can decline; the conversation still works and only the transcript is kept."
          />
        )}
        {c.recordVideo && (
          <ConsentCheck
            checked={recordVideo}
            onChange={setRecordVideo}
            label="Record video from my camera"
            description="Your camera is only used if you agree."
          />
        )}
        {c.analysis && (
          <ConsentCheck
            checked={analysis}
            onChange={setAnalysis}
            required={analysisRequired}
            label="Analyze my responses to produce feedback"
            description={analysisRequired ? 'The organizer requires analysis for this conversation.' : 'If you decline, no feedback or scores are produced.'}
          />
        )}
      </fieldset>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button size="lg" onClick={submit} disabled={!canSubmit} loading={busy}>
          Agree and continue
        </Button>
      </div>
      {!canSubmit && (
        <p className="text-right text-xs text-slate-500" aria-live="polite">
          Tick the required boxes to continue.
        </p>
      )}
    </div>
  );
}
