'use client';
import { clsx } from '@/components/ui';
import { computeRms } from '@/lib/voice/vad';
import { useCallback, useEffect, useRef } from 'react';

type Subscribe = (fn: (level: number) => void) => () => void;

/** Level subscription from a stream (device check) using an AnalyserNode. */
export function useStreamLevel(stream: MediaStream | null, ctx: AudioContext | null): Subscribe {
  const subs = useRef(new Set<(l: number) => void>());
  useEffect(() => {
    if (!stream || !ctx || !stream.getAudioTracks().length) return;
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(new ArrayBuffer(an.fftSize * 4));
    const timer = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      const l = Math.min(1, computeRms(buf) * 6);
      subs.current.forEach((f) => f(l));
    }, 60);
    return () => {
      clearInterval(timer);
      try {
        src.disconnect();
        an.disconnect();
      } catch {
        /* ignore */
      }
    };
  }, [stream, ctx]);
  return useCallback((fn) => {
    subs.current.add(fn);
    return () => void subs.current.delete(fn);
  }, []);
}

/**
 * Accessible level meter. Updates the DOM directly (no React re-render per frame).
 * Exposes a coarse value to assistive tech via aria-valuenow.
 */
export function MicMeter({ subscribe, muted, className, label = 'Microphone level' }: { subscribe: Subscribe; muted?: boolean; className?: string; label?: string }) {
  const bar = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const peak = useRef(0);
  useEffect(() => {
    let lastAria = -1;
    return subscribe((l) => {
      // Smooth: fast attack, slow release.
      peak.current = l > peak.current ? l : peak.current * 0.85 + l * 0.15;
      const pct = Math.round(Math.min(1, Math.sqrt(peak.current)) * 100);
      if (bar.current) bar.current.style.width = `${muted ? 0 : pct}%`;
      const coarse = Math.round(pct / 10) * 10;
      if (host.current && coarse !== lastAria) {
        lastAria = coarse;
        host.current.setAttribute('aria-valuenow', String(muted ? 0 : coarse));
      }
    });
  }, [subscribe, muted]);
  return (
    <div
      ref={host}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={0}
      className={clsx('h-2 w-full overflow-hidden rounded-full bg-slate-200', className)}
    >
      <div ref={bar} className={clsx('h-full rounded-full transition-[width] duration-75', muted ? 'bg-slate-400' : 'bg-emerald-500')} style={{ width: '0%' }} />
    </div>
  );
}
