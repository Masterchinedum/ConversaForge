import { createHmac } from 'node:crypto';
import type { ClientMessage } from '@cf/shared';
import { decodeMulaw, EnergyVad, encodeMulaw, linearToMulaw, mulawToLinear, pcmToWav, resample } from './audio/audio';
import { parseTwilioCredential } from './channel-providers.service';
import { CsvError, parseCsv, parseTargetsCsv } from './csv';
import { pathTo } from './meeting-session';
import { mapRecallStatus, meetingPlatform, utteranceFromTranscriptEvent, verifySvixSignature } from './recall/recall';
import { PhoneBridge, splitSentences } from './twilio/phone-bridge';
import { computeTwilioSignature, urlPortVariants, validateTwilioSignature } from './twilio/twilio-signature';
import { normalizePhone, sayAndHangup, twiml, xmlEscape } from './twilio/twiml';

describe('Twilio request validation', () => {
  // Documented example values (Twilio security docs / twilio-python RequestValidator tests).
  const token = '12345';
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
  const params = { CallSid: 'CA1234567890ABCDE', Caller: '+14158675309', Digits: '1234', From: '+14158675309', To: '+18005551212' };

  it('computes the documented signature', () => {
    expect(computeTwilioSignature(token, url, params)).toBe('RSOYDt4T1cUTdK1PDd93/VVr8B8=');
  });

  it('validates, and rejects tampering / wrong token / missing signature', () => {
    expect(validateTwilioSignature(token, 'RSOYDt4T1cUTdK1PDd93/VVr8B8=', url, params)).toBe(true);
    expect(validateTwilioSignature(token, 'RSOYDt4T1cUTdK1PDd93/VVr8B8=', url, { ...params, Digits: '9999' })).toBe(false);
    expect(validateTwilioSignature('54321', 'RSOYDt4T1cUTdK1PDd93/VVr8B8=', url, params)).toBe(false);
    expect(validateTwilioSignature(token, undefined, url, params)).toBe(false);
    expect(validateTwilioSignature(token, 'RSOYDt4T1cUTdK1PDd93/VVr8B8=', 'https://mycompany.com/myapp.php?foo=1&bar=3', params)).toBe(false);
  });

  it('accepts the signature whether or not Twilio included the default port', () => {
    expect(validateTwilioSignature(token, 'RSOYDt4T1cUTdK1PDd93/VVr8B8=', 'https://mycompany.com:443/myapp.php?foo=1&bar=2', params)).toBe(true);
    expect(urlPortVariants('https://a.com/x')).toEqual(['https://a.com/x', 'https://a.com:443/x']);
    expect(urlPortVariants('http://a.com:80/x')).toEqual(['http://a.com:80/x', 'http://a.com/x']);
    // Documented expected values for explicit ports (twilio-python tests).
    expect(computeTwilioSignature(token, 'https://mycompany.com:443/myapp.php?foo=1&bar=2', params)).toBe('kvajT1Ptam85bY51eRf/AJRuM3w=');
  });

  it('parses Twilio credentials from a connection (JSON), env ("SID:TOKEN") or token + config', () => {
    expect(parseTwilioCredential(JSON.stringify({ accountSid: 'AC1', authToken: 't' }))).toEqual({ accountSid: 'AC1', authToken: 't' });
    expect(parseTwilioCredential('ACabc:tok')).toEqual({ accountSid: 'ACabc', authToken: 'tok' });
    expect(parseTwilioCredential('tok', { accountSid: 'AC9' })).toEqual({ accountSid: 'AC9', authToken: 'tok' });
  });
});

describe('TwiML', () => {
  it('builds a Connect/Stream document with escaped parameters', () => {
    const doc = twiml([
      { verb: 'Say', text: 'Hi <there> & "you"', language: 'en-US' },
      { verb: 'Stream', url: 'wss://api.example.com/ws/twilio', parameters: { sessionId: 's1', token: 'cfs_a"b<c' } },
    ]);
    expect(doc).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say language="en-US">Hi &lt;there&gt; &amp; &quot;you&quot;</Say>' +
        '<Connect><Stream url="wss://api.example.com/ws/twilio"><Parameter name="sessionId" value="s1"/><Parameter name="token" value="cfs_a&quot;b&lt;c"/></Stream></Connect></Response>',
    );
  });

  it('say-and-hangup for unconfigured lines; dial number / SIP for transfers', () => {
    expect(sayAndHangup('This line is not configured.')).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>This line is not configured.</Say><Hangup/></Response>',
    );
    expect(twiml([{ verb: 'DialNumber', number: '+14155550100', callerId: '+14155550199', timeout: 30 }])).toContain(
      '<Dial callerId="+14155550199" timeout="30"><Number>+14155550100</Number></Dial>',
    );
    expect(twiml([{ verb: 'DialSip', uri: 'sip:agent@pbx.example.com' }])).toContain('<Dial><Sip>sip:agent@pbx.example.com</Sip></Dial>');
    expect(xmlEscape('a\u0001b')).toBe('ab');
  });

  it('normalizes E.164 numbers', () => {
    expect(normalizePhone('+1 (415) 555-0199')).toBe('+14155550199');
    expect(normalizePhone('0044 20 7946 0958')).toBe('+442079460958');
    expect(normalizePhone('4155550199')).toBeNull();
    expect(normalizePhone('+0123456789')).toBeNull();
    expect(normalizePhone('+1415555019912345678')).toBeNull();
  });
});

