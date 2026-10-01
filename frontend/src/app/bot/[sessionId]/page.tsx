'use client';
import { BotApp } from '@/components/live/BotApp';
import { useParams } from 'next/navigation';

export default function Page() {
  const params = useParams<{ sessionId: string }>();
  return <BotApp sessionId={params.sessionId} />;
}
