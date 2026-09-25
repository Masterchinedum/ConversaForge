import type { ScenarioConfigInput } from './scenario-config';

/**
 * Built-in starter templates (original content). Seeded into the gallery and offered on "New scenario".
 */
export interface ScenarioTemplate {
  key: string;
  name: string;
  summary: string;
  config: ScenarioConfigInput;
}

export const SCENARIO_TEMPLATES: ScenarioTemplate[] = [
  {
    key: 'behavioral-interview',
    name: 'Behavioral interview (STAR)',
    summary: 'A structured behavioral interview that probes for situation, task, action and result.',
    config: {
      basics: {
        name: 'Behavioral interview',
        type: 'interview',
        internalDescription: 'First-round behavioral screen for {{role_title}} candidates.',
        publicDescription: 'A 10-minute practice interview focused on past experiences.',
        participantInstructions:
          'You will talk with an AI interviewer for about 10 minutes. Answer with concrete examples from your experience. You can pause to think — the interviewer will wait.',
        targetDurationMinutes: 10,
        tags: ['interview', 'behavioral'],
      },
      persona: {
        role: 'Hiring manager conducting a behavioral interview for the {{role_title}} role',
        name: 'Alex',
        description: 'Friendly, curious, and fair. Listens carefully and asks for specifics when answers are vague.',
      },
      instructions: {
        aiInstructions:
          'Ask one question at a time. When an answer lacks a concrete situation, the candidate\'s own actions, or a measurable result, ask one focused follow-up. Do not give feedback during the interview.',
        goals: [
          'Understand how the candidate handles conflict and ambiguity',
          'Assess ownership and measurable impact in past work',
        ],
        boundaries: [
          'Never ask about age, family status, religion, health, nationality or other protected characteristics',
          'Do not promise hiring outcomes',
        ],
      },
      conversation: {
        agenda: [
          { id: 'intro', topic: 'Brief introduction and current role', guidance: 'Keep it short.', required: true, maxFollowUps: 1 },
          { id: 'conflict', topic: 'A time they resolved a disagreement', guidance: 'Probe for their specific actions.', required: true, maxFollowUps: 2 },
          { id: 'impact', topic: 'Their most measurable accomplishment', guidance: 'Ask for numbers and their personal contribution.', required: true, maxFollowUps: 2 },
          { id: 'questions', topic: 'Questions from the candidate', guidance: 'Answer briefly and generically.', required: false, maxFollowUps: 1 },
        ],
        firstTurn: {
          speaker: 'agent',
          text: "Hi {{participant_name}}, thanks for joining. I'm Alex. We'll spend about ten minutes on a few questions about your past experience. Ready to start?",
        },
        ending: {
          closingMessage: 'Thanks for your time today — that is everything I wanted to cover. Best of luck!',
          maxDurationMinutes: 15,
        },
      },
      rubric: {
        evaluatedSubject: 'the candidate (participant)',
        criteria: [
          { id: 'structure', name: 'Structured answers', weight: 30, description: 'Uses situation, task, action and result.', strongPerformance: 'Clear STAR structure with specific context.', weakPerformance: 'Rambling, hypothetical or generic answers.' },
          { id: 'ownership', name: 'Ownership', weight: 40, description: 'Describes personal actions and decisions.', strongPerformance: 'Says what they did and why.', weakPerformance: 'Only describes what the team did.' },
          { id: 'impact', name: 'Measurable impact', weight: 30, description: 'Quantifies outcomes.', strongPerformance: 'Concrete metrics or observable results.', weakPerformance: 'No outcome, or vague outcome.' },
        ],
        passingScore: 70,
      },
      extraction: {
        variables: [
          { key: 'years_experience', description: 'Years of professional experience mentioned', type: 'number' },
          { key: 'current_title', description: 'Current job title', type: 'text' },
          { key: 'open_to_relocation', description: 'Whether the candidate said they are open to relocating', type: 'boolean' },
        ],
      },
      variables: {
        allowlist: [
          { key: 'participant_name', label: 'Participant name', maxLength: 80, defaultValue: 'there' },
          { key: 'role_title', label: 'Role title', maxLength: 120, defaultValue: 'open' },
        ],
      },
      analysis: { requireHumanReview: true },
    },
  },
];