describe('CSV targets', () => {
  it('parses RFC 4180 quoting, CRLF and BOM', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"'],
    ]);
    expect(() => parseCsv('a,"b\n')).toThrow(CsvError);
  });

  it('validates phones/emails, maps allowlisted variables, dedupes and reports ignored columns', () => {
    const csv = [
      'Phone,Name,Email,External ID,role_title,var_team,shoe_size',
      '+14155550101,Ann,ANN@example.com,crm-1,Engineer,Blue,9',
      '4155550102,Bad,,,,,',
      '+14155550103,Bob,not-an-email,,PM,,',
      '+1 415 555 0101,Dup,,,,,',
      '"+44 20 7946 0958","Smith, J",,,"Designer, Sr",,',
      ',,,,,,',
    ].join('\n');
    const r = parseTargetsCsv(csv, ['role_title', 'team']);
    expect(r.targets).toEqual([
      { phone: '+14155550101', name: 'Ann', email: 'ann@example.com', externalId: 'crm-1', variables: { role_title: 'Engineer', team: 'Blue' } },
      { phone: '+442079460958', name: 'Smith, J', email: null, externalId: null, variables: { role_title: 'Designer, Sr' } },
    ]);
    expect(r.errors.map((e) => e.row)).toEqual([3, 4]);
    expect(r.duplicates).toBe(1);
    expect(r.ignoredColumns).toEqual(['shoe_size']);
  });

  it('requires a phone column', () => {
    expect(() => parseTargetsCsv('name,email\nA,a@b.co', [])).toThrow(/phone/);
  });
});

describe('telephony audio', () => {
  it('μ-law round trip is close to the input', () => {
    for (const s of [0, 100, -100, 1000, -1000, 12345, -32768, 32767]) {
      const back = mulawToLinear(linearToMulaw(s));
      expect(Math.abs(back - s)).toBeLessThanOrEqual(Math.max(8, Math.abs(s) * 0.07));
    }
    const pcm = Int16Array.from({ length: 160 }, (_, i) => Math.round(8000 * Math.sin(i / 5)));
    const decoded = decodeMulaw(encodeMulaw(pcm));
    expect(decoded).toHaveLength(160);
  });

  it('resamples 24 kHz → 8 kHz and wraps WAV', () => {
    expect(resample(new Int16Array(2400), 24_000, 8000)).toHaveLength(800);
    const wav = pcmToWav(new Int16Array(8000), 8000);
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(8000);
    expect(wav.length).toBe(44 + 16000);
  });

  it('VAD detects an utterance after trailing silence and drops short noise', () => {
    const vad = new EnergyVad({ sampleRate: 8000, threshold: 700, startMs: 60, endSilenceMs: 400, maxUtteranceMs: 10_000, minUtteranceMs: 200 });
    const loud = Int16Array.from({ length: 160 }, (_, i) => Math.round(6000 * Math.sin(i / 3)));
    const quiet = new Int16Array(160);
    const events: string[] = [];
    for (let i = 0; i < 25; i++) events.push(...vad.push(loud).map((e) => e.type)); // 500 ms speech
    for (let i = 0; i < 25; i++) events.push(...vad.push(quiet).map((e) => e.type)); // 500 ms silence
    expect(events).toEqual(['speech_start', 'speech_end']);
    const noise: string[] = [];
    for (let i = 0; i < 4; i++) noise.push(...vad.push(loud).map((e) => e.type)); // 80 ms blip
    for (let i = 0; i < 25; i++) noise.push(...vad.push(quiet).map((e) => e.type));
    expect(noise).toEqual(['speech_start', 'discarded']);
  });
});

