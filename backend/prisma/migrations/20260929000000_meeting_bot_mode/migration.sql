-- Meeting bots: notetaker (transcribe only) or agent (the AI persona speaks in the meeting).
ALTER TABLE "MeetingBot" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'notetaker';
