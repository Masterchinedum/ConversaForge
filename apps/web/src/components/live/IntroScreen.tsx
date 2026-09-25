'use client';
import { Button } from '@/components/ui';
import type { LiveBootstrap } from '@/lib/live/runtime-api';
import { AgentAvatar } from './AgentAvatar';
import { SimulatedBanner } from './Shell';

export function IntroScreen({ boot, onContinue }: { boot: LiveBootstrap; onContinue: () => void }) {
  const { scenario, persona, config } = boot;
  const mins = scenario.estimatedMinutes ?? (boot.maxDurationSec ? Math.round(boot.maxDurationSec / 60) : null);
  return (
    <div className="space-y-6">
      {config.simulated && <SimulatedBanner parts={config.simulatedParts} />}
      <div className="flex flex-col items-center gap-3 text-center">
        <AgentAvatar persona={persona} size="md" />
        <div>
          <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">{scenario.name}</h1>
          {persona.name && (
            <p className="mt-1 text-sm text-slate-600">
              You’ll be talking with <span className="font-medium text-slate-800">{persona.name}</span>
              {persona.role ? <>, {persona.role}</> : null}
              {' '}— an AI agent.
            </p>
          )}
        </div>
      </div>

      {scenario.publicDescription && (
        <section aria-labelledby="about-h">
          <h2 id="about-h" className="text-sm font-semibold text-slate-900">
            About this conversation
          </h2>
          <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-slate-700">{scenario.publicDescription}</p>
        </section>
      )}

      {scenario.participantInstructions && (
        <section aria-labelledby="instr-h" className="rounded-lg border border-slate-200 bg-slate-50 p-4">
          <h2 id="instr-h" className="text-sm font-semibold text-slate-900">
            Instructions
          </h2>
          <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-slate-700">{scenario.participantInstructions}</p>
        </section>
      )}

      <ul className="grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
        {mins ? (
          <li className="flex items-center gap-2">
            <span aria-hidden>⏱</span> About {mins} minute{mins === 1 ? '' : 's'}
          </li>
        ) : null}
        <li className="flex items-center gap-2">
          <span aria-hidden>🎙</span>
          {config.stt === 'typed' ? 'You’ll type your answers' : 'You’ll speak; typing is available as a fallback'}
        </li>
        <li className="flex items-center gap-2">
          <span aria-hidden>⏸</span> You can pause at any time
        </li>
        {config.turnTaking.mode === 'push_to_talk' && (
          <li className="flex items-center gap-2">
            <span aria-hidden>⌨</span> Hold Space (or the talk button) while speaking
          </li>
        )}
      </ul>

      <div className="flex justify-end">
        <Button size="lg" onClick={onContinue} className="w-full sm:w-auto">
          Continue
        </Button>
      </div>
    </div>
  );
}