describe('PhoneBridge', () => {
  function setup(opts: { sttText?: string; ttsFails?: boolean } = {}) {
    const toTwilio: any[] = [];
    const received: ClientMessage[] = [];
    const usage: any[] = [];
    let closed: string | null = null;
    let hangup = 0;
    const bridge = new PhoneBridge(
      {
        sessionId: 's1',
        workspaceId: 'w1',
        language: 'en-US',
        voice: { voiceId: '', speed: 1 },
        allowBargeIn: true,
        endOfTurnSilenceMs: 500,
        transferEnabled: true,
        stt: { transcribe: async () => ({ text: opts.sttText ?? 'I led the migration.', confidence: 0.9, durationSec: 1.2, provider: 'deepgram', model: 'nova-3' }) },
        tts: {
          id: 'elevenlabs',
          synthesize: async (text: string) => {
            if (opts.ttsFails) throw new Error('boom');
            return { audio: Buffer.alloc(800, 0xff), mimeType: 'audio/basic', characters: text.length, provider: 'elevenlabs', model: 'x' };
          },
        },
      },
      {
        toTwilio: (m) => toTwilio.push(m),
        closeSocket: (r) => (closed = r),
        recordUsage: (...a) => usage.push(a),
        onTransferRequested: () => undefined,
        onCallerHangup: () => hangup++,
        log: () => undefined,
      },
    );
    bridge.bind({ receive: (m) => received.push(m), detach: () => undefined }, 'MZ1');
    return { bridge, toTwilio, received, usage, closed: () => closed, hangups: () => hangup };
  }
  const flush = () => new Promise((r) => setTimeout(r, 20));
  const loudFrame = () => encodeMulaw(Int16Array.from({ length: 160 }, (_, i) => Math.round(6000 * Math.sin(i / 3)))).toString('base64');
  const quietFrame = () => Buffer.alloc(160, 0xff).toString('base64');

  it('starts the engine, speaks agent text as μ-law media + mark, and reports playback completion', async () => {
    const t = setup();
    expect(t.received[0]).toEqual({ type: 'start' });
    t.bridge.transport.send({ type: 'agent.start', turnId: 'a1' });
    t.bridge.transport.send({ type: 'agent.delta', turnId: 'a1', text: 'Hello there. How are ' });
    t.bridge.transport.send({ type: 'agent.end', turnId: 'a1', text: 'Hello there. How are you?' });
    await flush();
    const media = t.toTwilio.filter((m) => m.event === 'media');
    expect(media).toHaveLength(10); // 2 segments × 800 bytes / 160-byte frames
    expect(media[0]).toEqual({ event: 'media', streamSid: 'MZ1', media: { payload: expect.any(String) } });
    const mark = t.toTwilio.find((m) => m.event === 'mark');
    expect(mark.mark.name).toBe('t:a1');
    expect(t.received).toContainEqual({ type: 'agent.playback', turnId: 'a1', event: 'started' });
    t.bridge.onTwilioMark('t:a1');
    expect(t.received).toContainEqual({ type: 'agent.playback', turnId: 'a1', event: 'completed' });
    expect(t.usage.filter((u) => u[0] === 'TTS_CHARACTERS')).toHaveLength(2);
  });

  it('barge-in: caller speech during playback sends clear and agent.playback interrupted', async () => {
    const t = setup();
    t.bridge.transport.send({ type: 'agent.start', turnId: 'a1' });
    t.bridge.transport.send({ type: 'agent.end', turnId: 'a1', text: 'A long answer that is being played.' });
    await flush();
    expect(t.bridge.isPlaying).toBe(true);
    for (let i = 0; i < 10; i++) t.bridge.onTwilioMedia(loudFrame());
    expect(t.toTwilio.some((m) => m.event === 'clear')).toBe(true);
    expect(t.received.find((m) => m.type === 'agent.playback' && m.event === 'interrupted')).toBeTruthy();
    expect(t.received).toContainEqual({ type: 'participant.speaking', speaking: true });
  });

  it('caller utterance → server STT → participant.final (and usage)', async () => {
    const t = setup({ sttText: 'I led the migration.' });
    for (let i = 0; i < 20; i++) t.bridge.onTwilioMedia(loudFrame());
    for (let i = 0; i < 30; i++) t.bridge.onTwilioMedia(quietFrame());
    await flush();
    const final = t.received.find((m) => m.type === 'participant.final') as any;
    expect(final).toMatchObject({ type: 'participant.final', text: 'I led the migration.', source: 'server_stt', clientTurnId: 'ph_s1_1' });
    expect(t.usage.find((u) => u[0] === 'STT_SECONDS')?.[3]).toBe(1.2);
  });

  it('TTS failure does not stall the engine (playback completed without a mark)', async () => {
    const t = setup({ ttsFails: true });
    t.bridge.transport.send({ type: 'agent.start', turnId: 'a1' });
    t.bridge.transport.send({ type: 'agent.end', turnId: 'a1', text: 'Hi.' });
    await flush();
    expect(t.toTwilio.filter((m) => m.event === 'media' || m.event === 'mark')).toHaveLength(0);
    expect(t.received).toContainEqual({ type: 'agent.playback', turnId: 'a1', event: 'completed' });
  });

  it('a failing TTS segment queued behind a slow one never causes an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const t = setup();
      let call = 0;
      (t.bridge as any).setup.tts.synthesize = async () => {
        call++;
        if (call === 1) {
          await new Promise((r) => setTimeout(r, 30));
          return { audio: Buffer.alloc(160, 0xff), mimeType: 'audio/basic', characters: 1, provider: 'elevenlabs', model: 'x' };
        }
        throw new Error('403');
      };
      t.bridge.transport.send({ type: 'agent.start', turnId: 'a1' });
      t.bridge.transport.send({ type: 'agent.end', turnId: 'a1', text: 'First sentence. Second sentence.' });
      await new Promise((r) => setTimeout(r, 80));
      expect(unhandled).toEqual([]);
      expect(t.toTwilio.filter((m) => m.event === 'media')).toHaveLength(1);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('agent end → closes the stream after playback; caller stop → hangup hook', async () => {
    const t = setup();
    t.bridge.transport.send({ type: 'end', reason: 'completed', endedBy: 'agent' });
    await flush();
    expect(t.closed()).toMatch(/ended/);
    const t2 = setup();
    await t2.bridge.onTwilioStop('caller_hung_up');
    expect(t2.hangups()).toBe(1);
  });

  it('splits sentences for low-latency TTS', () => {
    expect(splitSentences('One. Two! Three', false)).toEqual({ segments: ['One.', 'Two!'], rest: 'Three' });
    expect(splitSentences('Three', true)).toEqual({ segments: ['Three'], rest: '' });
  });
});

describe('Recall.ai helpers', () => {
  it('verifies Svix-signed webhooks (webhook-* and svix-* headers) with tolerance', () => {
    const secretBytes = Buffer.from('recall-test-secret-bytes-123456');
    const secret = `whsec_${secretBytes.toString('base64')}`;
    const body = '{"event":"bot.done"}';
    const ts = '1790000000';
    const sig = createHmac('sha256', secretBytes).update(`msg_1.${ts}.${body}`).digest('base64');
    expect(verifySvixSignature(secret, { 'webhook-id': 'msg_1', 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` }, body, 300, 1790000010)).toBe(true);
    expect(verifySvixSignature(secret, { 'svix-id': 'msg_1', 'svix-timestamp': ts, 'svix-signature': `v1,bad v1,${sig}` }, body, 300, 1790000010)).toBe(true);
    expect(verifySvixSignature(secret, { 'webhook-id': 'msg_1', 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` }, body + ' ', 300, 1790000010)).toBe(false);
    expect(verifySvixSignature(secret, { 'webhook-id': 'msg_1', 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` }, body, 300, 1790001000)).toBe(false);
    expect(verifySvixSignature(secret, {}, body)).toBe(false);
  });

  it('accepts only Zoom / Meet / Teams https links', () => {
    expect(meetingPlatform('https://us02web.zoom.us/j/1234567890?pwd=abc')).toBe('zoom');
    expect(meetingPlatform('https://meet.google.com/abc-defg-hij')).toBe('google_meet');
    expect(meetingPlatform('https://teams.microsoft.com/l/meetup-join/19%3ameeting')).toBe('microsoft_teams');
    expect(meetingPlatform('http://meet.google.com/abc-defg-hij')).toBeNull();
    expect(meetingPlatform('https://zoom.us.evil.com/j/1')).toBeNull();
    expect(meetingPlatform('https://example.com')).toBeNull();
  });

  it('maps statuses and parses transcript.data', () => {
    expect(mapRecallStatus('in_call_recording')).toBe('IN_CALL');
    expect(mapRecallStatus('done')).toBe('COMPLETED');
    expect(mapRecallStatus('fatal')).toBe('FAILED');
    expect(mapRecallStatus('something_new')).toBeNull();
    const u = utteranceFromTranscriptEvent({
      event: 'transcript.data',
      data: {
        data: {
          words: [
            { text: 'Hello', start_timestamp: { relative: 1.5 }, end_timestamp: { relative: 1.9 } },
            { text: 'team', start_timestamp: { relative: 2.0 }, end_timestamp: { relative: 2.4 } },
          ],
          participant: { id: 7, name: 'Dana', is_host: true },
        },
        bot: { id: 'bot_1', metadata: {} },
      },
    });
    expect(u).toEqual({ botId: 'bot_1', text: 'Hello team', speaker: { id: '7', name: 'Dana', isHost: true }, startMs: 1500, endMs: 2400 });
    expect(utteranceFromTranscriptEvent({ data: { data: { words: [] } } })).toBeNull();
  });

  it('meeting sessions follow legal state-machine paths', () => {
    expect(pathTo('READY', 'ACTIVE')).toEqual(['CONNECTING', 'ACTIVE']);
    expect(pathTo('ACTIVE', 'COMPLETED')).toEqual(['ENDING', 'COMPLETED']);
    expect(pathTo('COMPLETED', 'ACTIVE')).toBeNull();
  });
});
